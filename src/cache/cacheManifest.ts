import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  defaultBlocksPath,
  defaultOutputPath,
  defaultSectionMapPath,
  defaultTreePath,
  defaultTreeValidationReportPath,
  defaultValidationReportPath,
  ensureDirectory
} from "../utils/paths";

export type ParseCacheStatus = "missing" | "fresh" | "stale" | "failed";
export type PageIndexCacheStatus = "missing" | "fresh" | "stale" | "failed";
export type PageIndexRunStatus = PageIndexCacheStatus | "skipped";
export type TreeCacheStatus = "fresh" | "cached" | "missing" | "stale";
export type ParseCacheAction = "skipped-cache" | "parsed" | "failed";
export type PageIndexCacheAction = "skipped-disabled" | "skipped-cache" | "uploaded" | "failed";
export type DocumentCacheType = "hs-chapter" | "non-hs-reference";

export interface CacheManifestRecord {
  document: string;
  inputPath: string;
  inputHash: string | null;
  inputSize: number | null;
  inputModifiedAt: string | null;
  markdownPath: string;
  markdownHash: string | null;
  blocksPath: string;
  validationPath: string;
  assetsDir: string;
  sectionsPath: string;
  sectionsHash: string | null;
  treePath: string;
  treeValidationPath: string;
  treeSourceMarkdownHash: string | null;
  lastParsedAt: string | null;
  lastPageIndexUploadedAt: string | null;
  parseStatus: ParseCacheStatus;
  pageIndexStatus: PageIndexRunStatus;
  documentType: DocumentCacheType;
  hsSectionCount: number;
  imageCount: number;
  error: string | null;
  parseCacheStatusBefore?: ParseCacheStatus;
  parseAction?: ParseCacheAction;
  pageIndexCacheStatusBefore?: PageIndexCacheStatus;
  pageIndexAction?: PageIndexCacheAction;
  pageIndexCacheStatusAfter?: PageIndexCacheStatus;
  forcedReparse?: boolean;
  forcedPageIndexUpload?: boolean;
}

export interface CacheManifest {
  generatedAt: string;
  documents: CacheManifestRecord[];
}

export interface DocumentCacheInspection {
  document: string;
  inputPath: string;
  inputHash: string | null;
  inputSize: number | null;
  inputModifiedAt: string | null;
  markdownPath: string;
  markdownHash: string | null;
  blocksPath: string;
  validationPath: string;
  assetsDir: string;
  sectionsPath: string;
  sectionsHash: string | null;
  treePath: string;
  treeValidationPath: string;
  treeSourceMarkdownHash: string | null;
  parseStatus: ParseCacheStatus;
  pageIndexCacheStatus: PageIndexCacheStatus;
  treeStatus: TreeCacheStatus;
  documentType: DocumentCacheType;
  hsSectionCount: number;
  imageCount: number;
  hasMarkdown: boolean;
  hasBlocks: boolean;
  hasValidation: boolean;
  hasSections: boolean;
  hasTree: boolean;
  hasTreeValidation: boolean;
  canReuseUploadedInput: boolean;
  missingParseArtifacts: string[];
  record?: CacheManifestRecord;
}

export interface InspectDocumentCacheOptions {
  inputHash?: string;
  inputSize?: number;
  inputModifiedAt?: string;
}

export const CACHE_MANIFEST_PATH = path.resolve(process.cwd(), "data", "converted", "cache.manifest.json");

export async function inspectDocumentCache(
  inputPath: string,
  options: InspectDocumentCacheOptions = {}
): Promise<DocumentCacheInspection> {
  const resolvedInputPath = path.resolve(inputPath);
  const document = path.basename(resolvedInputPath);
  const paths = artifactPaths(resolvedInputPath);
  const manifest = await readCacheManifest();
  const existingRecord = findManifestRecord(manifest, document, resolvedInputPath);
  const inputStat = await stat(resolvedInputPath).catch(() => undefined);
  const inputExists = Boolean(inputStat?.isFile());
  const actualInputHash = inputExists ? await sha256File(resolvedInputPath).catch(() => undefined) : undefined;
  const expectedInputHash = normalizeHash(options.inputHash);
  const inputHash = expectedInputHash ?? actualInputHash ?? existingRecord?.inputHash ?? null;
  const inputSize = options.inputSize ?? (inputExists ? inputStat?.size : undefined) ?? existingRecord?.inputSize ?? null;
  const inputModifiedAt =
    options.inputModifiedAt ??
    (inputExists && inputStat ? inputStat.mtime.toISOString() : undefined) ??
    existingRecord?.inputModifiedAt ??
    null;

  const [markdownStat, blocksStat, validationStat, sectionsStat, treeStat, treeValidationStat] = await Promise.all([
    stat(paths.markdownPath).catch(() => undefined),
    stat(paths.blocksPath).catch(() => undefined),
    stat(paths.validationPath).catch(() => undefined),
    stat(paths.sectionsPath).catch(() => undefined),
    stat(paths.treePath).catch(() => undefined),
    stat(paths.treeValidationPath).catch(() => undefined)
  ]);
  const hasMarkdown = Boolean(markdownStat?.isFile());
  const hasBlocks = Boolean(blocksStat?.isFile());
  const hasValidation = Boolean(validationStat?.isFile());
  const hasSections = Boolean(sectionsStat?.isFile());
  const hasTree = Boolean(treeStat?.isFile());
  const hasTreeValidation = Boolean(treeValidationStat?.isFile());
  const [markdownHash, sectionsHash] = await Promise.all([
    hasMarkdown ? sha256File(paths.markdownPath).catch(() => undefined) : undefined,
    hasSections ? sha256File(paths.sectionsPath).catch(() => undefined) : undefined
  ]);
  const treeSourceMarkdownHash = hasTree
    ? await readTreeSourceMarkdownHash(paths.treePath).then((value) => value ?? existingRecord?.treeSourceMarkdownHash ?? null)
    : null;
  const sectionSummary = hasSections ? await summarizeSectionMap(paths.sectionsPath) : undefined;
  const imageCount = await countPngAssets(paths.assetsDir);

  const missingParseArtifacts = [
    hasMarkdown ? undefined : "markdown",
    hasBlocks ? undefined : "blocks",
    hasValidation ? undefined : "validation",
    hasSections ? undefined : "sections"
  ].filter((value): value is string => Boolean(value));
  const hasRequiredParseArtifacts = missingParseArtifacts.length === 0;
  const selectedInputChanged = Boolean(
    existingRecord?.inputHash &&
    inputHash &&
    existingRecord.inputHash !== inputHash
  );

  let parseStatus: ParseCacheStatus;
  if (existingRecord?.parseStatus === "failed" && !hasRequiredParseArtifacts) {
    parseStatus = "failed";
  } else if (!hasMarkdown && !hasSections) {
    parseStatus = "missing";
  } else if (!hasRequiredParseArtifacts || selectedInputChanged) {
    parseStatus = "stale";
  } else {
    parseStatus = "fresh";
  }

  let pageIndexCacheStatus: PageIndexCacheStatus;
  if (!hasTree && existingRecord?.pageIndexStatus === "failed") {
    pageIndexCacheStatus = "failed";
  } else if (!hasTree) {
    pageIndexCacheStatus = "missing";
  } else if (!markdownHash || !treeSourceMarkdownHash || treeSourceMarkdownHash !== markdownHash) {
    pageIndexCacheStatus = "stale";
  } else {
    pageIndexCacheStatus = "fresh";
  }

  const treeStatus: TreeCacheStatus = hasTree
    ? pageIndexCacheStatus === "fresh"
      ? "fresh"
      : treeSourceMarkdownHash
        ? "stale"
        : "cached"
    : "missing";

  return {
    document,
    inputPath: relativePath(resolvedInputPath),
    inputHash,
    inputSize,
    inputModifiedAt,
    markdownPath: relativePath(paths.markdownPath),
    markdownHash: markdownHash ?? null,
    blocksPath: relativePath(paths.blocksPath),
    validationPath: relativePath(paths.validationPath),
    assetsDir: relativePath(paths.assetsDir),
    sectionsPath: relativePath(paths.sectionsPath),
    sectionsHash: sectionsHash ?? null,
    treePath: relativePath(paths.treePath),
    treeValidationPath: relativePath(paths.treeValidationPath),
    treeSourceMarkdownHash,
    parseStatus,
    pageIndexCacheStatus,
    treeStatus,
    documentType: sectionSummary?.documentType ?? existingRecord?.documentType ?? "non-hs-reference",
    hsSectionCount: sectionSummary?.hsSectionCount ?? existingRecord?.hsSectionCount ?? 0,
    imageCount,
    hasMarkdown,
    hasBlocks,
    hasValidation,
    hasSections,
    hasTree,
    hasTreeValidation,
    canReuseUploadedInput: Boolean(inputExists && inputHash && actualInputHash === inputHash),
    missingParseArtifacts,
    record: existingRecord
  };
}

export async function writeCacheManifestRecord(
  inputPath: string,
  updates: Partial<CacheManifestRecord> = {},
  options: InspectDocumentCacheOptions = {}
): Promise<CacheManifestRecord> {
  const inspection = await inspectDocumentCache(inputPath, options);
  const manifest = await readCacheManifest();
  const previous = findManifestRecord(manifest, inspection.document, path.resolve(inputPath));
  const record: CacheManifestRecord = {
    document: inspection.document,
    inputPath: inspection.inputPath,
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
    lastParsedAt: previous?.lastParsedAt ?? null,
    lastPageIndexUploadedAt: previous?.lastPageIndexUploadedAt ?? null,
    parseStatus: inspection.parseStatus,
    pageIndexStatus: inspection.pageIndexCacheStatus,
    documentType: inspection.documentType,
    hsSectionCount: inspection.hsSectionCount,
    imageCount: inspection.imageCount,
    error: previous?.error ?? null,
    parseCacheStatusBefore: previous?.parseCacheStatusBefore,
    parseAction: previous?.parseAction,
    pageIndexCacheStatusBefore: previous?.pageIndexCacheStatusBefore,
    pageIndexAction: previous?.pageIndexAction,
    pageIndexCacheStatusAfter: previous?.pageIndexCacheStatusAfter,
    forcedReparse: previous?.forcedReparse,
    forcedPageIndexUpload: previous?.forcedPageIndexUpload,
    ...updates
  };

  const byDocument = new Map(manifest.documents.map((item) => [item.document, item]));
  byDocument.set(record.document, record);
  const nextManifest: CacheManifest = {
    generatedAt: new Date().toISOString(),
    documents: [...byDocument.values()].sort((left, right) => left.document.localeCompare(right.document))
  };
  await ensureDirectory(path.dirname(CACHE_MANIFEST_PATH));
  await writeFile(CACHE_MANIFEST_PATH, `${JSON.stringify(nextManifest, null, 2)}\n`, "utf8");
  return record;
}

export async function readCacheManifest(): Promise<CacheManifest> {
  const text = await readFile(CACHE_MANIFEST_PATH, "utf8").catch(() => "");
  if (!text.trim()) {
    return { generatedAt: new Date().toISOString(), documents: [] };
  }

  const parsed = JSON.parse(text) as Partial<CacheManifest>;
  return {
    generatedAt: typeof parsed.generatedAt === "string" ? parsed.generatedAt : new Date().toISOString(),
    documents: Array.isArray(parsed.documents) ? parsed.documents.filter(isCacheManifestRecord) : []
  };
}

export async function getCacheManifestRecord(document: string): Promise<CacheManifestRecord | undefined> {
  const manifest = await readCacheManifest();
  return manifest.documents.find((record) => record.document === document);
}

export async function sha256File(filePath: string): Promise<string> {
  const buffer = await readFile(filePath);
  return createHash("sha256").update(buffer).digest("hex");
}

function artifactPaths(inputPath: string): {
  markdownPath: string;
  blocksPath: string;
  validationPath: string;
  assetsDir: string;
  sectionsPath: string;
  treePath: string;
  treeValidationPath: string;
} {
  const baseName = path.basename(inputPath, path.extname(inputPath));
  return {
    markdownPath: defaultOutputPath(inputPath),
    blocksPath: defaultBlocksPath(inputPath),
    validationPath: defaultValidationReportPath(inputPath),
    assetsDir: path.resolve(process.cwd(), "data", "converted", "assets", baseName),
    sectionsPath: defaultSectionMapPath(inputPath),
    treePath: defaultTreePath(inputPath),
    treeValidationPath: defaultTreeValidationReportPath(inputPath)
  };
}

function findManifestRecord(
  manifest: CacheManifest,
  document: string,
  inputPath: string
): CacheManifestRecord | undefined {
  const relativeInputPath = relativePath(inputPath);
  return manifest.documents.find((record) => record.document === document || record.inputPath === relativeInputPath);
}

async function readTreeSourceMarkdownHash(treePath: string): Promise<string | undefined> {
  const payload = await readOptionalJson<Record<string, unknown>>(treePath);
  const cache = recordValue(payload?.cache);
  return stringValue(cache?.sourceMarkdownSha256);
}

async function summarizeSectionMap(sectionsPath: string): Promise<{ documentType: DocumentCacheType; hsSectionCount: number }> {
  const payload = await readOptionalJson<Record<string, unknown>>(sectionsPath);
  const sections = Array.isArray(payload?.sections) ? payload.sections : Array.isArray(payload) ? payload : [];
  const rawDocumentType = stringValue(payload?.documentType);
  const documentType: DocumentCacheType =
    rawDocumentType === "non-hs-reference" || sections.length === 0 ? "non-hs-reference" : "hs-chapter";
  return {
    documentType,
    hsSectionCount: sections.length
  };
}

async function countPngAssets(assetDir: string): Promise<number> {
  const dirStat = await stat(assetDir).catch(() => undefined);
  if (!dirStat?.isDirectory()) {
    return 0;
  }

  const entries = await readdir(assetDir, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".png")).length;
}

async function readOptionalJson<T>(filePath: string): Promise<T | undefined> {
  const text = await readFile(filePath, "utf8").catch(() => "");
  if (!text.trim()) {
    return undefined;
  }
  return JSON.parse(text) as T;
}

function isCacheManifestRecord(value: unknown): value is CacheManifestRecord {
  return typeof value === "object" && value !== null && stringValue((value as { document?: unknown }).document) !== undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeHash(value: unknown): string | undefined {
  const text = stringValue(value);
  return text && /^[a-f0-9]{64}$/i.test(text) ? text.toLowerCase() : undefined;
}

function relativePath(filePath: string): string {
  return path.relative(process.cwd(), path.resolve(filePath)).replace(/\\/g, "/");
}
