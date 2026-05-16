import path from "node:path";
import type { ParsedBlock } from "../types";
import { normalizeMarkdownTables } from "./consolidator";

export interface HSCodeReconstructorOptions {
  sourcePath?: string;
  ensureDocumentHeader?: boolean;
  includePageMarkers?: boolean;
}

interface RenderState {
  parts: string[];
  consumedTextBlockIds: Set<string>;
  consumedTextLineCounts: Map<string, number>;
  tableBlocks: ParsedBlock[];
  currentPage?: number;
}

interface TextLineRef {
  block: ParsedBlock;
  lineIndex: number;
  text: string;
  y0: number;
  y1: number;
  x0: number;
  x1: number;
}

interface TitleSelection {
  title: string;
  selectedLines: TextLineRef[];
}

const HS_CODE_REGEX = /^(\d{4}\.\d{2}\.\d{2})\b\s*(.*)$/;

export class HSCodeReconstructor {
  public static buildMarkdown(
    blocks: ParsedBlock[],
    options: HSCodeReconstructorOptions = {}
  ): string {
    const state: RenderState = {
      parts: [],
      consumedTextBlockIds: new Set<string>(),
      consumedTextLineCounts: new Map<string, number>(),
      tableBlocks: []
    };
    const layoutBlocks = blocks
      .filter(isReconstructableBlock)
      .sort(compareReadingOrder);
    state.tableBlocks = layoutBlocks.filter(isReliableTableBlock);

    for (let index = 0; index < layoutBlocks.length; index += 1) {
      const block = layoutBlocks[index];
      if (state.consumedTextBlockIds.has(block.id)) {
        continue;
      }

      if (options.includePageMarkers && block.pageNumber !== state.currentPage) {
        state.parts.push(`<!-- page:${block.pageNumber} -->`);
        state.currentPage = block.pageNumber;
      }

      if (block.type === "text") {
        state.parts.push(...renderTextBlock(block, layoutBlocks.slice(index + 1), state));
      } else if (block.type === "image") {
        state.parts.push(...renderImageBlock(block));
      } else if (block.type === "table") {
        state.parts.push(...renderTableBlock(block));
      }
    }

    let markdownText = normalizeMarkdown(state.parts.join("\n\n"));
    if ((options.ensureDocumentHeader ?? true) && !hasMarkdownHeader(markdownText)) {
      markdownText = `# ${documentTitle(options.sourcePath)}\n\n${markdownText}`.trim();
    }

    return `${normalizeMarkdownTables(markdownText).trim()}\n`;
  }
}

function isReconstructableBlock(block: ParsedBlock): boolean {
  if (block.source !== "layout") {
    return false;
  }

  return block.type === "text" || block.type === "image" || block.type === "table";
}

function compareReadingOrder(a: ParsedBlock, b: ParsedBlock): number {
  const pageCompare = a.pageNumber - b.pageNumber;
  if (pageCompare !== 0) {
    return pageCompare;
  }

  const ay = a.bbox?.y0 ?? Number.MAX_SAFE_INTEGER;
  const by = b.bbox?.y0 ?? Number.MAX_SAFE_INTEGER;
  if (Math.abs(ay - by) > 4) {
    return ay - by;
  }

  const ax = a.bbox?.x0 ?? Number.MAX_SAFE_INTEGER;
  const bx = b.bbox?.x0 ?? Number.MAX_SAFE_INTEGER;
  if (Math.abs(ax - bx) > 4) {
    return ax - bx;
  }

  return typeRank(a) - typeRank(b) || a.order - b.order || a.id.localeCompare(b.id);
}

function typeRank(block: ParsedBlock): number {
  if (block.type === "text") {
    return 0;
  }
  if (block.type === "image") {
    return 1;
  }
  return 2;
}

function renderTextBlock(
  block: ParsedBlock,
  nextBlocks: ParsedBlock[],
  state: RenderState
): string[] {
  if (!block.text || isPageNumberBlock(block)) {
    return [];
  }

  const lineRefs = textLineRefs(block);
  const consumedLineCount = state.consumedTextLineCounts.get(block.id) ?? 0;
  if (lineRefs.length === 0 || consumedLineCount >= lineRefs.length) {
    return [];
  }
  const lines = lineRefs.slice(consumedLineCount);

  if (isAnchoredCaptionBlock(block) && !containsStructuralHeading(lines.map((line) => line.text))) {
    return renderSourceOnly(lines.map((line) => line.text));
  }

  const parts: string[] = [];
  let bodyLines: string[] = [];
  const skippedCurrentLineIndexes = new Set<number>();

  const flushBody = () => {
    parts.push(...renderBodyLines(bodyLines));
    bodyLines = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const lineRef = lines[index];
    if (skippedCurrentLineIndexes.has(lineRef.lineIndex)) {
      continue;
    }

    const line = lineRef.text;
    const chapterMatch = line.match(/^CHAPTER\s+\d+/i);
    if (chapterMatch) {
      flushBody();
      parts.push(`# ${cleanInlineText(chapterMatch[0])}`);
      continue;
    }

    const hsMatch = line.match(HS_CODE_REGEX);
    if (hsMatch) {
      flushBody();
      const code = hsMatch[1];
      const titleSelection = selectTitleForHSCode(block, lineRef.lineIndex, hsMatch[2] ?? "", nextBlocks, state);
      const title = titleSelection.title;

      for (const selectedLine of titleSelection.selectedLines) {
        if (selectedLine.block.id === block.id) {
          skippedCurrentLineIndexes.add(selectedLine.lineIndex);
        } else {
          const previousCount = state.consumedTextLineCounts.get(selectedLine.block.id) ?? 0;
          state.consumedTextLineCounts.set(
            selectedLine.block.id,
            Math.max(previousCount, selectedLine.lineIndex + 1)
          );
        }
      }

      parts.push(`## ${code}${title ? ` — ${title}` : ""}`);
      continue;
    }

    bodyLines.push(line);
  }

  flushBody();
  return parts;
}

function renderImageBlock(block: ParsedBlock): string[] {
  if (block.metadata?.decorative === true || block.metadata?.duplicateOf !== undefined) {
    return [];
  }

  const parts = [`<!-- image: ${block.id} -->`];
  const caption = sanitizeCaptionText(String(block.metadata?.captionText ?? ""));
  if (caption) {
    parts.push(`*Caption: ${caption}*`);
  }

  return parts;
}

function renderTableBlock(block: ParsedBlock): string[] {
  const markdown = block.markdown?.trim() || block.html?.trim() || block.text?.trim();
  return markdown ? [markdown] : [];
}

function selectTitleForHSCode(
  currentBlock: ParsedBlock,
  hsLineIndex: number,
  inlineTitle: string,
  nextBlocks: ParsedBlock[],
  state: RenderState
): TitleSelection {
  const selectedLines: TextLineRef[] = [];
  const hsLine = textLineRefs(currentBlock).find((line) => line.lineIndex === hsLineIndex);
  const candidateLines = collectTitleSearchLines(currentBlock, hsLineIndex, nextBlocks);

  if (inlineTitle.trim() && isValidTitleLine(inlineTitle, hsLine, state.tableBlocks)) {
    selectedLines.push({
      block: currentBlock,
      lineIndex: hsLineIndex,
      text: cleanInlineText(inlineTitle),
      y0: hsLine?.y0 ?? currentBlock.bbox?.y0 ?? 0,
      y1: hsLine?.y1 ?? currentBlock.bbox?.y1 ?? 0,
      x0: hsLine?.x0 ?? currentBlock.bbox?.x0 ?? 0,
      x1: hsLine?.x1 ?? currentBlock.bbox?.x1 ?? 0
    });
  }

  for (const candidate of candidateLines) {
    if (HS_CODE_REGEX.test(candidate.text)) {
      break;
    }

    if (selectedLines.length === 0) {
      if (distanceFromHSLine(hsLine, candidate) > 140) {
        break;
      }
      if (!isValidTitleLine(candidate.text, candidate, state.tableBlocks)) {
        if (isBodyLikeLine(candidate.text)) {
          break;
        }
        continue;
      }
      selectedLines.push(candidate);
      continue;
    }

    const previous = selectedLines[selectedLines.length - 1];
    if (!isValidTitleLine(candidate.text, candidate, state.tableBlocks) || candidate.y0 - previous.y1 > 30) {
      break;
    }
    selectedLines.push(candidate);
  }

  return {
    title: cleanInlineText(selectedLines.map((line) => line.text).join(" ")),
    selectedLines
  };
}

function collectTitleSearchLines(
  currentBlock: ParsedBlock,
  hsLineIndex: number,
  nextBlocks: ParsedBlock[]
): TextLineRef[] {
  const currentLines = textLineRefs(currentBlock).filter((line) => line.lineIndex > hsLineIndex);
  const nextTextLines = nextBlocks
    .filter((block) => block.type === "text" && block.text && !isPageNumberBlock(block))
    .flatMap(textLineRefs);

  return [...currentLines, ...nextTextLines];
}

function textLineRefs(block: ParsedBlock): TextLineRef[] {
  if (!block.text) {
    return [];
  }

  const lines = splitTextLines(block.text);
  if (lines.length === 0) {
    return [];
  }

  const metadataLines = Array.isArray(block.metadata?.lines) ? block.metadata.lines : undefined;
  return lines.map((text, lineIndex) => {
    const metadataLine = metadataLines?.[lineIndex];
    const metadataBox = isBoundingBoxRecord(metadataLine) ? metadataLine.bbox : undefined;
    const fallbackBox = estimateLineBox(block, lineIndex, lines.length);
    const box = metadataBox ?? fallbackBox;

    return {
      block,
      lineIndex,
      text,
      y0: box.y0,
      y1: box.y1,
      x0: box.x0,
      x1: box.x1
    };
  });
}

function estimateLineBox(block: ParsedBlock, lineIndex: number, lineCount: number) {
  const box = block.bbox ?? { page: block.pageNumber, x0: 0, y0: 0, x1: 0, y1: 0 };
  const lineHeight = Math.max(1, (box.y1 - box.y0) / Math.max(1, lineCount));
  return {
    page: box.page,
    x0: box.x0,
    x1: box.x1,
    y0: box.y0 + lineHeight * lineIndex,
    y1: box.y0 + lineHeight * (lineIndex + 1)
  };
}

function renderSourceOnly(lines: string[]): string[] {
  return renderBodyLines(lines.filter((line) => /^\(Source:/i.test(line)));
}

function renderBodyLines(lines: string[]): string[] {
  const parts: string[] = [];
  let paragraphLines: string[] = [];

  const flushParagraph = () => {
    const paragraph = cleanInlineText(paragraphLines.join(" "));
    if (paragraph) {
      parts.push(paragraph);
    }
    paragraphLines = [];
  };

  for (const line of lines) {
    if (/^\(Source:/i.test(line)) {
      flushParagraph();
      parts.push(cleanInlineText(line));
      continue;
    }

    paragraphLines.push(line);
  }

  flushParagraph();
  return parts;
}

function splitTextLines(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map(cleanInlineText)
    .filter(Boolean);
}

function isValidTitleLine(text: string, line: TextLineRef | undefined, tableBlocks: ParsedBlock[]): boolean {
  const cleaned = cleanInlineText(text);
  if (!cleaned || HS_CODE_REGEX.test(cleaned) || /^CHAPTER\s+\d+/i.test(cleaned) || /^\(Source:/i.test(cleaned)) {
    return false;
  }
  if (isPictureCaption(cleaned) || isTableHeaderText(cleaned) || isListOrTableRowText(cleaned)) {
    return false;
  }
  if (wordCount(cleaned) > 14 || cleaned.length > 110) {
    return false;
  }
  if (line && isLineInsideTable(line, tableBlocks)) {
    return false;
  }

  return uppercaseRatio(cleaned) >= 0.6;
}

function isBodyLikeLine(text: string): boolean {
  const cleaned = cleanInlineText(text);
  return wordCount(cleaned) > 14 || /[.!?]\s*$/.test(cleaned) || uppercaseRatio(cleaned) < 0.45;
}

function distanceFromHSLine(hsLine: TextLineRef | undefined, candidate: TextLineRef): number {
  if (!hsLine || hsLine.block.pageNumber !== candidate.block.pageNumber) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.max(0, candidate.y0 - hsLine.y1);
}

function isReliableTableBlock(block: ParsedBlock): boolean {
  return block.type === "table" && block.bbox !== undefined && block.metadata?.reason !== "aligned-text-grid";
}

function isLineInsideTable(line: TextLineRef, tableBlocks: ParsedBlock[]): boolean {
  return tableBlocks.some((table) => {
    if (!table.bbox || table.pageNumber !== line.block.pageNumber) {
      return false;
    }

    const centerX = (line.x0 + line.x1) / 2;
    const centerY = (line.y0 + line.y1) / 2;
    return (
      centerX >= table.bbox.x0 &&
      centerX <= table.bbox.x1 &&
      centerY >= table.bbox.y0 + 2 &&
      centerY <= table.bbox.y1
    );
  });
}

function isPictureCaption(text: string): boolean {
  return /^(pictures?|fig(?:ure)?|hinh|anh|ảnh)\b/i.test(normalizeAscii(text));
}

function isTableHeaderText(text: string): boolean {
  const normalized = normalizeAscii(text);
  return (
    /\bgaharu tree species\b/.test(normalized) ||
    /\bscientific name\s*\/?\s*genus\b/.test(normalized) ||
    /\bdimension\b.*\b(color|identification)\b/.test(normalized) ||
    /\bcabbage\b.*\bdescription\b/.test(normalized) ||
    /\bbrassica\b.*\bspecies\b/.test(normalized)
  );
}

function isListOrTableRowText(text: string): boolean {
  const cleaned = cleanInlineText(text);
  return /^\d+\.?\s*$/.test(cleaned) || /^\d+\.\s+\S+/.test(cleaned) || /^[ivxlcdm]+\.\s+/i.test(cleaned);
}

function uppercaseRatio(text: string): number {
  const letters = [...text].filter((char) => /\p{L}/u.test(char));
  if (letters.length === 0) {
    return 0;
  }

  const uppercase = letters.filter((char) => char === char.toUpperCase() && char !== char.toLowerCase());
  return uppercase.length / letters.length;
}

function normalizeAscii(text: string): string {
  return cleanInlineText(text)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function isBoundingBoxRecord(value: unknown): value is { bbox: { x0: number; y0: number; x1: number; y1: number } } {
  if (typeof value !== "object" || value === null || !("bbox" in value)) {
    return false;
  }

  const bbox = (value as { bbox?: unknown }).bbox;
  if (typeof bbox !== "object" || bbox === null) {
    return false;
  }

  const record = bbox as Record<string, unknown>;
  return ["x0", "y0", "x1", "y1"].every((key) => typeof record[key] === "number");
}

function cleanInlineText(text: string): string {
  return text
    .replace(/ï¿½/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function isAnchoredCaptionBlock(block: ParsedBlock): boolean {
  if (typeof block.anchorImageId === "string") {
    return true;
  }

  return typeof block.metadata?.anchorImageId === "string";
}

function containsStructuralHeading(lines: string[]): boolean {
  return lines.some((line) => HS_CODE_REGEX.test(line) || /^CHAPTER\s+\d+/i.test(line));
}

function isPageNumberBlock(block: ParsedBlock): boolean {
  const text = block.text?.trim() ?? "";
  return /^\d{1,3}$/.test(text) && (block.bbox?.y0 ?? 0) >= 650;
}

function sanitizeCaptionText(text: string): string {
  const lines = splitTextLines(text).filter((line) => {
    if (HS_CODE_REGEX.test(line) || /^CHAPTER\s+\d+/i.test(line) || /^\(Source:/i.test(line)) {
      return false;
    }
    return true;
  });
  const caption = cleanInlineText(lines.join(" "));

  if (!caption || wordCount(caption) > 25) {
    return "";
  }

  return caption;
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

function hasMarkdownHeader(markdownText: string): boolean {
  return /^(#{1,6})\s+\S.+$/m.test(markdownText);
}

function documentTitle(sourcePath?: string): string {
  if (!sourcePath) {
    return "Parsed Document";
  }

  return path.basename(sourcePath, path.extname(sourcePath)).replace(/[_-]+/g, " ").trim() || "Parsed Document";
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}
