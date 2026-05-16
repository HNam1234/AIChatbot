import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ArtifactFilter } from "./orchestrator/artifactFilter";
import { HSCodeReconstructor } from "./orchestrator/hsCodeReconstructor";
import { LayoutAnalyzer } from "./orchestrator/layoutAnalyzer";
import { SmartRouter } from "./orchestrator/router";
import { SemanticFusion } from "./orchestrator/semanticFusion";
import type { LayoutAnalysis, ParsedBlock, PipelineOptions, PipelineResult, RoutingPlan } from "./types";
import {
  defaultBlocksPath,
  defaultOutputPath,
  defaultValidationReportPath,
  ensureDirectory
} from "./utils/paths";
import { MarkdownValidator } from "./validators/markdownValidator";

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

  const layout = await LayoutAnalyzer.analyze(resolvedPdfPath, options);
  const routed = await SmartRouter.run(resolvedPdfPath, layout, options);
  const filteredBlocks = ArtifactFilter.filter(routed.blocks, layout, {
    noiseTolerance: options.noiseTolerance
  });
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

  const { parsedBlocks, layout, routingPlan } = await runParsingPipeline(resolvedPdfPath, options);
  const markdown = HSCodeReconstructor.buildMarkdown(parsedBlocks, {
    sourcePath: resolvedPdfPath,
    ensureDocumentHeader: options.ensureDocumentHeader,
    includePageMarkers: options.includePageMarkers
  });
  const validation = MarkdownValidator.validatePhase1Detailed(markdown, parsedBlocks);

  if (!validation.passed) {
    console.error(`[MILESTONE 1 FAILED]\n${validation.errors.join("\n")}`);
    await saveErrorLog(resolvedPdfPath, markdown, parsedBlocks, validation);
    throw new Error(`Milestone 1 validation failed: ${validation.errors.join("; ")}`);
  }

  await writeJson(validationReportPath, validation);
  await writeJson(blocksPath, parsedBlocks);
  await writeText(outputPath, markdown);
  MarkdownValidator.validatePhase1(markdown, parsedBlocks);

  return {
    markdown,
    parsedBlocks,
    layout,
    routingPlan,
    validation,
    outputPath,
    blocksPath,
    validationReportPath
  };
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
  options: PipelineOptions;
}

function parseCliArgs(argv: string[]): CliArgs {
  const options: PipelineOptions = {};
  let pdfPath: string | undefined;

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
      case "--help":
      case "-h":
        return { options };
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

  return { pdfPath, options };
}

function printUsage(): void {
  console.log(`Usage:
  npm run parse -- <file.pdf> [options]

Options:
  -o, --out <path>              Markdown output path
  --blocks <path>               Parsed blocks JSON path
  --validation <path>           Validation report JSON path
  --python <path>               Python executable path
  --docling <path>              Docling executable path
  --timeout-ms <number>         Parser timeout per tool process
  --docling-batch-size <number> Number of accurate pages per Docling batch
  --docling-threads <number>    Docling CPU threads
  --ocr-lang <lang>             OCR language, for example eng or vie
  --allow-fallback              Use PyMuPDF when Docling fails
  --no-header                   Do not synthesize a document H1
  --page-markers                Include HTML page comments in Markdown
  --noise-tolerance <number>    Pixel tolerance for watermark/logo filtering`);
}

if (require.main === module) {
  void (async () => {
    try {
      const { pdfPath, options } = parseCliArgs(process.argv.slice(2));
      if (!pdfPath) {
        printUsage();
        process.exitCode = 1;
        return;
      }

      const result = await executePipeline(pdfPath, options);
      console.log(`Markdown: ${result.outputPath}`);
      console.log(`Blocks: ${result.blocksPath}`);
      console.log(`Validation: ${result.validationReportPath}`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  })();
}
