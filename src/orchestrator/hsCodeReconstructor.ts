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

interface HSCodeLineParse {
  codes: string[];
  trailingText: string;
}

interface HSCodeGroup {
  codes: string[];
  codeLines: TextLineRef[];
  inlineTitle: string;
  inlineTitleLine?: TextLineRef;
  titleCandidateLines: TextLineRef[];
}

const HS_CODE_PATTERN = "\\d{4}\\.\\d{2}\\.\\d{2}";
const HS_CODE_REGEX = new RegExp(`^(${HS_CODE_PATTERN})\\b\\s*(.*)$`);
const MARKDOWN_HEADING_DASH = "\u2014";

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

    const hsLine = parseHSCodeLine(line);
    if (hsLine) {
      flushBody();
      const followingLines = collectTitleSearchLines(block, lineRef.lineIndex, nextBlocks);
      const group = collectHSCodeGroup(lineRef, hsLine, followingLines);
      const titleSelection = selectTitleForHSCodeGroup(group, state);
      const title = titleSelection.title;
      const sharedDescriptionLines = selectSharedDescriptionLines(group, titleSelection);

      for (const consumedLine of [...group.codeLines, ...titleSelection.selectedLines, ...sharedDescriptionLines]) {
        markConsumedLine(consumedLine, block, skippedCurrentLineIndexes, state);
      }

      const groupReference = renderGroupReference(group.codes);
      const sharedDescription = renderSharedDescription(sharedDescriptionLines);
      for (const code of group.codes) {
        parts.push(`## ${code}${title ? ` ${MARKDOWN_HEADING_DASH} ${title}` : ""}`);
        if (groupReference) {
          parts.push(groupReference);
        }
        parts.push(...sharedDescription);
      }
      continue;
    }

    bodyLines.push(line);
  }

  flushBody();
  return parts;
}

function markConsumedLine(
  line: TextLineRef,
  currentBlock: ParsedBlock,
  skippedCurrentLineIndexes: Set<number>,
  state: RenderState
): void {
  if (line.block.id === currentBlock.id) {
    skippedCurrentLineIndexes.add(line.lineIndex);
    return;
  }

  const previousCount = state.consumedTextLineCounts.get(line.block.id) ?? 0;
  state.consumedTextLineCounts.set(line.block.id, Math.max(previousCount, line.lineIndex + 1));
}

function renderGroupReference(codes: string[]): string | undefined {
  if (codes.length <= 1) {
    return undefined;
  }

  return `Grouped HS code set: ${codes.join(", ")}.`;
}

function renderSharedDescription(lines: TextLineRef[]): string[] {
  if (lines.length === 0) {
    return [];
  }

  const renderedLines = renderBodyLines(lines.map((line) => line.text));
  if (renderedLines.length === 0) {
    return [];
  }

  return ["Shared description:", ...renderedLines];
}

function renderImageBlock(block: ParsedBlock): string[] {
  if (block.metadata?.decorative === true || block.metadata?.duplicateOf !== undefined) {
    return [];
  }

  const caption = sanitizeCaptionText(String(block.metadata?.captionText ?? ""));
  const assetPath = getStringMetadata(block, "assetPath");
  const parts = assetPath
    ? [`![${escapeMarkdownAlt(caption || block.id)}](${assetPath})`, `<!-- image-id: ${block.id} -->`]
    : [`<!-- image: ${block.id} -->`];

  if (caption) {
    parts.push(`*Caption: ${caption}*`);
  }

  return parts;
}

function renderTableBlock(block: ParsedBlock): string[] {
  const markdown = block.markdown?.trim() || block.html?.trim() || block.text?.trim();
  return markdown ? [markdown] : [];
}

function collectHSCodeGroup(
  firstLine: TextLineRef,
  firstParse: HSCodeLineParse,
  followingLines: TextLineRef[]
): HSCodeGroup {
  const codes = [...firstParse.codes];
  const codeLines = [firstLine];
  let inlineTitle = firstParse.trailingText;
  let inlineTitleLine: TextLineRef | undefined = inlineTitle ? firstLine : undefined;
  let cursor = 0;

  if (!inlineTitle) {
    while (cursor < followingLines.length) {
      const candidate = followingLines[cursor];
      const parsed = parseHSCodeLine(candidate.text);
      if (!parsed) {
        break;
      }
      if (!isAdjacentHSCodeLine(codeLines[codeLines.length - 1], candidate)) {
        break;
      }

      codes.push(...parsed.codes);
      codeLines.push(candidate);
      cursor += 1;

      if (parsed.trailingText) {
        inlineTitle = parsed.trailingText;
        inlineTitleLine = candidate;
        break;
      }
    }
  }

  return {
    codes,
    codeLines,
    inlineTitle,
    inlineTitleLine,
    titleCandidateLines: followingLines.slice(cursor)
  };
}

function selectTitleForHSCodeGroup(group: HSCodeGroup, state: RenderState): TitleSelection {
  const selectedLines: TextLineRef[] = [];
  const hsLine = group.codeLines[group.codeLines.length - 1];

  if (
    group.inlineTitle.trim() &&
    group.inlineTitleLine &&
    isValidTitleLine(group.inlineTitle, group.inlineTitleLine, state.tableBlocks)
  ) {
    selectedLines.push({
      ...group.inlineTitleLine,
      text: cleanInlineText(group.inlineTitle)
    });
  }

  for (const candidate of group.titleCandidateLines) {
    if (parseHSCodeLine(candidate.text)) {
      break;
    }

    if (selectedLines.length === 0) {
      if (distanceFromHSLine(hsLine, candidate) > 140) {
        break;
      }
      if (!isValidTitleLine(candidate.text, candidate, state.tableBlocks)) {
        if (isRejectedTitleBoundary(candidate.text) || isBodyLikeLine(candidate.text)) {
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

function selectSharedDescriptionLines(group: HSCodeGroup, titleSelection: TitleSelection): TextLineRef[] {
  if (group.codes.length <= 1) {
    return [];
  }

  const selectedTitleKeys = new Set(titleSelection.selectedLines.map(textLineKey));
  let startIndex = 0;
  for (const [index, candidate] of group.titleCandidateLines.entries()) {
    if (selectedTitleKeys.has(textLineKey(candidate))) {
      startIndex = index + 1;
    }
  }

  const sharedLines: TextLineRef[] = [];
  for (let index = startIndex; index < group.titleCandidateLines.length; index += 1) {
    const candidate = group.titleCandidateLines[index];
    const cleaned = cleanInlineText(candidate.text);
    if (!cleaned) {
      continue;
    }
    if (parseHSCodeLine(cleaned) || /^CHAPTER\s+\d+/i.test(cleaned)) {
      break;
    }
    if (selectedTitleKeys.has(textLineKey(candidate)) || isPageNumberLine(candidate)) {
      continue;
    }

    sharedLines.push(candidate);
  }

  return sharedLines;
}

function textLineKey(line: TextLineRef): string {
  return `${line.block.id}:${line.lineIndex}`;
}

function parseHSCodeLine(text: string): HSCodeLineParse | undefined {
  let rest = cleanInlineText(text);
  const codes: string[] = [];

  while (rest.length > 0) {
    const match = rest.match(HS_CODE_REGEX);
    if (!match || !rest.startsWith(match[1])) {
      break;
    }

    codes.push(match[1]);
    rest = cleanInlineText(match[2] ?? "");
  }

  if (codes.length === 0) {
    return undefined;
  }

  return {
    codes,
    trailingText: rest
  };
}

function isAdjacentHSCodeLine(previous: TextLineRef, candidate: TextLineRef): boolean {
  if (previous.block.pageNumber !== candidate.block.pageNumber) {
    return false;
  }

  return candidate.y0 - previous.y1 <= 45;
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

function isRejectedTitleBoundary(text: string): boolean {
  const cleaned = cleanInlineText(text);
  return (
    /^CHAPTER\s+\d+/i.test(cleaned) ||
    /^\(Source:/i.test(cleaned) ||
    isPictureCaption(cleaned) ||
    isTableHeaderText(cleaned) ||
    isListOrTableRowText(cleaned)
  );
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

function isPageNumberLine(line: TextLineRef): boolean {
  return /^\d{1,3}$/.test(line.text.trim()) && line.y0 >= 650;
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

function getStringMetadata(block: ParsedBlock, key: string): string | undefined {
  const value = block.metadata?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function escapeMarkdownAlt(text: string): string {
  return text.replace(/[[\]\\]/g, "\\$&");
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}
