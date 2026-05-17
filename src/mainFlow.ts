import { readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { runAgenticQuery } from "./agent/hsCodeAgent";
import { askChatQuestion, startChatSession } from "./cli/repl";
import { resolvePageIndexSettings } from "./config/env";
import { resolveGeminiApiKeys } from "./config/gemini";
import { ArtifactFilter } from "./orchestrator/artifactFilter";
import { HSCodeReconstructor } from "./orchestrator/hsCodeReconstructor";
import { ImageAssetExporter } from "./orchestrator/imageAssetExporter";
import { LayoutAnalyzer } from "./orchestrator/layoutAnalyzer";
import { SmartRouter } from "./orchestrator/router";
import { SectionMapBuilder } from "./orchestrator/sectionMapBuilder";
import { SemanticFusion } from "./orchestrator/semanticFusion";
import { TreeBuilder } from "./orchestrator/treeBuilder";
import type { LayoutAnalysis, ParsedBlock, PipelineOptions, PipelineResult, RoutingPlan } from "./types";
import {
  defaultBlocksPath,
  defaultOutputPath,
  defaultSectionMapPath,
  defaultTreePath,
  defaultTreeValidationReportPath,
  defaultValidationReportPath,
  ensureDirectory
} from "./utils/paths";
import { MarkdownValidator } from "./validators/markdownValidator";
import { TreeValidator } from "./validators/treeValidator";

export interface ParsingPipelineResult {
  parsedBlocks: ParsedBlock[];
  layout: LayoutAnalysis;
  routingPlan: RoutingPlan;
}

export async function runParsingPipeline(
  pdfPath: string,
  options: PipelineOptions = {}
): Promise<ParsingPipelineResult> {
  const resolvedPdfPath = path.resolve(pdfPath);
  await assertReadableFile(resolvedPdfPath);

  logStep(options, "layout analysis started");
  const layout = await LayoutAnalyzer.analyze(resolvedPdfPath, options);
  logStep(options, "layout/docling routing started");
  const routed = await SmartRouter.run(resolvedPdfPath, layout, options);
  logStep(options, "artifact filtering started");
  const filteredBlocks = ArtifactFilter.filter(routed.blocks, layout, {
    noiseTolerance: options.noiseTolerance
  });
  logStep(options, "semantic fusion started");
  const parsedBlocks = SemanticFusion.fuse(filteredBlocks);

  return {
    parsedBlocks,
    layout,
    routingPlan: routed.plan
  };
}

export async function executePipeline(pdfPath: string, options: PipelineOptions = {}): Promise<PipelineResult> {
  const resolvedPdfPath = path.resolve(pdfPath);
  const outputPath = options.outputPath ? path.resolve(options.outputPath) : defaultOutputPath(resolvedPdfPath);
  const blocksPath = options.blocksPath ? path.resolve(options.blocksPath) : defaultBlocksPath(resolvedPdfPath);
  const validationReportPath = options.validationReportPath
    ? path.resolve(options.validationReportPath)
    : defaultValidationReportPath(resolvedPdfPath);
  const sectionMapPath = options.sectionMapPath
    ? path.resolve(options.sectionMapPath)
    : defaultSectionMapPath(resolvedPdfPath);
  const treeOutputPath = options.treeOutputPath
    ? path.resolve(options.treeOutputPath)
    : defaultTreePath(resolvedPdfPath);
  const treeValidationReportPath = options.treeValidationReportPath
    ? path.resolve(options.treeValidationReportPath)
    : defaultTreeValidationReportPath(resolvedPdfPath);

  logStep(options, "parse started");
  const pipelineResult = await runParsingPipeline(resolvedPdfPath, options);
  let parsedBlocks = pipelineResult.parsedBlocks;
  const { layout, routingPlan } = pipelineResult;
  let assetsDirPath: string | undefined;

  if (options.exportAssets) {
    const assetsDir = options.assetsDir
      ? path.resolve(options.assetsDir)
      : path.resolve(path.dirname(outputPath), "assets");
    assetsDirPath = path.resolve(assetsDir, path.basename(resolvedPdfPath, path.extname(resolvedPdfPath)));
    logStep(options, "export assets started");
    parsedBlocks = await ImageAssetExporter.exportAssets(resolvedPdfPath, parsedBlocks, {
      assetsDir,
      markdownDir: path.dirname(outputPath),
      pythonCommand: options.pythonCommand,
      timeoutMs: options.timeoutMs
    });
  }

  const markdown = HSCodeReconstructor.buildMarkdown(parsedBlocks, {
    sourcePath: resolvedPdfPath,
    ensureDocumentHeader: options.ensureDocumentHeader,
    includePageMarkers: options.includePageMarkers
  });
  logStep(options, "validation started");
  const validation = MarkdownValidator.validatePhase1Detailed(markdown, parsedBlocks);

  if (!validation.passed) {
    console.error(`[MILESTONE 1 FAILED]\n${validation.errors.join("\n")}`);
    await saveErrorLog(resolvedPdfPath, markdown, parsedBlocks, validation);
    throw new Error(`Milestone 1 validation failed: ${validation.errors.join("; ")}`);
  }

  await writeJson(validationReportPath, validation);
  await writeJson(blocksPath, parsedBlocks);
  await writeText(outputPath, markdown);
  logStep(options, "section map started");
  const sectionMap = SectionMapBuilder.build(markdown, parsedBlocks, resolvedPdfPath);
  await writeJson(sectionMapPath, sectionMap);
  logStep(options, "section map done");
  MarkdownValidator.validatePhase1(markdown, parsedBlocks);

  let treeValidation: PipelineResult["treeValidation"];
  let pageIndexDocId: string | undefined;
  if (options.uploadPageIndex) {
    let treeBuild = options.forcePageIndexUpload ? undefined : await TreeBuilder.loadCached(outputPath, treeOutputPath);

    if (treeBuild) {
      logStep(options, "pageindex cache hit");
      logStep(options, "pageindex upload skipped (cached tree)");
      logStep(options, "pageindex polling skipped (cached tree)");
    } else {
      if (options.forcePageIndexUpload) {
        logStep(options, "pageindex cache bypassed");
      } else {
        logStep(options, "pageindex cache miss");
      }

      const pageIndexSettings = resolvePageIndexSettings({
        apiKey: options.pageIndexApiKey,
        baseUrl: options.pageIndexBaseUrl,
        pollIntervalMs: options.pageIndexPollIntervalMs,
        pollMaxAttempts: options.pageIndexPollMaxAttempts
      });

      logStep(options, "pageindex upload started");
      logStep(options, "pageindex polling started");
      treeBuild = await TreeBuilder.buildAndWait(outputPath, {
        apiKey: pageIndexSettings.pageIndexApiKey,
        outputPath: treeOutputPath,
        baseUrl: pageIndexSettings.pageIndexBaseUrl,
        pollIntervalMs: pageIndexSettings.pageIndexPollIntervalMs,
        pollMaxAttempts: pageIndexSettings.pageIndexPollMaxAttempts,
        timeoutMs: options.pageIndexTimeoutMs
      });
    }
    pageIndexDocId = treeBuild.docId;
    logStep(options, "tree validation started");
    treeValidation = TreeValidator.validate(markdown, treeBuild.treeData, {
      docId: treeBuild.docId,
      sectionMap
    });
    if (treeBuild.fromCache) {
      treeValidation.warnings = [
        ...(treeValidation.warnings ?? []),
        `Reused cached PageIndex tree: ${treeOutputPath}`,
        ...(treeBuild.cacheWarnings ?? [])
      ];
      treeValidation.markers[0] = {
        ...treeValidation.markers[0],
        details: {
          ...(treeValidation.markers[0]?.details ?? {}),
          pageIndexCacheHit: true,
          pageIndexCachePath: treeOutputPath,
          pageIndexCacheWarnings: treeBuild.cacheWarnings ?? []
        }
      };
    }
    await writeJson(treeValidationReportPath, treeValidation);
    logStep(options, "tree validation done");
    if (!treeValidation.passed) {
      console.error(`[MILESTONE 2 FAILED]\n${treeValidation.errors.join("\n")}`);
      throw new Error(`Milestone 2 validation failed: ${treeValidation.errors.join("; ")}`);
    }

    console.log(treeValidation.markers[0]?.message ?? "[Marker 10 Passed] Tree Generated Successfully.");
  } else {
    logStep(options, "pageindex upload skipped");
    logStep(options, "pageindex polling skipped");
  }

  return {
    markdown,
    parsedBlocks,
    layout,
    routingPlan,
    validation,
    sectionMap,
    treeValidation,
    outputPath,
    blocksPath,
    validationReportPath,
    assetsDirPath,
    sectionMapPath,
    treeOutputPath: options.uploadPageIndex ? treeOutputPath : undefined,
    treeValidationReportPath: options.uploadPageIndex ? treeValidationReportPath : undefined,
    pageIndexDocId
  };
}

function logStep(options: PipelineOptions, message: string): void {
  const line = `mainFlow.logStep: ${message}`;
  options.onLog?.(line);
  if (!options.onLog) {
    console.log(`[Pipeline] ${line}`);
  }
}

async function saveErrorLog(
  pdfPath: string,
  markdown: string,
  parsedBlocks: ParsedBlock[],
  validation: PipelineResult["validation"]
): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const baseName = path.basename(pdfPath, path.extname(pdfPath));
  const errorBasePath = path.resolve(process.cwd(), "data", "tmp", `${baseName}.milestone1-failed.${timestamp}`);

  await writeText(`${errorBasePath}.md`, markdown);
  await writeJson(`${errorBasePath}.blocks.json`, parsedBlocks);
  await writeJson(`${errorBasePath}.validation.json`, validation);
}

async function writeText(filePath: string, content: string): Promise<void> {
  await ensureDirectory(path.dirname(filePath));
  await writeFile(filePath, content, "utf8");
}

async function writeJson(filePath: string, content: unknown): Promise<void> {
  await writeText(filePath, `${JSON.stringify(content, null, 2)}\n`);
}

async function assertReadableFile(filePath: string): Promise<void> {
  const fileStat = await stat(filePath).catch(() => undefined);
  if (!fileStat?.isFile()) {
    throw new Error(`PDF file not found: ${filePath}`);
  }
}

interface CliArgs {
  pdfPath?: string;
  batch: boolean;
  help: boolean;
  options: PipelineOptions;
}

function parseCliArgs(argv: string[]): CliArgs {
  const options: PipelineOptions = {};
  let pdfPath: string | undefined;
  let batch = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) {
        throw new Error(`Missing value for ${arg}`);
      }
      return argv[index];
    };

    switch (arg) {
      case "--out":
      case "-o":
        options.outputPath = next();
        break;
      case "--blocks":
        options.blocksPath = next();
        break;
      case "--validation":
        options.validationReportPath = next();
        break;
      case "--sections":
        options.sectionMapPath = next();
        break;
      case "--tree":
        options.treeOutputPath = next();
        break;
      case "--tree-validation":
        options.treeValidationReportPath = next();
        break;
      case "--python":
        options.pythonCommand = next();
        break;
      case "--docling":
        options.doclingCommand = next();
        break;
      case "--timeout-ms":
        options.timeoutMs = Number(next());
        break;
      case "--docling-batch-size":
        options.doclingPageBatchSize = Number(next());
        break;
      case "--docling-threads":
        options.doclingThreads = Number(next());
        break;
      case "--ocr-lang":
        options.ocrLanguage = next();
        break;
      case "--allow-fallback":
        options.allowPyMuPDFFallback = true;
        break;
      case "--no-header":
        options.ensureDocumentHeader = false;
        break;
      case "--page-markers":
        options.includePageMarkers = true;
        break;
      case "--noise-tolerance":
        options.noiseTolerance = Number(next());
        break;
      case "--export-assets":
        options.exportAssets = true;
        break;
      case "--assets-dir":
        options.assetsDir = next();
        break;
      case "--upload-pageindex":
        options.uploadPageIndex = true;
        break;
      case "--force-pageindex-upload":
        options.forcePageIndexUpload = true;
        break;
      case "--batch":
        batch = true;
        break;
      case "--pageindex-api-key":
        options.pageIndexApiKey = next();
        break;
      case "--pageindex-base-url":
        options.pageIndexBaseUrl = next();
        break;
      case "--pageindex-poll-interval-ms":
      case "--pageindex-poll-ms":
        options.pageIndexPollIntervalMs = Number(next());
        break;
      case "--pageindex-poll-max-attempts":
        options.pageIndexPollMaxAttempts = Number(next());
        break;
      case "--pageindex-timeout-ms":
        options.pageIndexTimeoutMs = Number(next());
        break;
      case "--help":
      case "-h":
        help = true;
        return { batch, help, options };
      default:
        if (arg.startsWith("-")) {
          throw new Error(`Unknown option: ${arg}`);
        }
        if (pdfPath) {
          throw new Error(`Unexpected extra argument: ${arg}`);
        }
        pdfPath = arg;
    }
  }

  return { pdfPath, batch, help, options };
}

function printUsage(): void {
  console.log(`Usage:
  npm run parse -- <file.pdf> [options]
  npm run parse -- <directory> --batch [options]

Options:
  -o, --out <path>              Markdown output path
  --blocks <path>               Parsed blocks JSON path
  --validation <path>           Validation report JSON path
  --sections <path>             Section map JSON path
  --tree <path>                 PageIndex tree JSON output path
  --tree-validation <path>      PageIndex tree validation JSON output path
  --python <path>               Python executable path
  --docling <path>              Docling executable path
  --timeout-ms <number>         Parser timeout per tool process
  --docling-batch-size <number> Number of accurate pages per Docling batch
  --docling-threads <number>    Docling CPU threads
  --ocr-lang <lang>             OCR language, for example eng or vie
  --allow-fallback              Use PyMuPDF when Docling fails
  --no-header                   Do not synthesize a document H1
  --page-markers                Include HTML page comments in Markdown
  --noise-tolerance <number>    Pixel tolerance for watermark/logo filtering
  --export-assets               Export non-decorative image crops and link them in Markdown
  --assets-dir <path>           Asset output directory, default data/converted/assets
  --batch                       Process every PDF in the input directory sequentially
  --upload-pageindex            Upload Markdown to PageIndex and write <file>.tree.json
  --force-pageindex-upload      Ignore existing <file>.tree.json cache and upload again
  --pageindex-api-key <key>     PageIndex API key, defaults to PAGEINDEX_API_KEY or .env
  --pageindex-base-url <url>    PageIndex API base URL
  --pageindex-poll-interval-ms <number> Poll interval for async PageIndex responses
  --pageindex-poll-max-attempts <num>   Max polling attempts for PageIndex
  --pageindex-timeout-ms <num>          Backward-compatible timeout for async PageIndex responses`);
}

if (require.main === module) {
  void (async () => {
    try {
      const argv = process.argv.slice(2);
      const mode = readMode(argv);

      if (mode === "chat") {
        await executeChatCli(argv);
        return;
      }

      if (mode === "agent") {
        await executeAgentCli(argv);
        return;
      }

      const { pdfPath, batch, help, options } = parseCliArgs(argv);
      if (help) {
        printUsage();
        return;
      }
      if (!pdfPath) {
        printUsage();
        process.exitCode = 1;
        return;
      }

      if (batch) {
        const result = await executeBatchPipeline(pdfPath, options);
        printBatchSummary(result);
        if (result.documents.some((document) => document.status === "failed")) {
          process.exitCode = 1;
        }
        return;
      }

      const result = await executePipeline(pdfPath, options);
      printPipelineSummary(pdfPath, result);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  })();
}

type CliMode = "chat" | "agent";

interface ChatModeArgs {
  help: boolean;
  docId?: string | string[];
  question?: string;
  pageIndexApiKey?: string;
  pageIndexBaseUrl?: string;
  temperature?: number;
  enableCitations: boolean;
}

interface AgentModeArgs {
  help: boolean;
  docId?: string;
  docName?: string;
  query?: string;
  pages?: string;
  folderId?: string;
  pageIndexApiKey?: string;
  pageIndexMcpUrl?: string;
  mcpToolName?: string;
  geminiApiKeys: string[];
  geminiModel?: string;
  maxContextChars?: number;
  maxAnswerWords?: number;
}

function readMode(argv: string[]): CliMode | undefined {
  const modeIndex = argv.indexOf("--mode");
  if (modeIndex >= 0) {
    const mode = argv[modeIndex + 1];
    if (mode === "chat" || mode === "agent") {
      return mode;
    }
  }

  const first = argv[0];
  if (first === "chat" || first === "agent") {
    return first;
  }

  return undefined;
}

async function executeChatCli(argv: string[]): Promise<void> {
  const args = parseChatModeArgs(argv);
  if (args.help) {
    printChatUsage();
    return;
  }

  const pageIndexSettings = resolvePageIndexSettings({
    apiKey: args.pageIndexApiKey,
    baseUrl: args.pageIndexBaseUrl
  });
  const options = {
    apiKey: pageIndexSettings.pageIndexApiKey,
    baseUrl: pageIndexSettings.pageIndexBaseUrl,
    docId: args.docId,
    temperature: args.temperature,
    enableCitations: args.enableCitations
  };

  if (args.question) {
    await askChatQuestion(args.question, options);
    return;
  }

  await startChatSession(options);
}

async function executeAgentCli(argv: string[]): Promise<void> {
  const args = parseAgentModeArgs(argv);
  if (args.help) {
    printAgentUsage();
    return;
  }

  if (!args.query) {
    printAgentUsage();
    throw new Error("--query is required for --mode agent.");
  }

  const pageIndexSettings = resolvePageIndexSettings({
    apiKey: args.pageIndexApiKey
  });
  const geminiApiKeys = resolveGeminiApiKeys(args.geminiApiKeys);
  const result = await runAgenticQuery({
    pageIndexApiKey: pageIndexSettings.pageIndexApiKey,
    pageIndexMcpUrl: args.pageIndexMcpUrl,
    docId: args.docId,
    docName: args.docName,
    query: args.query,
    pages: args.pages,
    folderId: args.folderId,
    mcpToolName: args.mcpToolName,
    geminiApiKeys,
    geminiModel: args.geminiModel,
    maxContextChars: args.maxContextChars,
    maxAnswerWords: args.maxAnswerWords
  });

  console.log("[Agent Retrieval]");
  console.log(`Tool: ${result.retrieval.toolName}`);
  console.log(`Context: ${result.context.length}/${result.retrieval.originalLength} chars`);
  console.log(`Truncated: ${result.retrieval.truncated ? "yes" : "no"}`);
  for (const marker of result.markers) {
    console.log(marker.message);
  }
  console.log("\n[Agent Answer]");
  console.log(result.answer);
}

function parseChatModeArgs(argv: string[]): ChatModeArgs {
  const args: ChatModeArgs = {
    help: false,
    enableCitations: true
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) {
        throw new Error(`Missing value for ${arg}`);
      }
      return argv[index];
    };

    switch (arg) {
      case "chat":
      case "--mode":
        if (arg === "--mode") {
          next();
        }
        break;
      case "--doc-id":
        args.docId = splitList(next());
        break;
      case "--query":
      case "--question":
        args.question = next();
        break;
      case "--pageindex-api-key":
        args.pageIndexApiKey = next();
        break;
      case "--pageindex-base-url":
        args.pageIndexBaseUrl = next();
        break;
      case "--temperature":
        args.temperature = readNumericOption(arg, next());
        break;
      case "--no-citations":
        args.enableCitations = false;
        break;
      case "--help":
      case "-h":
        args.help = true;
        return args;
      default:
        if (arg.startsWith("-")) {
          throw new Error(`Unknown chat option: ${arg}`);
        }
        args.question = arg;
        break;
    }
  }

  return args;
}

function parseAgentModeArgs(argv: string[]): AgentModeArgs {
  const args: AgentModeArgs = {
    help: false,
    geminiApiKeys: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) {
        throw new Error(`Missing value for ${arg}`);
      }
      return argv[index];
    };

    switch (arg) {
      case "agent":
      case "--mode":
        if (arg === "--mode") {
          next();
        }
        break;
      case "--doc-id":
        args.docId = next();
        break;
      case "--doc-name":
        args.docName = next();
        break;
      case "--query":
      case "--question":
        args.query = next();
        break;
      case "--pages":
        args.pages = next();
        break;
      case "--folder-id":
        args.folderId = next();
        break;
      case "--pageindex-api-key":
        args.pageIndexApiKey = next();
        break;
      case "--pageindex-mcp-url":
      case "--mcp-url":
        args.pageIndexMcpUrl = next();
        break;
      case "--mcp-tool":
        args.mcpToolName = next();
        break;
      case "--gemini-api-key":
        args.geminiApiKeys.push(next());
        break;
      case "--gemini-model":
        args.geminiModel = next();
        break;
      case "--max-context-chars":
        args.maxContextChars = readNumericOption(arg, next());
        break;
      case "--max-answer-words":
        args.maxAnswerWords = readNumericOption(arg, next());
        break;
      case "--help":
      case "-h":
        args.help = true;
        return args;
      default:
        if (arg.startsWith("-")) {
          throw new Error(`Unknown agent option: ${arg}`);
        }
        args.query = arg;
        break;
    }
  }

  args.pageIndexMcpUrl = args.pageIndexMcpUrl ?? process.env.PAGEINDEX_MCP_URL;

  return args;
}

function printChatUsage(): void {
  console.log(`Usage:
  npm run chat -- --doc-id <doc_id> --query "question"
  npm run chat -- --doc-id <doc_id>

Options:
  --doc-id <id[,id]>            Optional PageIndex document scope
  --query, --question <text>    Ask one question and exit
  --pageindex-api-key <key>     PageIndex API key, defaults to PAGEINDEX_API_KEY or .env
  --pageindex-base-url <url>    PageIndex API base URL
  --temperature <number>        Chat API temperature, default 0.1
  --no-citations                Disable citation requirement and request flag`);
}

function printAgentUsage(): void {
  console.log(`Usage:
  npm run agent -- --doc-name <name> --query "question"
  npm run agent -- --doc-id <id> --query "question"

Options:
  --doc-name <name>             PageIndex document name for MCP tools that require docName
  --doc-id <id>                 PageIndex document id or fallback document reference
  --query, --question <text>    User question
  --pages <spec>                Optional page spec for page-content tools
  --folder-id <id>              Optional PageIndex folder scope
  --pageindex-api-key <key>     PageIndex API key, defaults to PAGEINDEX_API_KEY or .env
  --mcp-url <url>               MCP endpoint, default PAGEINDEX_MCP_URL or PageIndex cloud MCP
  --mcp-tool <name>             Force a specific MCP tool name
  --gemini-api-key <key>        Gemini key override; can be repeated
  --gemini-model <name>         Gemini model, default gemini-2.5-flash
  --max-context-chars <number>  Marker 12 context budget, default 1500
  --max-answer-words <number>   Marker 13 answer budget, default 120`);
}

function splitList(value: string): string | string[] {
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  return parts.length <= 1 ? parts[0] ?? value : parts;
}

function readNumericOption(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number.`);
  }

  return parsed;
}

interface BatchDocumentSummary {
  document: string;
  status: "passed" | "failed";
  hsSectionCount: number;
  imageCount: number;
  hasTree: boolean;
  error: string | null;
}

interface BatchPipelineResult {
  documents: BatchDocumentSummary[];
  manifestPath: string;
  allSectionsPath: string;
  allDocumentsPath: string;
}

async function executeBatchPipeline(inputDir: string, options: PipelineOptions): Promise<BatchPipelineResult> {
  const resolvedDir = path.resolve(inputDir);
  const dirStat = await stat(resolvedDir).catch(() => undefined);
  if (!dirStat?.isDirectory()) {
    throw new Error(`Batch input must be a directory: ${resolvedDir}`);
  }

  const entries = await readdir(resolvedDir, { withFileTypes: true });
  const pdfFiles = entries
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === ".pdf")
    .map((entry) => path.join(resolvedDir, entry.name))
    .sort((left, right) => path.basename(left).localeCompare(path.basename(right)));

  if (pdfFiles.length === 0) {
    throw new Error(`No PDF files found in ${resolvedDir}`);
  }

  const manifestDocuments: unknown[] = [];
  const documents: BatchDocumentSummary[] = [];
  const allSections: unknown[] = [];

  for (const pdfFile of pdfFiles) {
    try {
      const result = await executePipeline(pdfFile, options);
      const sections = result.sectionMap?.sections ?? [];
      allSections.push(...sections);
      const imageCount = await countPngAssets(result.assetsDirPath);
      const summary = {
        document: path.basename(pdfFile),
        status: "passed" as const,
        hsSectionCount: sections.length,
        imageCount,
        hasTree: Boolean(result.treeOutputPath),
        error: null
      };
      documents.push(summary);
      manifestDocuments.push(buildManifestRecord(pdfFile, options.uploadPageIndex, "passed", null, result.assetsDirPath));
      printPipelineSummary(pdfFile, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      documents.push({
        document: path.basename(pdfFile),
        status: "failed",
        hsSectionCount: 0,
        imageCount: 0,
        hasTree: false,
        error: message
      });
      manifestDocuments.push(buildManifestRecord(pdfFile, options.uploadPageIndex, "failed", message));
      console.error(`[Batch] ${path.basename(pdfFile)} failed: ${message}`);
    }
  }

  const convertedDir = path.resolve(process.cwd(), "data", "converted");
  const manifestPath = path.join(convertedDir, "batch.manifest.json");
  const allSectionsPath = path.join(convertedDir, "all.sections.json");
  const allDocumentsPath = path.join(convertedDir, "all.documents.json");
  await writeJson(manifestPath, { generatedAt: new Date().toISOString(), documents: manifestDocuments });
  await writeJson(allSectionsPath, allSections);
  await writeJson(allDocumentsPath, documents);

  return {
    documents,
    manifestPath,
    allSectionsPath,
    allDocumentsPath
  };
}

function buildManifestRecord(
  pdfFile: string,
  uploadPageIndex: boolean | undefined,
  status: "passed" | "failed",
  error: string | null,
  assetsDirPath?: string
): Record<string, unknown> {
  return {
    input: relativePath(pdfFile),
    status,
    markdown: relativePath(defaultOutputPath(pdfFile)),
    blocks: relativePath(defaultBlocksPath(pdfFile)),
    validation: relativePath(defaultValidationReportPath(pdfFile)),
    assetsDir: assetsDirPath ? relativePath(assetsDirPath) : relativePath(path.resolve(process.cwd(), "data", "converted", "assets", path.basename(pdfFile, path.extname(pdfFile)))),
    sections: relativePath(defaultSectionMapPath(pdfFile)),
    tree: uploadPageIndex ? relativePath(defaultTreePath(pdfFile)) : undefined,
    treeValidation: uploadPageIndex ? relativePath(defaultTreeValidationReportPath(pdfFile)) : undefined,
    error
  };
}

async function countPngAssets(assetDirPath: string | undefined): Promise<number> {
  if (!assetDirPath) {
    return 0;
  }
  const dirStat = await stat(assetDirPath).catch(() => undefined);
  if (!dirStat?.isDirectory()) {
    return 0;
  }
  const entries = await readdir(assetDirPath, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".png")).length;
}

function printBatchSummary(result: BatchPipelineResult): void {
  const passed = result.documents.filter((document) => document.status === "passed").length;
  console.log("[Batch Summary]");
  console.log(`Documents: ${passed}/${result.documents.length} passed`);
  console.log(`Manifest: ${relativePath(result.manifestPath)}`);
  console.log(`All sections: ${relativePath(result.allSectionsPath)}`);
  console.log(`All documents: ${relativePath(result.allDocumentsPath)}`);
}

function printPipelineSummary(inputPath: string, result: PipelineResult): void {
  const allMarkers = [...result.validation.markers, ...(result.treeValidation?.markers ?? [])];
  const passedMarkers = allMarkers.filter((marker) => marker.passed).length;

  console.log("[Pipeline Summary]");
  console.log(`Input: ${relativePath(inputPath)}`);
  console.log(`Markdown: ${relativePath(result.outputPath)}`);
  console.log(`Blocks: ${relativePath(result.blocksPath)}`);
  console.log(`Validation: ${relativePath(result.validationReportPath)}`);
  console.log(`Assets: ${result.assetsDirPath ? relativePath(result.assetsDirPath) : "skipped"}`);
  console.log(`Section map: ${relativePath(result.sectionMapPath)}`);
  console.log(`PageIndex tree: ${result.treeOutputPath ? relativePath(result.treeOutputPath) : "skipped"}`);
  console.log(
    `Tree validation: ${result.treeValidationReportPath ? relativePath(result.treeValidationReportPath) : "skipped"}`
  );
  console.log(`Markers: ${passedMarkers}/${allMarkers.length} passed`);
}

function relativePath(filePath: string | undefined): string {
  if (!filePath) {
    return "skipped";
  }

  return path.relative(process.cwd(), path.resolve(filePath)).replace(/\\/g, "/");
}
