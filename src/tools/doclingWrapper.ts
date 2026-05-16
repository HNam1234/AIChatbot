import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ParsedBlock, ToolRuntimeOptions } from "../types";
import { createTempDirectory, findNewestFile, resolveDoclingCommand } from "../utils/paths";
import { runProcess } from "../utils/process";
import { PyMuPDFWrapper } from "./pyMuPDFWrapper";

export interface DoclingConvertOptions extends ToolRuntimeOptions {
  pageBatchSize?: number;
  threads?: number;
  ocrLanguage?: string;
}

interface DoclingOutput {
  markdown: string;
  json?: unknown;
  tempDir: string;
  stdout: string;
}

interface DoclingSummary {
  textItems: number;
  tables: number;
  pictures: number;
  captions: number;
}

export class DoclingWrapper {
  public static async convertPages(
    pdfPath: string,
    pageNumbers: number[],
    options: DoclingConvertOptions = {}
  ): Promise<ParsedBlock[]> {
    if (pageNumbers.length === 0) {
      return [];
    }

    const batchSize = Math.max(1, options.pageBatchSize ?? 4);
    const batches = chunk(pageNumbers, batchSize);
    const blocks: ParsedBlock[] = [];

    for (const batch of batches) {
      blocks.push(...(await this.convertPageBatch(pdfPath, batch, options)));
    }

    return blocks.sort((a, b) => a.pageNumber - b.pageNumber || a.order - b.order);
  }

  private static async convertPageBatch(
    pdfPath: string,
    pageNumbers: number[],
    options: DoclingConvertOptions
  ): Promise<ParsedBlock[]> {
    const tempDir = await createTempDirectory("docling");
    const subsetPdfPath = path.join(tempDir, "subset.pdf");
    await PyMuPDFWrapper.extractPages(pdfPath, pageNumbers, subsetPdfPath, options);

    const output = await runDocling(subsetPdfPath, tempDir, options);
    const markdownChunks = splitMarkdownByPages(output.markdown, pageNumbers);
    const jsonSummary = summarizeDoclingJson(output.json);

    return markdownChunks.map((chunkText, index) => {
      const pageNumber = pageNumbers[Math.min(index, pageNumbers.length - 1)];
      const pageSpan =
        markdownChunks.length === 1 && pageNumbers.length > 1
          ? { start: pageNumbers[0], end: pageNumbers[pageNumbers.length - 1] }
          : { start: pageNumber, end: pageNumber };

      const block: ParsedBlock = {
        id: `docling-pages-${pageSpan.start}-${pageSpan.end}-${index}`,
        type: "page",
        source: "docling",
        pageNumber,
        order: pageNumber * 100000 + 50000 + index,
        markdown: chunkText,
        metadata: {
          parser: "docling",
          routeMode: "accurate",
          pageSpan,
          tempDir: output.tempDir,
          jsonSummary,
          stdoutPreview: output.stdout.slice(0, 2000)
        }
      };

      return block;
    });
  }
}

async function runDocling(
  inputPdfPath: string,
  tempDir: string,
  options: DoclingConvertOptions
): Promise<DoclingOutput> {
  const command = resolveDoclingCommand(options.doclingCommand);
  const currentArgs = [
    "--from",
    "pdf",
    "--to",
    "md",
    "--to",
    "json",
    "--output",
    tempDir,
    "--pipeline",
    "standard",
    "--ocr",
    "--tables",
    "--table-mode",
    "accurate",
    "--image-export-mode",
    "placeholder",
    "--num-threads",
    String(options.threads ?? 4),
    ...(options.ocrLanguage ? ["--ocr-lang", options.ocrLanguage] : []),
    "--device",
    "cpu",
    "--no-enable-remote-services",
    inputPdfPath
  ];

  try {
    const result = await runProcess(command, currentArgs, {
      timeoutMs: options.timeoutMs ?? 30 * 60 * 1000,
      maxBufferBytes: 256 * 1024 * 1024,
      check: true
    });
    return await collectDoclingOutput(tempDir, result.stdout);
  } catch (currentError) {
    try {
      return await runLegacyDocling(command, inputPdfPath, tempDir, options);
    } catch (legacyError) {
      const currentMessage = currentError instanceof Error ? currentError.message : String(currentError);
      const legacyMessage = legacyError instanceof Error ? legacyError.message : String(legacyError);
      throw new Error(`Docling conversion failed.\nCurrent CLI: ${currentMessage}\nLegacy CLI: ${legacyMessage}`);
    }
  }
}

async function runLegacyDocling(
  command: string,
  inputPdfPath: string,
  tempDir: string,
  options: ToolRuntimeOptions
): Promise<DoclingOutput> {
  const markdownOutputPath = path.join(tempDir, "docling.md");
  const jsonOutputPath = path.join(tempDir, "docling.json");
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;

  const markdownResult = await runProcess(
    command,
    [inputPdfPath, "--format", "markdown", "--output", markdownOutputPath],
    { timeoutMs, maxBufferBytes: 256 * 1024 * 1024, check: true }
  );

  await runProcess(command, [inputPdfPath, "--format", "json", "--output", jsonOutputPath], {
    timeoutMs,
    maxBufferBytes: 256 * 1024 * 1024,
    check: true
  });

  return await collectDoclingOutput(tempDir, markdownResult.stdout);
}

async function collectDoclingOutput(tempDir: string, stdout: string): Promise<DoclingOutput> {
  const markdownPath = await findNewestFile(tempDir, ".md");
  const jsonPath = await findNewestFile(tempDir, ".json");

  const markdown = markdownPath ? await readFile(markdownPath, "utf8") : stdout;
  const json = jsonPath ? JSON.parse(await readFile(jsonPath, "utf8")) : undefined;

  if (!markdown.trim()) {
    throw new Error(`Docling did not produce Markdown output in ${tempDir}.`);
  }

  return { markdown, json, tempDir, stdout };
}

function splitMarkdownByPages(markdown: string, pageNumbers: number[]): string[] {
  if (pageNumbers.length <= 1) {
    return [markdown.trim()];
  }

  const splitCandidates = [
    markdown.split(/\f+/g),
    markdown.split(/^<!--\s*PageBreak.*?-->\s*$/gim),
    markdown.split(/^---\s*end of page=\d+\s*---\s*$/gim)
  ]
    .map((parts) => parts.map((part) => part.trim()).filter(Boolean))
    .filter((parts) => parts.length === pageNumbers.length);

  return splitCandidates[0] ?? [markdown.trim()];
}

function summarizeDoclingJson(json: unknown): DoclingSummary {
  const summary: DoclingSummary = {
    textItems: 0,
    tables: 0,
    pictures: 0,
    captions: 0
  };

  visitJson(json, (value) => {
    if (!isRecord(value)) {
      return;
    }

    const label = normalizeLabel(value.label ?? value.type ?? value.name ?? value.self_ref);
    if (!label) {
      return;
    }

    if (label.includes("table")) {
      summary.tables += 1;
    } else if (label.includes("picture") || label.includes("image") || label.includes("figure")) {
      summary.pictures += 1;
    } else if (label.includes("caption")) {
      summary.captions += 1;
    } else if (label.includes("text") || label.includes("paragraph") || label.includes("heading")) {
      summary.textItems += 1;
    }
  });

  return summary;
}

function visitJson(value: unknown, visitor: (value: unknown) => void): void {
  visitor(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      visitJson(item, visitor);
    }
    return;
  }

  if (isRecord(value)) {
    for (const item of Object.values(value)) {
      visitJson(item, visitor);
    }
  }
}

function normalizeLabel(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_/-]+/g, " ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
