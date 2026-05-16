import path from "node:path";
import type { ParsedBlock, SectionMapEntry, SectionMapResult } from "../types";

interface MarkdownSectionRef {
  hsCode: string;
  title: string;
  heading: string;
  startIndex: number;
  endIndex: number;
}

interface LayoutSectionRef {
  hsCode: string;
  blockIndex: number;
  pageNumber: number;
}

export class SectionMapBuilder {
  public static build(markdownText: string, parsedBlocks: ParsedBlock[], documentPath: string): SectionMapResult {
    const document = path.basename(documentPath);
    const chapter = extractChapter(markdownText);
    const markdownSections = extractMarkdownSections(markdownText);
    const documentType = markdownSections.length === 0 ? "non-hs-reference" : "hs-code-reference";
    const layoutSections = extractLayoutSections(parsedBlocks);
    const layoutByCode = new Map(layoutSections.map((section) => [section.hsCode, section]));
    const sortedBlocks = parsedBlocks.filter(isSectionContentBlock).sort(compareReadingOrder);
    const warnings: string[] = [];

    const sections: SectionMapEntry[] = markdownSections.map((section) => {
      const layoutSection = layoutByCode.get(section.hsCode);
      const range = inferPageRange(section.hsCode, layoutSection, layoutSections, sortedBlocks);
      const bodyText = markdownText.slice(section.startIndex, section.endIndex);

      if (!range.pageStart || !range.pageEnd) {
        warnings.push(`Missing page range for HS code ${section.hsCode}.`);
      }

      return {
        document,
        chapter,
        hsCode: section.hsCode,
        title: section.title,
        section: `${section.hsCode}${section.title ? ` — ${section.title}` : ""}`,
        pageStart: range.pageStart,
        pageEnd: range.pageEnd,
        source: extractSource(bodyText),
        markdownHeading: section.heading,
        textPreview: buildTextPreview(bodyText)
      };
    });

    return {
      document,
      documentType,
      sections,
      warnings
    };
  }
}

function extractChapter(markdownText: string): string | null {
  const match = markdownText.match(/^#\s+(CHAPTER\s+\d+.*?)\s*$/im);
  return match ? cleanText(match[1]) : null;
}

function extractMarkdownSections(markdownText: string): MarkdownSectionRef[] {
  const refs: Array<Omit<MarkdownSectionRef, "endIndex">> = [];
  const regex = /^##\s+(\d{4}\.\d{2}\.\d{2})\b(?:\s+(?:—|-|â€”)\s*(.+?))?\s*$/gm;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(markdownText)) !== null) {
    refs.push({
      hsCode: match[1],
      title: cleanText(match[2] ?? ""),
      heading: cleanText(match[0]),
      startIndex: match.index
    });
  }

  return refs.map((ref, index) => ({
    ...ref,
    endIndex: refs[index + 1]?.startIndex ?? markdownText.length
  }));
}

function extractLayoutSections(parsedBlocks: ParsedBlock[]): LayoutSectionRef[] {
  const sortedBlocks = parsedBlocks.filter(isSectionContentBlock).sort(compareReadingOrder);
  const sections: LayoutSectionRef[] = [];

  for (const [blockIndex, block] of sortedBlocks.entries()) {
    const text = block.text ?? block.markdown ?? "";
    const match = text.match(/\b(\d{4}\.\d{2}\.\d{2})\b/);
    if (!match) {
      continue;
    }

    if (sections.some((section) => section.hsCode === match[1])) {
      continue;
    }

    sections.push({
      hsCode: match[1],
      blockIndex,
      pageNumber: block.pageNumber
    });
  }

  return sections;
}

function inferPageRange(
  hsCode: string,
  current: LayoutSectionRef | undefined,
  layoutSections: LayoutSectionRef[],
  sortedBlocks: ParsedBlock[]
): { pageStart: number | null; pageEnd: number | null } {
  if (!current) {
    return { pageStart: null, pageEnd: null };
  }

  const currentSectionIndex = layoutSections.findIndex((section) => section.hsCode === hsCode);
  const nextSection = currentSectionIndex >= 0 ? layoutSections[currentSectionIndex + 1] : undefined;
  const endBlockIndex = nextSection?.blockIndex ?? sortedBlocks.length;
  const contentBlocks = sortedBlocks.slice(current.blockIndex, endBlockIndex);
  const pageNumbers = contentBlocks
    .map((block) => block.pageNumber)
    .filter((pageNumber) => Number.isInteger(pageNumber) && pageNumber > 0);

  if (pageNumbers.length === 0) {
    return { pageStart: current.pageNumber, pageEnd: current.pageNumber };
  }

  return {
    pageStart: Math.min(...pageNumbers),
    pageEnd: Math.max(...pageNumbers)
  };
}

function isSectionContentBlock(block: ParsedBlock): boolean {
  return block.source === "layout" && (block.type === "text" || block.type === "image" || block.type === "table");
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

  return a.order - b.order || a.id.localeCompare(b.id);
}

function extractSource(sectionText: string): string | null {
  const match = sectionText.match(/^\(Source:\s*([^)]+)\)\s*$/im);
  return match ? cleanText(match[1]) : null;
}

function buildTextPreview(sectionText: string): string {
  const cleaned = sectionText
    .replace(/^##\s+.*$/gm, "")
    .replace(/!\[[^\]]*]\([^)]+\)/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^\*Caption:\s*.*?\*\s*$/gm, "")
    .replace(/^\(Source:.*?\)\s*$/gm, "")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned.length > 180 ? `${cleaned.slice(0, 177).trim()}...` : cleaned;
}

function cleanText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
