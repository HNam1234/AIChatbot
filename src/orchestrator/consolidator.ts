import path from "node:path";
import type { ParsedBlock } from "../types";

export interface ConsolidatorOptions {
  sourcePath?: string;
  ensureDocumentHeader?: boolean;
  includePageMarkers?: boolean;
}

export class Consolidator {
  public static merge(blocks: ParsedBlock[], options: ConsolidatorOptions = {}): string {
    const contentBlocks = blocks
      .filter((block) => block.metadata?.includeInMarkdown !== false)
      .sort((a, b) => a.pageNumber - b.pageNumber || a.order - b.order || a.id.localeCompare(b.id));

    const parts: string[] = [];
    let currentPage: number | undefined;

    for (const block of contentBlocks) {
      if (options.includePageMarkers && block.pageNumber !== currentPage) {
        parts.push(`<!-- page:${block.pageNumber} -->`);
        currentPage = block.pageNumber;
      }

      const markdown = blockToMarkdown(block);
      if (markdown) {
        parts.push(markdown);
      }
    }

    let markdownText = normalizeMarkdown(parts.join("\n\n"));

    if ((options.ensureDocumentHeader ?? true) && !hasMarkdownHeader(markdownText)) {
      markdownText = `# ${documentTitle(options.sourcePath)}\n\n${markdownText}`.trim();
    }

    return `${normalizeMarkdownTables(markdownText).trim()}\n`;
  }
}

function blockToMarkdown(block: ParsedBlock): string | undefined {
  if (block.markdown?.trim()) {
    return block.markdown.trim();
  }

  if (block.html?.trim()) {
    return block.html.trim();
  }

  if (block.text?.trim() && ["text", "caption", "table", "page"].includes(block.type)) {
    return block.text.trim();
  }

  return undefined;
}

function documentTitle(sourcePath?: string): string {
  if (!sourcePath) {
    return "Parsed Document";
  }

  return path.basename(sourcePath, path.extname(sourcePath)).replace(/[_-]+/g, " ").trim() || "Parsed Document";
}

function hasMarkdownHeader(markdownText: string): boolean {
  return /^(#{1,6})\s+\S.+$/m.test(markdownText);
}

function normalizeMarkdown(markdownText: string): string {
  return markdownText
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function normalizeMarkdownTables(markdownText: string): string {
  const lines = markdownText.replace(/\r\n/g, "\n").split("\n");
  const output: string[] = [];
  let tableBuffer: string[] = [];
  let inCodeFence = false;

  const flushTable = () => {
    if (tableBuffer.length > 0) {
      output.push(...normalizeTableBuffer(tableBuffer));
      tableBuffer = [];
    }
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      flushTable();
      inCodeFence = !inCodeFence;
      output.push(line);
      continue;
    }

    if (!inCodeFence && isTableRow(line)) {
      tableBuffer.push(line);
      continue;
    }

    flushTable();
    output.push(line);
  }

  flushTable();
  return output.join("\n");
}

function normalizeTableBuffer(lines: string[]): string[] {
  if (lines.length < 2) {
    return lines;
  }

  const rows = lines.map(parseTableRow);
  const separatorIndex = rows.findIndex(isSeparatorCells);
  if (separatorIndex === -1) {
    return lines;
  }

  const columnCount = Math.max(...rows.map((row) => row.length));
  return rows.map((row, index) => {
    const cells = padCells(row, columnCount);
    if (index === separatorIndex) {
      return `| ${cells.map((cell) => normalizeSeparatorCell(cell)).join(" | ")} |`;
    }

    return `| ${cells.map((cell) => cell.trim()).join(" | ")} |`;
  });
}

function isTableRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line);
}

function parseTableRow(line: string): string[] {
  const trimmed = line.trim();
  const withoutEdges = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  return withoutEdges.split("|").map((cell) => cell.trim());
}

function isSeparatorCells(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()) || cell.includes("---"));
}

function normalizeSeparatorCell(cell: string): string {
  const trimmed = cell.trim();
  const left = trimmed.startsWith(":") ? ":" : "";
  const right = trimmed.endsWith(":") ? ":" : "";
  return `${left}---${right}`;
}

function padCells(cells: string[], columnCount: number): string[] {
  const padded = [...cells];
  while (padded.length < columnCount) {
    padded.push("");
  }
  return padded.slice(0, columnCount);
}
