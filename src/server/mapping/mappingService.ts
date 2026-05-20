import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  getCacheManifestRecord,
  inspectDocumentCache,
  readCacheManifest,
  type CacheManifestRecord
} from "../../cache/cacheManifest";
import {
  defaultBlocksPath,
  defaultOutputPath,
  defaultSectionMapPath
} from "../../utils/paths";
import type {
  MappingBbox,
  MappingBlock,
  MappingBlockType,
  MappingDocumentSummary,
  MappingPayload,
  MappingSection,
  MappingTextLine
} from "./types";

const uploadsDir = path.resolve(process.cwd(), "data", "uploads");

/**
 * Lists documents that have enough local artifacts for the Mapping screen.
 *
 * This is the public read API for the UI. It deliberately returns a compact
 * summary instead of leaking the cache manifest shape into the browser contract.
 */
export async function listMappingDocuments(): Promise<MappingDocumentSummary[]> {
  const manifest = await readCacheManifest();
  const byDocument = new Map<string, CacheManifestRecord>();
  for (const record of manifest.documents) {
    byDocument.set(record.document, record);
  }

  const uploadEntries = await readdir(uploadsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of uploadEntries) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".pdf" || byDocument.has(entry.name)) {
      continue;
    }

    const inputPath = path.join(uploadsDir, entry.name);
    const inspection = await inspectDocumentCache(inputPath);
    byDocument.set(entry.name, {
      document: inspection.document,
      inputPath: relativePath(inspection.inputPath) ?? inspection.inputPath,
      inputHash: inspection.inputHash,
      inputSize: inspection.inputSize,
      inputModifiedAt: inspection.inputModifiedAt,
      markdownPath: inspection.markdownPath,
      markdownHash: inspection.markdownHash,
      blocksPath: inspection.blocksPath,
      validationPath: inspection.validationPath,
      assetsDir: inspection.assetsDir,
      sectionsPath: inspection.sectionsPath,
      sectionsHash: inspection.sectionsHash,
      treePath: inspection.treePath,
      treeValidationPath: inspection.treeValidationPath,
      treeSourceMarkdownHash: inspection.treeSourceMarkdownHash,
      lastParsedAt: null,
      lastPageIndexUploadedAt: null,
      parseStatus: inspection.parseStatus,
      pageIndexStatus: inspection.pageIndexCacheStatus,
      documentType: inspection.documentType,
      hsSectionCount: inspection.hsSectionCount,
      imageCount: inspection.imageCount,
      error: null
    });
  }

  const rows = await Promise.all([...byDocument.values()].map(mappingSummaryFromRecord));
  return rows
    .filter((row): row is MappingDocumentSummary => Boolean(row))
    .sort((left, right) => left.document.localeCompare(right.document));
}

/**
 * Builds the full Mapping screen payload for one document.
 *
 * The router exposes this as `/api/mapping/:documentName`; all path validation,
 * artifact loading, and parser-shape normalization stay hidden in this module.
 */
export async function buildMappingPayload(documentName: string, pageNumber?: number): Promise<MappingPayload> {
  const document = safeRequestedPdfName(documentName);
  if (!document) {
    throw new Error("Invalid PDF filename.");
  }

  const inputPath = path.resolve(uploadsDir, document);
  if (!inputPath.startsWith(`${uploadsDir}${path.sep}`)) {
    throw new Error("Invalid PDF filename.");
  }

  const record = await getCacheManifestRecord(document);
  const markdownPath = resolveWorkspacePath(record?.markdownPath || defaultOutputPath(inputPath));
  const blocksPath = resolveWorkspacePath(record?.blocksPath || defaultBlocksPath(inputPath));
  const sectionsPath = resolveWorkspacePath(record?.sectionsPath || defaultSectionMapPath(inputPath));
  const [hasPdf, hasMarkdown, hasBlocks, hasSections] = await Promise.all([
    fileExists(inputPath),
    fileExists(markdownPath),
    fileExists(blocksPath),
    fileExists(sectionsPath)
  ]);

  if (!hasPdf) {
    throw new Error("Mapping unavailable: original PDF is missing.");
  }
  if (!hasBlocks) {
    throw new Error("Mapping unavailable: blocks.json is missing. Re-run local parse.");
  }
  if (!hasMarkdown) {
    throw new Error("Mapping unavailable: Markdown is missing. Re-run local parse.");
  }

  const rawBlocks = await readOptionalJson<unknown>(blocksPath);
  const sectionMap = hasSections ? await readOptionalJson<{ sections?: unknown[] } | unknown[]>(sectionsPath) : undefined;
  const sections = normalizeMappingSections(sectionMap, document);
  const allBlocks = normalizeMappingBlocks(rawBlocks, document, sections);
  const blocks = pageNumber ? allBlocks.filter((block) => block.pageNumber === pageNumber) : allBlocks;
  const markdown = await readOptionalText(markdownPath);
  const pageCount = Math.max(
    1,
    ...allBlocks.map((block) => block.pageNumber),
    ...sections.flatMap((section) => [Number(section.pageStart || 0), Number(section.pageEnd || 0)])
  );
  const inspection = await inspectDocumentCache(inputPath).catch(() => undefined);

  return {
    document,
    pdfUrl: `/api/uploads/${encodeURIComponent(document)}`,
    markdownPath: relativePath(markdownPath),
    blocksPath: relativePath(blocksPath),
    sectionsPath: relativePath(sectionsPath),
    pageCount,
    blocks,
    sections,
    markdown,
    cacheStatus: {
      parse: inspection?.parseStatus ?? record?.parseStatus ?? "missing",
      pageIndex: inspection?.pageIndexCacheStatus ?? record?.pageIndexStatus ?? "missing",
      mapping: hasPdf && hasBlocks && hasMarkdown ? "available" : "missing"
    }
  };
}

async function mappingSummaryFromRecord(record: CacheManifestRecord): Promise<MappingDocumentSummary | undefined> {
  const document = safeRequestedPdfName(record.document);
  if (!document) return undefined;

  const inputPath = path.resolve(uploadsDir, document);
  const markdownPath = resolveWorkspacePath(record.markdownPath || defaultOutputPath(inputPath));
  const blocksPath = resolveWorkspacePath(record.blocksPath || defaultBlocksPath(inputPath));
  const sectionsPath = resolveWorkspacePath(record.sectionsPath || defaultSectionMapPath(inputPath));
  const [hasPdf, hasMarkdown, hasBlocks, hasSections] = await Promise.all([
    fileExists(inputPath),
    fileExists(markdownPath),
    fileExists(blocksPath),
    fileExists(sectionsPath)
  ]);
  if (!hasPdf || !hasMarkdown || !hasBlocks) return undefined;

  return {
    document,
    pdfUrl: `/api/uploads/${encodeURIComponent(document)}`,
    markdownPath: relativePath(markdownPath),
    blocksPath: relativePath(blocksPath),
    sectionsPath: relativePath(sectionsPath),
    parseStatus: record.parseStatus,
    pageIndexStatus: record.pageIndexStatus,
    mappingStatus: "available",
    hasPdf,
    hasMarkdown,
    hasBlocks,
    hasSections,
    hsSectionCount: record.hsSectionCount,
    imageCount: record.imageCount
  };
}

function normalizeMappingBlocks(rawBlocks: unknown, document: string, sections: MappingSection[]): MappingBlock[] {
  const blocks = Array.isArray(rawBlocks)
    ? rawBlocks
    : typeof rawBlocks === "object" && rawBlocks !== null && Array.isArray((rawBlocks as { blocks?: unknown[] }).blocks)
      ? (rawBlocks as { blocks: unknown[] }).blocks
      : [];
  const sortedBlocks = blocks
    .map((block, index) => normalizeMappingBlock(block, index, document))
    .filter((block): block is MappingBlock => Boolean(block))
    .sort((left, right) => left.pageNumber - right.pageNumber || left.bbox.y0 - right.bbox.y0 || left.bbox.x0 - right.bbox.x0);
  assignSectionsToBlocks(sortedBlocks, sections);
  return sortedBlocks;
}

function normalizeMappingBlock(rawBlock: unknown, index: number, document: string): MappingBlock | undefined {
  if (typeof rawBlock !== "object" || rawBlock === null) return undefined;
  const block = rawBlock as Record<string, unknown>;
  const metadata = objectValue(block.metadata);
  const bbox = normalizeBbox(block.bbox);
  const pageNumber = numberFromUnknown(block.pageNumber) ?? numberFromUnknown((block.bbox as { page?: unknown } | undefined)?.page);
  if (!bbox || !pageNumber) return undefined;

  const rawType = typeof block.type === "string" ? block.type : undefined;
  const text = firstStringValue(block.text, block.markdown, block.html) ?? "";
  const assetPath = firstStringValue(metadata?.assetPath);
  return {
    id: firstStringValue(block.id) ?? `${document}-p${pageNumber}-b${index}`,
    document,
    pageNumber,
    pageWidth: numberFromUnknown(metadata?.pageWidth),
    pageHeight: numberFromUnknown(metadata?.pageHeight),
    bbox,
    type: mapBlockType(rawType, text),
    text,
    markdownText: firstStringValue(block.markdown),
    confidence: numberFromUnknown(block.confidence),
    assetUrl: assetUrlForMappingAsset(assetPath),
    captionText: firstStringValue(metadata?.captionText),
    lines: normalizeMappedTextLines(metadata?.lines)
  };
}

function normalizeMappedTextLines(value: unknown): MappingTextLine[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const lines: MappingTextLine[] = [];
  for (const item of value) {
    const line = objectValue(item);
    if (!line) continue;

    const text = firstStringValue(line.text);
    const bbox = normalizeBbox(line.bbox);
    if (!text || !bbox) continue;

    const mappedLine: MappingTextLine = { text, bbox };
    const fontSize = numberFromUnknown(line.fontSize);
    const font = firstStringValue(line.font);
    const flags = numberFromUnknown(line.flags);
    if (fontSize) mappedLine.fontSize = fontSize;
    if (font) mappedLine.font = font;
    if (flags) mappedLine.flags = flags;
    lines.push(mappedLine);
  }
  return lines.length > 0 ? lines : undefined;
}

function assetUrlForMappingAsset(assetPath: string | undefined): string | undefined {
  if (!assetPath) {
    return undefined;
  }
  const normalized = assetPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized.startsWith("assets/")) {
    return undefined;
  }
  return `/${normalized.split("/").map(encodeURIComponent).join("/")}`;
}

function normalizeMappingSections(rawSections: unknown, document: string): MappingSection[] {
  const sections = Array.isArray(rawSections)
    ? rawSections
    : typeof rawSections === "object" && rawSections !== null && Array.isArray((rawSections as { sections?: unknown[] }).sections)
      ? (rawSections as { sections: unknown[] }).sections
      : [];
  return sections
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((section) => ({
      document: firstStringValue(section.document) ?? document,
      section: firstStringValue(section.section),
      hsCode: firstStringValue(section.hsCode),
      title: firstStringValue(section.title),
      pageStart: numberFromUnknown(section.pageStart) ?? null,
      pageEnd: numberFromUnknown(section.pageEnd) ?? numberFromUnknown(section.pageStart) ?? null,
      source: firstStringValue(section.source) ?? null,
      markdownHeading: firstStringValue(section.markdownHeading),
      textPreview: firstStringValue(section.textPreview)
    }));
}

function assignSectionsToBlocks(blocks: MappingBlock[], sections: MappingSection[]): void {
  let activeSection: MappingSection | undefined;
  for (const block of blocks) {
    const candidates = sections.filter((section) => {
      const pageStart = Number(section.pageStart || 0);
      const pageEnd = Number(section.pageEnd || pageStart);
      return pageStart > 0 && block.pageNumber >= pageStart && block.pageNumber <= pageEnd;
    });
    const matchedByText = candidates.find((section) => {
      const text = block.text.toLowerCase();
      return Boolean(
        (section.hsCode && text.includes(section.hsCode.toLowerCase())) ||
        (section.title && text.includes(section.title.toLowerCase()))
      );
    });
    if (matchedByText) {
      activeSection = matchedByText;
    } else if (!activeSection || !candidates.includes(activeSection)) {
      activeSection = candidates[0];
    }

    if (activeSection && candidates.includes(activeSection)) {
      block.section = activeSection.section;
      block.hsCode = activeSection.hsCode;
      block.title = activeSection.title;
      if (block.type === "paragraph" && activeSection.hsCode && block.text.includes(activeSection.hsCode)) {
        block.type = "hs-code";
      }
    }
  }
}

function normalizeBbox(value: unknown): MappingBbox | undefined {
  if (Array.isArray(value) && value.length >= 4) {
    const [x0, y0, x1, y1] = value.map(Number);
    if ([x0, y0, x1, y1].every(Number.isFinite)) {
      return { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
    }
  }
  const bbox = objectValue(value);
  if (!bbox) return undefined;
  const x0 = Number(bbox.x0);
  const y0 = Number(bbox.y0);
  const x1 = Number(bbox.x1);
  const y1 = Number(bbox.y1);
  if (![x0, y0, x1, y1].every(Number.isFinite)) return undefined;
  return { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
}

function mapBlockType(rawType: string | undefined, text: string): MappingBlockType {
  const normalized = String(rawType || "").toLowerCase();
  const trimmed = text.trim();
  if (normalized === "image") return "image";
  if (normalized === "table") return "table";
  if (normalized === "caption") return "caption";
  if (/^source\b/i.test(trimmed)) return "source";
  if (/\b\d{4}\.\d{2}\.\d{2}\b/.test(trimmed)) return "hs-code";
  if (/^chapter\s+\d+/i.test(trimmed) || /^#+\s+/.test(trimmed)) return "heading";
  if (trimmed.length > 0 && trimmed.length < 150 && trimmed === trimmed.toUpperCase() && /[A-Z]/.test(trimmed)) return "title";
  if (normalized === "text") return "paragraph";
  return "unknown";
}

function safeRequestedPdfName(fileName: string): string | undefined {
  if (fileName !== path.basename(fileName) || path.extname(fileName).toLowerCase() !== ".pdf") {
    return undefined;
  }
  return fileName;
}

function resolveWorkspacePath(filePath: string): string {
  return path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(process.cwd(), filePath);
}

async function fileExists(filePath: string): Promise<boolean> {
  return await stat(filePath).then((item) => item.isFile()).catch(() => false);
}

async function readOptionalText(filePath: string): Promise<string> {
  return await readFile(filePath, "utf8").catch(() => "");
}

async function readOptionalJson<T>(filePath: string): Promise<T | undefined> {
  const text = await readOptionalText(filePath);
  if (!text) {
    return undefined;
  }
  return JSON.parse(text) as T;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function firstStringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function numberFromUnknown(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function relativePath(filePath: string | undefined): string | undefined {
  return filePath ? path.relative(process.cwd(), path.resolve(filePath)).replace(/\\/g, "/") : undefined;
}
