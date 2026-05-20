import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import express from "express";
import multer from "multer";
import {
  getCacheManifestRecord,
  inspectDocumentCache,
  sha256File,
  type PageIndexCacheStatus
} from "../cache/cacheManifest";
import {
  canWriteSecretsFromUi,
  getApiSettingsStatus,
  isGeminiKeySlotName,
  loadEnvConfig,
  maskSecret,
  resolvePageIndexSettings,
  saveBifrostSettingsToEnv,
  saveGeminiApiKeyToEnv,
  saveGeminiKeySlotEnabledToEnv,
  saveGeminiKeySlotToEnv,
  savePageIndexApiKeyToEnv
} from "../config";
import { PageIndexClient } from "../api";
import {
  defaultBlocksPath,
  defaultOutputPath,
  defaultSectionMapPath,
  defaultTreePath,
  defaultTreeValidationReportPath,
  defaultValidationReportPath,
  ensureDirectory
} from "../utils/paths";
import { JobStore } from "./jobStore";
import { buildMappingPayload, listMappingDocuments } from "./mapping";
import { runPipelineProcess } from "./pipelineProcessRunner";
import {
  normalizeSourceWhitespace,
  pdfUrlForDocument,
  publicSectionCitation,
  renderSourceErrorHtml,
  renderSourceTextHtml,
  sourceScoringTokens,
  sourceTextFromSection,
  sourceTextIncludesQuery,
  withPdfCitationLinks,
  withPdfCitationLinksList,
  type SourceTextView
} from "./source";
import { QAValidator } from "../validators/qaValidator";
import { createLlmClient, getLlmAvailability, type LlmClient } from "../agent/llmFactory";
import {
  buildStructuredRetrievedContext,
  detectContrastTerms,
  evaluateCandidateRelevance,
  extractQuerySignals,
  enrichRetrievedHit,
  hasSectionHsMetadata,
  hsCodesForSection,
  HS_CODE_PATTERN,
  normalizeSectionMetadata,
  propagateGroupedSectionPageRanges,
  rankSectionsForQuestion,
  selectRelevantSections,
  selectAlternativeSections,
  type CandidateRelevance,
  type EnrichedRetrievedSection,
  type QuerySignals,
  type RetrievedTreeHit,
  type ScoreBreakdown,
  type SectionMetadata,
  type ValidatedCandidate
} from "../agent/qaAnswerFormatter";
import {
  handleClarificationNeeded,
  handleChapterSummary,
  handleDefinition,
  handleDocumentSummary,
  handleExactHsCodeLookup,
  handleProductClassification,
  handleSelectedSectionQa,
  asksForHsCodeOrClassification,
  detectIntent,
  detectAmbiguousLookup,
  detectBroadQuery,
  extractLocalSelectedSectionAnswer,
  sanitizeFinalAnswer,
  type RoutedQaAnswer,
  type QaAnswerGenerationMode,
  type LocalSelectedSectionAnswer,
  type QaDocumentMetadata
} from "../agent/qaIntentRouter";
import { TokenValidator } from "../validators/tokenValidator";
import {
  expandQueryForRetrievalWithDebug,
  type QueryExpansionDebug,
  type QueryExpansionResult,
  type QueryExpansionProvider,
  type QueryExpansionRuntimeConfig
} from "../agent/queryExpansion";
import { generateLocalAnswer, type LocalAnswerResult } from "../agent/localAnswerGenerator";

const uploadsDir = path.resolve(process.cwd(), "data", "uploads");
const convertedDir = path.resolve(process.cwd(), "data", "converted");
const assetsRoot = path.resolve(process.cwd(), "data", "converted", "assets");
const tmpDir = path.resolve(process.cwd(), "data", "tmp");
const MAX_UPLOAD_FILE_BYTES = 100 * 1024 * 1024;
const MAX_UPLOAD_TOTAL_BYTES = 500 * 1024 * 1024;
const MAX_UPLOAD_FILES = 50;
const SAFE_SELECTED_SECTION_FALLBACK = "Tôi đã tìm thấy section liên quan, nhưng chưa thể trích xuất câu trả lời từ nội dung section. Vui lòng thử lại hoặc bật API key.";
const MISSING_SECTION_TEXT_FALLBACK = "Tìm thấy section liên quan nhưng thiếu nội dung chi tiết để trả lời.";
const SEARCH_STOPWORDS = new Set([
  "the",
  "and",
  "are",
  "for",
  "with",
  "what",
  "which",
  "define",
  "defined",
  "definition",
  "duoc",
  "dinh",
  "nghia",
  "gi",
  "la",
  "loai",
  "co",
  "ca",
  "phe",
  "more",
  "less",
  "than",
  "has",
  "have",
  "having",
  "compared",
  "compare",
  "cua",
  "cho",
  "thuoc",
  "trong",
  "mot",
  "cac"
]);

interface CachedTreeRetrievalResult {
  hits: EnrichedRetrievedSection[];
  retrievalSource: "pageindex-tree" | "cached-pageindex-tree" | "local-sections" | "bm25-fallback";
  bm25FallbackUsed: boolean;
  pageIndexResultCount: number;
  contrastTerms: string[];
  signals: QuerySignals;
  pageIndexResults: CandidateRelevance[];
  bm25Results: CandidateRelevance[];
}

type PublicIndexSource = "fresh_cached_tree" | "stale_cached_tree" | "local_sections" | "bm25_fallback" | "pageindex_live" | "unknown";
type AnswerStyleOption = "class-eval" | "verbose";

interface CacheFreshnessSummary {
  fresh: string[];
  stale: string[];
  missing: string[];
}

type QaScopeMode = "all" | "selected";

interface QaScopeSummary {
  mode: QaScopeMode;
  requestedDocuments: string[];
  allowedDocuments: string[];
  filteredOutCandidateCount: number;
}

interface QaScopeTracker {
  mode: QaScopeMode;
  requestedDocuments: string[];
  allowedDocuments: string[];
  allowedDocumentSet: Set<string>;
  filteredOutCandidateCount: number;
}

interface CachedTreeDocument {
  document: string;
  docId?: string;
  treePath: string;
  pageIndexCacheStatus: PageIndexCacheStatus;
  treeSourceMarkdownHash?: string | null;
  markdownHash?: string | null;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => {
      ensureDirectory(uploadsDir)
        .then(() => callback(null, uploadsDir))
        .catch((error) => callback(error as Error, uploadsDir));
    },
    filename: (_req, file, callback) => {
      callback(null, safePdfFileName(file.originalname));
    }
  }),
  fileFilter: (_req, file, callback) => {
    const isPdf = path.extname(file.originalname).toLowerCase() === ".pdf";
    if (!isPdf) {
      callback(new Error("Only .pdf files are accepted."));
      return;
    }
    callback(null, true);
  },
  limits: {
    files: MAX_UPLOAD_FILES,
    fileSize: MAX_UPLOAD_FILE_BYTES,
    fields: 100,
    fieldSize: 5 * 1024 * 1024,
    parts: MAX_UPLOAD_FILES + 100
  }
});
const runPipelineUpload = upload.any();

export function createApiRouter(): express.Router {
  const router = express.Router();

  router.get("/settings", (_req, res) => {
    res.json(getApiSettingsStatus());
  });

  router.post("/settings/pageindex-key", async (req, res) => {
    try {
      if (!canWriteSecretsFromUi()) {
        res.status(403).json({ error: "Secret write is disabled. Set env variables outside the UI." });
        return;
      }
      const apiKey = stringValue(req.body.apiKey);
      if (!apiKey) {
        res.status(400).json({ error: "PageIndex API key is required." });
        return;
      }

      const result = await savePageIndexApiKeyToEnv(apiKey);
      res.json({ ok: true, maskedKey: result.maskedKey });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/settings/gemini-key", async (req, res) => {
    try {
      if (!canWriteSecretsFromUi()) {
        res.status(403).json({ error: "Secret write is disabled. Set env variables outside the UI." });
        return;
      }
      const apiKey = stringValue(req.body.apiKey);
      const slot = stringValue(req.body.slot);
      if (!apiKey) {
        res.status(400).json({ error: "Gemini API key is required." });
        return;
      }

      if (slot) {
        if (!isGeminiKeySlotName(slot)) {
          res.status(400).json({ error: "Invalid Gemini key slot." });
          return;
        }

        const result = await saveGeminiKeySlotToEnv(slot, apiKey);
        res.json({ ok: true, maskedKey: result.maskedKey, slotName: result.slotName });
        return;
      }

      const result = await saveGeminiApiKeyToEnv(apiKey);
      res.json({ ok: true, maskedKey: result.maskedKey, slotName: "GEMINI_API_KEY" });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/settings/gemini-key-enabled", async (req, res) => {
    try {
      if (!canWriteSecretsFromUi()) {
        res.status(403).json({ error: "Secret write is disabled. Set env variables outside the UI." });
        return;
      }
      const slot = stringValue(req.body.slot);
      if (!isGeminiKeySlotName(slot)) {
        res.status(400).json({ error: "Invalid Gemini key slot." });
        return;
      }

      const result = await saveGeminiKeySlotEnabledToEnv(slot, booleanValue(req.body.enabled));
      res.json({ ok: true, slotName: result.slotName, enabled: result.enabled });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/settings/bifrost", async (req, res) => {
    try {
      if (!canWriteSecretsFromUi()) {
        res.status(403).json({ error: "Secret write is disabled. Set env variables outside the UI." });
        return;
      }

      const rawProvider = stringValue(req.body.llmProvider);
      const llmProvider = rawProvider === "gemini" || rawProvider === "bifrost" ? rawProvider : undefined;
      if (rawProvider && !llmProvider) {
        res.status(400).json({ error: "Invalid LLM provider." });
        return;
      }
      const rawQueryExpansionProvider = stringValue(req.body.queryExpansionProvider);
      const queryExpansionProvider =
        rawQueryExpansionProvider === "none" ||
        rawQueryExpansionProvider === "gemini" ||
        rawQueryExpansionProvider === "openai" ||
        rawQueryExpansionProvider === "translation"
          ? rawQueryExpansionProvider
          : undefined;
      if (rawQueryExpansionProvider && !queryExpansionProvider) {
        res.status(400).json({ error: "Invalid query expansion provider." });
        return;
      }

      const result = await saveBifrostSettingsToEnv({
        apiKey: stringValue(req.body.apiKey),
        baseUrl: stringValue(req.body.baseUrl),
        model: stringValue(req.body.model),
        llmProvider,
        enableLlmQa: hasOwn(req.body, "enableLlmQa") ? booleanValue(req.body.enableLlmQa) : undefined,
        enableLlmQueryExpansion: hasOwn(req.body, "enableLlmQueryExpansion")
          ? booleanValue(req.body.enableLlmQueryExpansion)
          : undefined,
        queryExpansionProvider
      });
      res.json({ ok: true, ...result });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/cache-status", async (req, res) => {
    try {
      const files = parseCacheStatusFiles(req.body.files);
      const documents = [];
      for (const file of files) {
        const document = safePdfFileName(file.name);
        const inputPath = path.join(uploadsDir, document);
        const inspection = await inspectDocumentCache(inputPath, {
          inputHash: file.inputHash,
          inputSize: file.size,
          inputModifiedAt: file.lastModified ? new Date(file.lastModified).toISOString() : undefined
        });
        documents.push({
          document,
          originalName: file.name,
          size: file.size,
          inputHash: inspection.inputHash,
          inputPath: inspection.inputPath,
          canReuseUploadedInput: inspection.canReuseUploadedInput,
          parseCacheStatus: inspection.parseStatus,
          pageIndexCacheStatus: inspection.pageIndexCacheStatus,
          treeStatus: inspection.treeStatus,
          assets: inspection.imageCount,
          sections: inspection.hsSectionCount,
          hasMarkdown: inspection.hasMarkdown,
          hasSections: inspection.hasSections,
          hasTree: inspection.hasTree,
          markdownHash: inspection.markdownHash,
          treeSourceMarkdownHash: inspection.treeSourceMarkdownHash,
          error: inspection.record?.error ?? null
        });
      }
      res.json({ ok: true, documents });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/run-pipeline", handleRunPipelineUpload, async (req, res) => {
    const startedAt = Date.now();
    try {
      const files = (req.files ?? []) as Express.Multer.File[];
      const pdfFiles = files.filter((file) => file.fieldname === "pdf" || file.fieldname === "files" || file.fieldname === "files[]");
      const uploadedBytes = pdfFiles.reduce((sum, file) => sum + file.size, 0);
      serverTrace("routes.runPipeline", "request started", {
        fileCount: pdfFiles.length,
        totalUploadBytes: uploadedBytes,
        elapsedMs: Date.now() - startedAt
      });
      const cachedFiles = parseCachedRunFiles(req.body.cachedFiles);
      const cachedInputFiles = await resolveCachedRunFiles(cachedFiles);
      if (uploadedBytes > MAX_UPLOAD_TOTAL_BYTES) {
        res.status(400).json({ ok: false, error: `PDF upload is too large. Max total upload size is ${formatBytes(MAX_UPLOAD_TOTAL_BYTES)}.` });
        return;
      }
      if (pdfFiles.length + cachedInputFiles.length === 0) {
        res.status(400).json({ ok: false, error: "At least one PDF file is required." });
        return;
      }
      const config = loadEnvConfig();
      if (JobStore.activeCount() >= config.maxConcurrentJobs) {
        serverTrace("routes.runPipeline", "request rejected by concurrency guard", {
          activeJobs: JobStore.activeCount(),
          maxConcurrentJobs: config.maxConcurrentJobs
        });
        res.status(429).json({ ok: false, error: "Another pipeline job is already running. Please wait or cancel it." });
        return;
      }

      const inputFiles = uniqueStrings([...pdfFiles.map((file) => file.path), ...cachedInputFiles]);
      const job = JobStore.create(inputFiles);
      JobStore.addTrace(job.id, "routes.runPipeline", "request accepted", {
        uploadedFileCount: pdfFiles.length,
        cachedFileCount: cachedInputFiles.length,
        fileCount: inputFiles.length,
        uploadedBytes,
        elapsedMs: Date.now() - startedAt
      });
      for (const file of pdfFiles) {
        JobStore.addTrace(job.id, "routes.runPipeline", "file saved", {
          filename: file.filename,
          bytes: file.size,
          path: relativePath(file.path)
        });
        JobStore.setFileStep(job.id, file.filename, "file saved");
      }
      for (const inputFile of cachedInputFiles) {
        JobStore.addTrace(job.id, "routes.runPipeline", "cached input reused", {
          filename: path.basename(inputFile),
          path: relativePath(inputFile)
        });
        JobStore.setFileStep(job.id, path.basename(inputFile), "cached input reused");
      }
      const reuseCachedPageIndexTree =
        req.body.reuseCachedPageIndexTree !== undefined
          ? booleanValue(req.body.reuseCachedPageIndexTree)
          : req.body.reusePageIndexCache !== undefined
            ? booleanValue(req.body.reusePageIndexCache)
            : true;
      const options = {
        ocrLanguage: stringValue(req.body.ocrLang) ?? stringValue(req.body.ocrLanguage) ?? "vie+eng",
        doclingThreads: numberValue(req.body.doclingThreads) ?? 4,
        exportAssets: booleanValue(req.body.exportAssets),
        uploadPageIndex: booleanValue(req.body.uploadPageIndex),
        reuseParsedCache: req.body.reuseParsedCache === undefined ? true : booleanValue(req.body.reuseParsedCache),
        reuseCachedPageIndexTree,
        forceReparse: booleanValue(req.body.forceReparse),
        forcePageIndexUpload: booleanValue(req.body.forcePageIndexUpload),
        failFast: booleanValue(req.body.failFast),
        pageIndexApiKey: stringValue(req.body.temporaryPageIndexApiKey) ?? stringValue(req.body.pageIndexApiKey),
        geminiApiKey: firstStringValue(
          req.body.temporaryGeminiApiKey1,
          req.body.temporaryGeminiApiKey2,
          req.body.temporaryGeminiApiKey3,
          req.body.temporaryGeminiApiKey,
          req.body.geminiApiKey
        )
      };

      JobStore.addTrace(job.id, "routes.runPipeline", "options resolved", {
        ocrLanguage: options.ocrLanguage,
        doclingThreads: options.doclingThreads,
        exportAssets: options.exportAssets,
        uploadPageIndex: options.uploadPageIndex,
        reuseParsedCache: options.reuseParsedCache,
        reuseCachedPageIndexTree: options.reuseCachedPageIndexTree,
        forceReparse: options.forceReparse,
        forcePageIndexUpload: Boolean(options.forcePageIndexUpload),
        failFast: options.failFast,
        hasTemporaryPageIndexKey: Boolean(options.pageIndexApiKey),
        hasTemporaryGeminiKey: Boolean(options.geminiApiKey)
      });

      void runJob(job.id, inputFiles, options);
      JobStore.addTrace(job.id, "routes.runPipeline", "response sent", { jobId: job.id });
      res.json({
        ok: true,
        jobId: job.id,
        pageIndexKey: options.pageIndexApiKey ? maskSecret(options.pageIndexApiKey) : undefined,
        geminiKey: options.geminiApiKey ? maskSecret(options.geminiApiKey) : undefined
      });
    } catch (error) {
      serverTrace("routes.runPipeline", "request rejected", {
        elapsedMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error)
      });
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get("/status/:jobId", (req, res) => {
    const job = JobStore.snapshot(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "Job not found." });
      return;
    }

    res.json(job);
  });

  router.get("/result/:jobId", (req, res) => {
    const job = JobStore.get(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "Job not found." });
      return;
    }

    const documents = documentSummaries(job.outputs);
    res.json({
      id: job.id,
      status: job.status,
      error: job.error,
      documents,
      selectedDocument: documents[0]?.document,
      outputs: job.outputs
    });
  });

  router.get("/result/:jobId/document/:documentName", async (req, res) => {
    const job = JobStore.get(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "Job not found." });
      return;
    }

    const file = job.files.find((candidate) => candidate.filename === req.params.documentName);
    if (!file) {
      res.status(404).json({ error: "Document not found." });
      return;
    }

    const status = file.status === "failed" ? "failed" : "passed";
    res.json(await buildDocumentBundle(file.inputFile, true, status, file.error));
  });

  router.get("/pageindex-documents", async (_req, res) => {
    try {
      res.json({ documents: await listCachedTreeDocuments() });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get("/mapping", async (_req, res) => {
    try {
      res.json({ documents: await listMappingDocuments() });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get("/mapping/:documentName", async (req, res) => {
    try {
      res.json(await buildMappingPayload(req.params.documentName));
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get("/mapping/:documentName/page/:pageNumber", async (req, res) => {
    try {
      const pageNumber = Number(req.params.pageNumber);
      if (!Number.isInteger(pageNumber) || pageNumber < 1) {
        res.status(400).json({ ok: false, error: "Invalid page number." });
        return;
      }

      const payload = await buildMappingPayload(req.params.documentName, pageNumber);
      res.json({
        document: payload.document,
        pageNumber,
        blocks: payload.blocks
      });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get("/source/:documentName", async (req, res) => {
    try {
      const sourceView = await buildSourceTextView(req.params.documentName, {
        query: stringValue(req.query.q),
        hsCode: stringValue(req.query.hsCode),
        section: stringValue(req.query.section),
        page: numberFromUnknown(req.query.page)
      });
      res.type("html").send(renderSourceTextHtml(sourceView));
    } catch (error) {
      res.status(400).type("html").send(renderSourceErrorHtml(error instanceof Error ? error.message : String(error)));
    }
  });

  router.get("/uploads/:filename", (req, res) => {
    const fileName = req.params.filename;
    if (fileName !== path.basename(fileName) || path.extname(fileName).toLowerCase() !== ".pdf") {
      res.status(400).json({ error: "Invalid PDF filename." });
      return;
    }

    const filePath = path.resolve(uploadsDir, fileName);
    if (!filePath.startsWith(`${uploadsDir}${path.sep}`)) {
      res.status(400).json({ error: "Invalid PDF filename." });
      return;
    }

    res.sendFile(filePath, (error) => {
      if (error && !res.headersSent) {
        res.status(404).json({ error: "PDF not found." });
      }
    });
  });

  router.post("/ask", async (req, res) => {
    const startedAt = Date.now();
    try {
      const question = stringValue(req.body.question);
      const requestGeminiApiKeys = stringListValue(req.body.geminiApiKeys);
      const requestedDocIds = uniqueStrings([
        ...stringListValue(req.body.docIds),
        ...splitDocIds(stringValue(req.body.docId))
      ]);
      const requestedCachedTreeDocuments = uniqueStrings([
        ...stringListValue(req.body.cachedTreeDocuments),
        ...splitDocIds(stringValue(req.body.cachedTreeDocument))
      ]);
      const cachedDocIds =
        stringValue(req.body.scope) === "all"
          ? (await listCachedTreeDocuments())
              .map((document) => document.docId)
              .filter((docId): docId is string => Boolean(docId))
          : [];
      const docIds = uniqueStrings([...requestedDocIds, ...cachedDocIds]);
      if (!question) {
        res.status(400).json({ error: "Question is required." });
        return;
      }
      serverTrace("routes.ask", "request accepted", {
        scope: stringValue(req.body.scope) ?? "selected",
        requestedDocIds: requestedDocIds.length,
        requestedCachedTreeDocuments: requestedCachedTreeDocuments.length,
        cachedDocIds: cachedDocIds.length,
        overrideGeminiKeys: requestGeminiApiKeys.length
      });
      const requestScope = stringValue(req.body.scope) ?? "selected";
      if (requestScope === "all") {
        const cachedAnswer = await answerFromCachedTrees(question, {
          geminiApiKeys: requestGeminiApiKeys.length > 0 ? requestGeminiApiKeys : undefined,
          debug: booleanValue(req.body.debug),
          answerStyle: parseAnswerStyle(req.body.answerStyle)
        });
        serverTrace("routes.ask", "cached-tree answer sent", { elapsedMs: Date.now() - startedAt });
        res.json(cachedAnswer);
        return;
      }

      if (requestScope === "cached-tree-selected") {
        if (requestedCachedTreeDocuments.length === 0) {
          res.status(400).json({ error: "No cached tree document was selected." });
          return;
        }
        const cachedAnswer = await answerFromCachedTrees(question, {
          geminiApiKeys: requestGeminiApiKeys.length > 0 ? requestGeminiApiKeys : undefined,
          debug: booleanValue(req.body.debug),
          cachedTreeDocuments: requestedCachedTreeDocuments,
          answerStyle: parseAnswerStyle(req.body.answerStyle)
        });
        serverTrace("routes.ask", "selected cached-tree answer sent", { elapsedMs: Date.now() - startedAt });
        res.json(cachedAnswer);
        return;
      }

      if (requestScope === "local-sections") {
        const cachedAnswer = await answerFromCachedTrees(question, {
          geminiApiKeys: requestGeminiApiKeys.length > 0 ? requestGeminiApiKeys : undefined,
          debug: booleanValue(req.body.debug),
          localSectionDocuments: splitDocIds(stringValue(req.body.document)),
          answerStyle: parseAnswerStyle(req.body.answerStyle)
        });
        serverTrace("routes.ask", "local-section answer sent", { elapsedMs: Date.now() - startedAt });
        res.json({ ...cachedAnswer, mode: "local-sections" });
        return;
      }

      if (docIds.length === 0) {
        res.status(400).json({ error: "No PageIndex doc_id found. Use all cached tree scope or paste doc_id manually." });
        return;
      }

      const settings = resolvePageIndexSettings({
        apiKey: stringValue(req.body.temporaryPageIndexApiKey) ?? stringValue(req.body.pageIndexApiKey),
        baseUrl: stringValue(req.body.pageIndexBaseUrl)
      });
      const client = new PageIndexClient(settings.pageIndexApiKey, {
        baseUrl: settings.pageIndexBaseUrl
      });
      const chat = await client.chatCompletion({
        docId: docIds.length === 1 ? docIds[0] : docIds,
        temperature: 0.1,
        enableCitations: true,
        messages: [
          {
            role: "system",
            content: "Answer HSCode questions using all selected PageIndex documents and include inline citations."
          },
          {
            role: "user",
            content: question
          }
        ]
      });
      const validation = QAValidator.validateResponse(chat.answer);
      serverTrace("routes.ask", "pageindex chat answer sent", {
        docIds: docIds.length,
        elapsedMs: Date.now() - startedAt
      });

      res.json({
        answer: chat.answer,
        docIds,
        scope: {
          mode: docIds.length > 0 ? "selected" : "all",
          requestedDocuments: requestedDocIds,
          allowedDocuments: docIds,
          filteredOutCandidateCount: 0
        },
        indexSource: "pageindex_live",
        indexSourceDetails: {
          label: "Fresh PageIndex tree",
          source: "pageindex-chat",
          cachedDocumentCount: 0,
          documents: docIds.map((docId) => ({ docId, status: "remote-pageindex" }))
        },
        cachedDocumentCount: 0,
        cacheFreshness: { fresh: [], stale: [], missing: [] },
        pageIndexUploadStatus: "fresh",
        validation
      });
    } catch (error) {
      serverTrace("routes.ask", "request failed", {
        elapsedMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error)
      });
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}

function handleRunPipelineUpload(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  const startedAt = Date.now();
  let uploadFinished = false;
  serverTrace("handleRunPipelineUpload", "upload started", {
    contentLength: req.headers["content-length"] ?? "unknown"
  });
  req.on("aborted", () => {
    serverTrace("handleRunPipelineUpload", "request aborted", {
      elapsedMs: Date.now() - startedAt
    });
  });
  req.on("close", () => {
    const requestState = req as express.Request & { readableAborted?: boolean; aborted?: boolean };
    if (!uploadFinished && !res.writableEnded && (requestState.readableAborted || requestState.aborted)) {
      serverTrace("handleRunPipelineUpload", "client disconnected", {
        elapsedMs: Date.now() - startedAt
      });
    }
  });
  req.on("error", (error) => {
    serverTrace("handleRunPipelineUpload", "request stream error", {
      elapsedMs: Date.now() - startedAt,
      error: error.message
    });
  });
  runPipelineUpload(req, res, (error: unknown) => {
    if (!error) {
      const files = Array.isArray(req.files) ? req.files as Express.Multer.File[] : [];
      uploadFinished = true;
      serverTrace("handleRunPipelineUpload", "upload finished", {
        fileCount: files.length,
        totalBytes: files.reduce((sum, file) => sum + file.size, 0),
        elapsedMs: Date.now() - startedAt
      });
      next();
      return;
    }

    uploadFinished = true;
    sendUploadError(error, res, Date.now() - startedAt);
  });
}

function sendUploadError(error: unknown, res: express.Response, elapsedMs: number): void {
  if (res.headersSent || res.writableEnded) {
    return;
  }

  if (isRequestAbortedError(error)) {
    serverTrace("sendUploadError", "request aborted before all files were received", { elapsedMs });
    res.status(499).json({
      ok: false,
      error: "Upload request was aborted before the server finished receiving files. Keep the tab open and retry."
    });
    return;
  }

  if (error instanceof multer.MulterError) {
    serverTrace("sendUploadError", "multipart error", {
      code: error.code,
      elapsedMs
    });
    res.status(400).json({ ok: false, error: uploadMulterErrorMessage(error) });
    return;
  }

  serverTrace("sendUploadError", "multipart error", {
    elapsedMs,
    error: error instanceof Error ? error.message : String(error)
  });
  res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
}

function isRequestAbortedError(error: unknown): boolean {
  const record = error as { code?: unknown; message?: unknown };
  return record.code === "ECONNABORTED" || record.code === "ECONNRESET" || record.message === "Request aborted";
}

function uploadMulterErrorMessage(error: multer.MulterError): string {
  if (error.code === "LIMIT_FILE_SIZE") {
    return `PDF upload is too large. Max file size is ${formatBytes(MAX_UPLOAD_FILE_BYTES)} per file.`;
  }
  if (error.code === "LIMIT_FILE_COUNT") {
    return `Too many PDFs selected. Max is ${MAX_UPLOAD_FILES} files per run.`;
  }
  return error.message;
}

async function runJob(
  jobId: string,
  inputFiles: string[],
  options: {
    ocrLanguage: string;
    doclingThreads: number;
    exportAssets: boolean;
    uploadPageIndex: boolean;
    reuseParsedCache: boolean;
    reuseCachedPageIndexTree: boolean;
    forceReparse: boolean;
    forcePageIndexUpload?: boolean;
    failFast: boolean;
    pageIndexApiKey?: string;
    geminiApiKey?: string;
  }
): Promise<void> {
  const documentOutputs: Record<string, unknown>[] = [];
  let lastCommand: string | undefined;
  const jobStartedAt = Date.now();
  try {
    const config = loadEnvConfig();
    JobStore.addTrace(jobId, "runJob", "job started", {
      totalFiles: inputFiles.length,
      timeoutMs: config.uiPipelineTimeoutMs
    });
    JobStore.setRunning(jobId, "parse started");

    for (const [index, inputFile] of inputFiles.entries()) {
      const filename = path.basename(inputFile);
      let command: string | undefined;
      const fileStartedAt = Date.now();
      try {
        JobStore.addTrace(jobId, "runJob", "file started", {
          index: index + 1,
          totalFiles: inputFiles.length,
          filename
        });
        JobStore.startFile(jobId, filename, "parse started");
        const result = await runPipelineProcess({
          inputFile,
          ...options,
          timeoutMs: config.uiPipelineTimeoutMs,
          onLog: (message) => JobStore.addLog(jobId, `${filename}: ${message}`),
          onStep: (step) => {
            JobStore.addTrace(jobId, "runPipelineProcess.onStep", "step inferred", { filename, step });
            JobStore.setFileStep(jobId, filename, step);
          }
        });
        command = result.command;
        lastCommand = command;
        JobStore.addTrace(jobId, "runJob", "process finished", {
          filename,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          elapsedMs: Date.now() - fileStartedAt
        });

        if (result.timedOut) {
          throw new Error(`UI pipeline job timed out after ${config.uiPipelineTimeoutMs}ms. Child process was killed.`);
        }

        if (result.exitCode !== 0) {
          throw new Error(`Pipeline command failed with exit code ${result.exitCode}.`);
        }

        const bundleStartedAt = Date.now();
        JobStore.addTrace(jobId, "buildDocumentBundle", "started", { filename, status: "passed" });
        const outputs = await buildDocumentBundle(inputFile, options.uploadPageIndex, "passed");
        JobStore.addTrace(jobId, "buildDocumentBundle", "completed", {
          filename,
          hsSections: outputs.hsSectionCount,
          images: outputs.imageCount,
          hasTree: outputs.hasTree,
          pageIndex: outputs.pageIndex,
          elapsedMs: Date.now() - bundleStartedAt
        });
        documentOutputs.push(outputs);
        JobStore.completeFile(jobId, filename, outputs);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        JobStore.addTrace(jobId, "runJob", "file failed", {
          filename,
          elapsedMs: Date.now() - fileStartedAt,
          error: message
        });
        await saveJobDebugLog(jobId, inputFile, command, message);
        const bundleStartedAt = Date.now();
        JobStore.addTrace(jobId, "buildDocumentBundle", "started", { filename, status: "failed" });
        const outputs = await buildDocumentBundle(inputFile, options.uploadPageIndex, "failed", message);
        JobStore.addTrace(jobId, "buildDocumentBundle", "completed", {
          filename,
          hsSections: outputs.hsSectionCount,
          images: outputs.imageCount,
          hasTree: outputs.hasTree,
          pageIndex: outputs.pageIndex,
          elapsedMs: Date.now() - bundleStartedAt
        });
        documentOutputs.push(outputs);
        JobStore.failFile(jobId, filename, message, outputs);
        if (options.failFast) {
          JobStore.addTrace(jobId, "runJob", "failFast stopping batch", { filename });
          break;
        }
      }
    }

    const batchStartedAt = Date.now();
    JobStore.addTrace(jobId, "buildBatchOutputs", "started", { documentCount: documentOutputs.length });
    const outputs = await buildBatchOutputs(documentOutputs);
    JobStore.addTrace(jobId, "buildBatchOutputs", "completed", {
      documentCount: documentOutputs.length,
      elapsedMs: Date.now() - batchStartedAt
    });
    JobStore.setOutputs(jobId, outputs);
    const hasFailure = documentOutputs.some((document) => document.status === "failed");
    if (hasFailure && options.failFast) {
      JobStore.fail(jobId, "Batch stopped on first failure.");
      return;
    }
    JobStore.addTrace(jobId, "runJob", "job completed", { elapsedMs: Date.now() - jobStartedAt });
    JobStore.complete(jobId, outputs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    JobStore.addTrace(jobId, "runJob", "job failed", {
      elapsedMs: Date.now() - jobStartedAt,
      error: message
    });
    await saveJobDebugLog(jobId, inputFiles[0] ?? "batch", lastCommand, message);
    JobStore.fail(jobId, message);
  }
}

async function buildDocumentBundle(
  inputFile: string,
  uploadPageIndex: boolean,
  status: "passed" | "failed",
  error: string | null = null
): Promise<Record<string, unknown>> {
  const markdownPath = defaultOutputPath(inputFile);
  const blocksPath = defaultBlocksPath(inputFile);
  const validationPath = defaultValidationReportPath(inputFile);
  const sectionMapPath = defaultSectionMapPath(inputFile);
  const treePath = defaultTreePath(inputFile);
  const treeValidationPath = defaultTreeValidationReportPath(inputFile);
  const assetDir = path.resolve(assetsRoot, path.basename(inputFile, path.extname(inputFile)));
  const markdown = await readOptionalText(markdownPath);
  const validation = await readOptionalJson<ValidationJson>(validationPath);
  const sectionMap = await readOptionalJson<SectionMapJson>(sectionMapPath);
  const treeValidation = await readOptionalJson<ValidationJson>(treeValidationPath);
  const treeJson = await readOptionalJson<{ docId?: string; tree?: unknown[] }>(treePath);
  const cacheInspection = await inspectDocumentCache(inputFile);
  const cacheRecord = await getCacheManifestRecord(path.basename(inputFile));
  const imageFiles = await listPngAssets(assetDir);
  const validationMarkers = (validation?.markers ?? []).map((marker) => ({
    marker: marker.marker,
    passed: marker.passed,
    message: marker.message,
    details: marker.details
  }));
  const treeValidationMarkers = treeValidation?.markers.map((marker) => ({
    marker: marker.marker,
    passed: marker.passed,
    message: marker.message,
    details: marker.details
  })) ?? [];
  const pageIndexCacheHit = Boolean(treeValidation?.markers.some((marker) => marker.details?.pageIndexCacheHit === true));

  return {
    document: path.basename(inputFile),
    status,
    error,
    hsSections: sectionMap?.sections.length ?? 0,
    hsSectionCount: sectionMap?.sections.length ?? 0,
    imagesExported: imageFiles.length,
    imageCount: imageFiles.length,
    hasTree: Boolean(treeJson),
    parseCacheStatus: cacheInspection.parseStatus,
    pageIndexCacheStatus: cacheInspection.pageIndexCacheStatus,
    pageIndexStatus: cacheRecord?.pageIndexStatus ?? (uploadPageIndex ? cacheInspection.pageIndexCacheStatus : "skipped"),
    treeStatus: cacheInspection.treeStatus,
    parseCacheStatusBefore: cacheRecord?.parseCacheStatusBefore,
    parseAction: cacheRecord?.parseAction,
    pageIndexCacheStatusBefore: cacheRecord?.pageIndexCacheStatusBefore,
    pageIndexAction: cacheRecord?.pageIndexAction,
    pageIndexCacheStatusAfter: cacheRecord?.pageIndexCacheStatusAfter ?? cacheInspection.pageIndexCacheStatus,
    forcedReparse: cacheRecord?.forcedReparse ?? false,
    forcedPageIndexUpload: cacheRecord?.forcedPageIndexUpload ?? false,
    markdownHash: cacheInspection.markdownHash,
    treeSourceMarkdownHash: cacheInspection.treeSourceMarkdownHash,
    cacheManifest: cacheRecord,
    validation: {
      passed: validation?.passed ?? false,
      markers: validationMarkers
    },
    treeValidation: treeValidation
      ? {
          passed: treeValidation.passed,
          markers: treeValidationMarkers,
          warnings: treeValidation.warnings ?? []
        }
      : undefined,
    pageIndex: uploadPageIndex
      ? pageIndexCacheHit
        ? "cached"
        : treeValidation?.passed
          ? "completed"
          : treeJson
            ? "validation failed"
            : "failed"
      : "skipped",
    pageIndexDocId: treeJson?.docId ?? (treeJson as { doc_id?: string } | undefined)?.doc_id,
    uploadUrl: `/api/uploads/${encodeURIComponent(path.basename(inputFile))}`,
    paths: {
      input: relativePath(inputFile),
      markdown: relativePath(markdownPath),
      blocks: relativePath(blocksPath),
      validation: relativePath(validationPath),
      assets: imageFiles.length > 0 ? relativePath(assetDir) : undefined,
      sectionMap: relativePath(sectionMapPath),
      sections: relativePath(sectionMapPath),
      tree: treeJson ? relativePath(treePath) : uploadPageIndex ? relativePath(treePath) : undefined,
      treeValidation: treeValidation ? relativePath(treeValidationPath) : uploadPageIndex ? relativePath(treeValidationPath) : undefined
    },
    markdownPreview: markdown.slice(0, 50000),
    markdown,
    sections: sectionMap?.sections ?? [],
    validationJson: validation,
    tree: treeJson,
    treeValidationJson: treeValidation,
    images: imageFiles
  };
}

async function buildBatchOutputs(documentOutputs: Record<string, unknown>[]): Promise<Record<string, unknown>> {
  const documents = documentOutputs.map((output) => ({
    document: output.document,
    status: output.status,
    hsSectionCount: output.hsSectionCount,
    imageCount: output.imageCount,
    hasTree: output.hasTree,
    pageIndex: output.pageIndex,
    parseCacheStatus: output.parseCacheStatus,
    pageIndexCacheStatus: output.pageIndexCacheStatus,
    treeStatus: output.treeStatus,
    parseCacheStatusBefore: output.parseCacheStatusBefore,
    parseAction: output.parseAction,
    pageIndexCacheStatusBefore: output.pageIndexCacheStatusBefore,
    pageIndexAction: output.pageIndexAction,
    pageIndexCacheStatusAfter: output.pageIndexCacheStatusAfter,
    forcedReparse: output.forcedReparse,
    forcedPageIndexUpload: output.forcedPageIndexUpload,
    pageIndexDocId: output.pageIndexDocId,
    error: output.error ?? null
  }));
  const allSections = documentOutputs.flatMap((output) => Array.isArray(output.sections) ? output.sections : []);
  const manifest = {
    generatedAt: new Date().toISOString(),
    documents: documentOutputs.map((output) => ({
      input: output.paths && typeof output.paths === "object" ? (output.paths as Record<string, unknown>).input : undefined,
      status: output.status,
      markdown: output.paths && typeof output.paths === "object" ? (output.paths as Record<string, unknown>).markdown : undefined,
      blocks: output.paths && typeof output.paths === "object" ? (output.paths as Record<string, unknown>).blocks : undefined,
      validation: output.paths && typeof output.paths === "object" ? (output.paths as Record<string, unknown>).validation : undefined,
      assetsDir: output.paths && typeof output.paths === "object" ? (output.paths as Record<string, unknown>).assets : undefined,
      sections: output.paths && typeof output.paths === "object" ? (output.paths as Record<string, unknown>).sectionMap : undefined,
      tree: output.paths && typeof output.paths === "object" ? (output.paths as Record<string, unknown>).tree : undefined,
      treeValidation: output.paths && typeof output.paths === "object" ? (output.paths as Record<string, unknown>).treeValidation : undefined,
      pageIndexDocId: output.pageIndexDocId,
      parseCacheStatusBefore: output.parseCacheStatusBefore,
      parseAction: output.parseAction,
      pageIndexCacheStatusBefore: output.pageIndexCacheStatusBefore,
      pageIndexAction: output.pageIndexAction,
      pageIndexCacheStatusAfter: output.pageIndexCacheStatusAfter,
      forcedReparse: output.forcedReparse ?? false,
      forcedPageIndexUpload: output.forcedPageIndexUpload ?? false,
      error: output.error ?? null
    }))
  };

  await ensureDirectory(convertedDir);
  await writeJson(path.join(convertedDir, "batch.manifest.json"), manifest);
  await writeJson(path.join(convertedDir, "all.sections.json"), allSections);
  await writeJson(path.join(convertedDir, "all.documents.json"), documents);

  return {
    documents,
    selectedDocument: typeof documents[0]?.document === "string" ? documents[0].document : undefined,
    manifestPath: "data/converted/batch.manifest.json",
    allSectionsPath: "data/converted/all.sections.json",
    allDocumentsPath: "data/converted/all.documents.json",
    documentOutputs
  };
}

async function listPngAssets(assetDir: string): Promise<Array<{ name: string; path: string; url: string; imageId: string; pageNumber?: number }>> {
  const exists = await stat(assetDir).then((item) => item.isDirectory()).catch(() => false);
  if (!exists) {
    return [];
  }

  const entries = await readdir(assetDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".png"))
    .map((entry) => {
      const absolutePath = path.join(assetDir, entry.name);
      const relativeAssetPath = path.relative(assetsRoot, absolutePath).replace(/\\/g, "/");
      return {
        name: entry.name,
        path: relativePath(absolutePath) ?? "",
        url: `/assets/${relativeAssetPath}`,
        imageId: path.basename(entry.name, path.extname(entry.name)),
        pageNumber: pageNumberFromAssetName(entry.name)
      };
    });
}

function documentSummaries(outputs: Record<string, unknown> | undefined): Array<{ document?: unknown }> {
  const documents = outputs?.documents;
  return Array.isArray(documents) ? documents as Array<{ document?: unknown }> : [];
}

async function listCachedTreeDocuments(): Promise<CachedTreeDocument[]> {
  const exists = await stat(convertedDir).then((item) => item.isDirectory()).catch(() => false);
  if (!exists) {
    return [];
  }

  const entries = await readdir(convertedDir, { withFileTypes: true });
  const documents: CachedTreeDocument[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".tree.json")) {
      continue;
    }

    const treePath = path.join(convertedDir, entry.name);
    const treeJson = await readOptionalJson<Record<string, unknown>>(treePath);
    const docId = extractCachedDocId(treeJson);
    const document = entry.name.replace(/\.tree\.json$/i, ".pdf");
    const cacheInspection = await inspectDocumentCache(path.join(uploadsDir, document));

    documents.push({
      document,
      docId,
      treePath: relativePath(treePath) ?? treePath,
      pageIndexCacheStatus: cacheInspection.pageIndexCacheStatus,
      treeSourceMarkdownHash: cacheInspection.treeSourceMarkdownHash,
      markdownHash: cacheInspection.markdownHash
    });
  }

  return documents.sort((left, right) => left.document.localeCompare(right.document));
}

function createQaScope(requestedDocuments: string[]): QaScopeTracker {
  const requested = uniqueStrings(requestedDocuments.filter(Boolean));
  const mode: QaScopeMode = requested.length > 0 ? "selected" : "all";
  return {
    mode,
    requestedDocuments: requested,
    allowedDocuments: requested,
    allowedDocumentSet: new Set(requested),
    filteredOutCandidateCount: 0
  };
}

function scopeAllowsDocument(scope: QaScopeTracker, document: string | undefined): boolean {
  if (scope.mode === "all") {
    return true;
  }
  if (document && scope.allowedDocumentSet.has(document)) {
    return true;
  }
  scope.filteredOutCandidateCount += 1;
  return false;
}

function scopeSnapshot(scope: QaScopeTracker, fallbackAllowedDocuments: string[] = []): QaScopeSummary {
  const allowedDocuments = scope.mode === "selected"
    ? scope.allowedDocuments
    : uniqueStrings(fallbackAllowedDocuments);
  return {
    mode: scope.mode,
    requestedDocuments: scope.requestedDocuments,
    allowedDocuments,
    filteredOutCandidateCount: scope.filteredOutCandidateCount
  };
}

function scopedNotFoundMessage(scope: QaScopeTracker): string | undefined {
  return scope.mode === "selected"
    ? "Không tìm thấy ngữ cảnh phù hợp trong các tài liệu đã chọn."
    : undefined;
}

function applyScopedNotFoundAnswer(routed: RoutedQaAnswer, scope: QaScopeTracker): RoutedQaAnswer {
  if (scope.mode !== "selected") {
    return routed;
  }
  const hasSelectedSection = Boolean(routed.selectedPrimary);
  const hasSummaryDocument = Boolean(routed.documentSummary?.document);
  if (hasSelectedSection || hasSummaryDocument) {
    return routed;
  }
  return {
    ...routed,
    answer: scopedNotFoundMessage(scope) ?? routed.answer
  };
}

export async function answerFromCachedTrees(
  question: string,
  options: {
    geminiApiKeys?: string[];
    debug?: boolean;
    cachedTreeDocuments?: string[];
    localSectionDocuments?: string[];
    selectedSectionAnswerer?: Pick<LlmClient, "synthesizeSectionAnswer">;
    candidateReranker?: Pick<LlmClient, "planQuery">;
    answerStyle?: AnswerStyleOption;
    enableLlmQa?: boolean;
    queryExpansionProvider?: QueryExpansionProvider;
    queryExpansionConfig?: Partial<QueryExpansionRuntimeConfig>;
  } = {}
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  const detection = detectIntent(question);
  const enableLlmQa = options.enableLlmQa ?? loadEnvConfig().enableLlmQa;
  const answerStyle = options.answerStyle ?? "class-eval";
  const selectedCachedTreeDocuments = uniqueStrings(options.cachedTreeDocuments ?? []);
  const localSectionDocuments = uniqueStrings(options.localSectionDocuments ?? []);
  const scope = createQaScope([...selectedCachedTreeDocuments, ...localSectionDocuments]);
  serverTrace("answerFromCachedTrees", "started", {
    intent: detection.intent,
    scope: scope.mode,
    overrideGeminiKeys: options.geminiApiKeys?.length ?? 0,
    enableLlmQa,
    selectedCachedTreeDocuments: selectedCachedTreeDocuments.length,
    localSectionDocuments: localSectionDocuments.length
  });
  serverTrace("qna", "query plan", {
    intent: detection.intent,
    plannerSource: detection.plannerSource,
    enableLlmQa,
    scope: scope.mode
  });
  const forceLocalSections = localSectionDocuments.length > 0 && selectedCachedTreeDocuments.length === 0;
  const cachedDocuments = forceLocalSections ? [] : await listCachedTreeDocuments();
  const selectedCachedTreeSet = new Set(selectedCachedTreeDocuments);
  const documents = selectedCachedTreeSet.size > 0
    ? cachedDocuments.filter((document) => selectedCachedTreeSet.has(document.document) && scopeAllowsDocument(scope, document.document))
    : cachedDocuments;
  const localFallbackDocuments = localSectionDocuments.length > 0 ? localSectionDocuments : selectedCachedTreeDocuments;
  serverTrace("answerFromCachedTrees", "cached tree documents loaded", {
    documentCount: documents.length,
    elapsedMs: Date.now() - startedAt
  });
  if (documents.length === 0) {
    serverTrace("answerFromCachedTrees", "no cached tree JSON; using local sections fallback", {
      elapsedMs: Date.now() - startedAt
    });
  }

  const scopedDocumentNames = documents.length > 0
    ? uniqueStrings([...documents.map((document) => document.document), ...localSectionDocuments])
    : localFallbackDocuments;
  const [sectionMetadata, documentMetadata] = await Promise.all([
    loadSectionMetadata(scopedDocumentNames, scope),
    loadDocumentMetadata(scopedDocumentNames)
  ]);
  const scopeInfo = scopeSnapshot(scope, scopedDocumentNames);
  const baseDebug = {
    detectedIntent: detection.intent,
    intentConfidence: detection.confidence,
    intentReason: detection.reason,
    queryPlan: detection.queryPlan,
    plannerSource: detection.plannerSource,
    llmCalled: false,
    llmSkippedReason: null,
    llmErrorType: null,
    sectionTextChars: 0,
    contextChars: 0,
    fallbackReason: null,
    queryExpansion: defaultQueryExpansionDebug(question),
    domainAliasTerms: extractQuerySignals(question).domainAliasTerms,
    llmRerankCalled: false,
    llmRerankSelectedHsCode: null,
    llmRerankReason: null,
    candidateAliasSignals: [],
    indexSource: {
      selectedCachedTreeDocuments,
      localSectionDocuments
    },
    cacheStatus: {
      cachedTreeDocumentCount: documents.length,
      scopedDocumentNames,
      sectionMetadataCount: sectionMetadata.length,
      documentMetadataCount: documentMetadata.length
    },
    scope: scopeInfo,
    scopeApplied: true,
    finalAnswerSanitized: true
  };
  const responseCacheInfo = buildCacheResponseFields(documents, documents.length > 0 ? "cached-pageindex-tree" : "local-sections");

  if (detection.intent === "exact_hscode_lookup") {
    const routed = handleExactHsCodeLookup(question, sectionMetadata, detection, baseDebug);
    return finalizeRoutedAnswer(applyScopedNotFoundAnswer(routed, scope), {
      mode: "cached-tree",
      documents,
      sourceDocuments: routed.selectedPrimary?.document ? [String(routed.selectedPrimary.document)] : [],
      retrieval: undefined,
      debug: options.debug,
      cacheInfo: responseCacheInfo,
      scope
    });
  }

  if (detection.intent === "chapter_summary") {
    const routed = handleChapterSummary(question, sectionMetadata, documentMetadata, detection, baseDebug);
    return finalizeRoutedAnswer(applyScopedNotFoundAnswer(routed, scope), {
      mode: "cached-tree",
      documents,
      sourceDocuments: routed.documentSummary?.document ? [String(routed.documentSummary.document)] : [],
      retrieval: undefined,
      debug: options.debug,
      cacheInfo: responseCacheInfo,
      scope
    });
  }

  if (detection.intent === "document_summary") {
    const routed = handleDocumentSummary(question, sectionMetadata, documentMetadata, detection, baseDebug);
    return finalizeRoutedAnswer(applyScopedNotFoundAnswer(routed, scope), {
      mode: "cached-tree",
      documents,
      sourceDocuments: routed.documentSummary?.document ? [String(routed.documentSummary.document)] : [],
      retrieval: undefined,
      debug: options.debug,
      cacheInfo: responseCacheInfo,
      scope
    });
  }

  if (isNumericOnlyQuestion(question)) {
    const routed = handleClarificationNeeded(question, detection, baseDebug);
    return finalizeRoutedAnswer(routed, {
      mode: "cached-tree",
      documents,
      sourceDocuments: [],
      retrieval: undefined,
      debug: options.debug,
      cacheInfo: responseCacheInfo,
      scope
    });
  }

  const searchStartedAt = Date.now();
  const queryExpansion = await expandQueryForRetrievalWithDebug(question, {
    provider: options.queryExpansionProvider,
    config: options.queryExpansionConfig
  });
  const retrievalQuestion = queryExpansion.result.expandedQuery;
  serverTrace("qna", "query expansion completed", {
    expansionSource: queryExpansion.result.expansionSource,
    confidence: queryExpansion.result.confidence,
    expansionTermCount: queryExpansion.result.expansionTerms.length,
    cacheHit: queryExpansion.debug.cacheHit,
    error: queryExpansion.debug.error
  });
  const retrieval = documents.length > 0
    ? await searchCachedTreeDocuments(retrievalQuestion, documents, scope, queryExpansion.result)
    : await searchLocalSectionsOnly(retrievalQuestion, localFallbackDocuments, scope, queryExpansion.result);
  let hits = retrieval.hits;
  const debugReport = {
    ...createQaDebugReport(question, retrieval),
    queryExpansion: queryExpansion.debug
  };
  serverTrace("answerFromCachedTrees", "cached tree search completed", {
    hitCount: hits.length,
    pageIndexResultCount: retrieval.pageIndexResultCount,
    bm25FallbackUsed: retrieval.bm25FallbackUsed,
    contrastTerms: retrieval.contrastTerms,
    elapsedMs: Date.now() - searchStartedAt
  });
  serverTrace("qna", "retrieval completed", {
    hitCount: hits.length,
    source: retrieval.retrievalSource,
    pageIndexResultCount: retrieval.pageIndexResultCount,
    bm25FallbackUsed: retrieval.bm25FallbackUsed,
    elapsedMs: Date.now() - searchStartedAt
  });
  if (hits.length === 0) {
    serverTrace("qna", "selected candidate", {
      selected: false,
      reason: "no_hits"
    });
    const indexSource = buildIndexSource(retrieval, documents, []);
    const candidateRelevance = retrieval.bm25FallbackUsed ? retrieval.bm25Results : retrieval.pageIndexResults;
    const routed = handleSelectedSectionQa(question, undefined, undefined, candidateRelevance, detection, {
      ...baseDebug,
      ...debugReport,
      indexSource,
      answerGeneration: "safe-fallback",
      llmCalled: false,
      llmSkippedReason: "no_selected_section",
      llmErrorType: null,
      sectionTextChars: 0,
      contextChars: 0,
      fallbackReason: "no_selected_section"
    });
    const emptyResponse = {
      answer: scopedNotFoundMessage(scope) ?? routed.answer,
      scope: scopeSnapshot(scope, documents.map((document) => document.document)),
      docIds: [],
      documents: documents.map((document) => document.document),
      mode: "cached-tree",
      indexSourceDetails: indexSource,
      retrieval: {
        source: retrieval.retrievalSource,
        bm25FallbackUsed: retrieval.bm25FallbackUsed,
        pageIndexResultCount: retrieval.pageIndexResultCount,
        contrastTerms: retrieval.contrastTerms,
        selectedSection: null,
        finalHsCodes: [],
        answerRepairApplied: false
      },
      ...buildCacheResponseFields(documents, retrieval.retrievalSource),
      answerGeneration: "safe-fallback",
      llmCalled: false,
      llmSkippedReason: "no_selected_section",
      llmErrorType: null,
      sectionTextChars: 0,
      contextChars: 0,
      fallbackReason: "no_selected_section"
    };
    return options.debug
      ? {
          ...emptyResponse,
          intent: routed.intent,
          answer: sanitizeFinalAnswer(emptyResponse.answer),
          selectedPrimary: null,
          documentSummary: null,
          citations: [],
          debug: { ...routed.debug, scope: emptyResponse.scope, scopeApplied: true, finalAnswerSanitized: true }
        }
      : {
          ...emptyResponse,
          intent: routed.intent,
          answer: sanitizeFinalAnswer(emptyResponse.answer),
          selectedPrimary: null,
          documentSummary: null,
          citations: []
        };
  }

  const candidateRelevance = retrieval.bm25FallbackUsed ? retrieval.bm25Results : retrieval.pageIndexResults;
  const explicitHsQuestion = asksForHsCodeOrClassification(question);
  const llmRerankResult = await maybeRerankCandidateHitsWithLlm({
    question,
    hits,
    candidates: candidateRelevance,
    enableLlmQa,
    geminiApiKeys: options.geminiApiKeys,
    candidateReranker: options.candidateReranker
  });
  hits = llmRerankResult.hits;
  const selectedAfterRerank = matchingCandidateForSection(hits[0], candidateRelevance);
  Object.assign(debugReport, {
    ...llmRerankResult.debug,
    selectedCandidateValidation: selectedAfterRerank?.validation ?? null,
    strongSignals: selectedAfterRerank?.validation?.strongSignals ?? [],
    weakSignals: selectedAfterRerank?.validation?.weakSignals ?? [],
    missingEvidence: selectedAfterRerank?.validation?.missingEvidence ?? []
  });

  const hydratedPrimary = hydrateSelectedSectionText(hits[0], sectionMetadata, documentMetadata);
  const sectionTextChars = selectedSectionTextChars(hydratedPrimary);
  const topHits = [hydratedPrimary, ...hits.slice(1, 10)];
  const context = buildStructuredRetrievedContext(topHits);
  const marker12 = TokenValidator.validateContextSize(context.slice(0, 12000), { maxChars: 12000 });
  serverTrace("answerFromCachedTrees", "context prepared", {
    contextChars: context.length,
    truncatedChars: context.slice(0, 12000).length,
    sourceDocuments: uniqueStrings(hits.map((hit) => hit.document)).length
  });
  serverTrace("qna", "selected candidate", {
    selected: true,
    document: hydratedPrimary.document,
    section: hydratedPrimary.section,
    hsCode: hydratedPrimary.hsCode,
    score: hydratedPrimary.score,
    sectionTextChars
  });
  let llmAnswer: string | undefined;
  let llmError: string | undefined;
  let llmErrorType: string | null = null;
  let llmCalled = false;
  let llmSkippedReason: string | null = null;
  let fallbackReason: string | null = null;
  let fieldExtraction: LocalSelectedSectionAnswer["fieldExtraction"];
  const alternatives = selectAlternativeSections(topHits, question);
  const broadQueryDecision = detectBroadQuery({
    originalQuery: question,
    querySignals: extractQuerySignals(question),
    validatedCandidates: candidateRelevance.map((candidate) => validatedCandidateFromRelevanceCandidate(candidate))
  });
  const broadAmbiguity = detectAmbiguousLookup(question, candidateRelevance);
  const meaningfulQueryTokenCount = extractQuerySignals(question).queryTokens.length;
  const broadCanPreemptAnswer =
    explicitHsQuestion ||
    isNumericOnlyQuestion(question) ||
    meaningfulQueryTokenCount <= 1;
  const shouldUseBroadLookup = broadCanPreemptAnswer && broadQueryDecision.isBroad && broadQueryDecision.suggestedMode === "broad_lookup";
  const shouldClarifyBroadQuery = broadCanPreemptAnswer && broadQueryDecision.isBroad && broadQueryDecision.suggestedMode === "clarification";
  const selectedSectionContext = buildStructuredRetrievedContext([hydratedPrimary]).slice(0, 12000);
  const selectedSectionContextChars = selectedSectionContext.length;
  const selectedSectionText = [hydratedPrimary.text, ...(hydratedPrimary.captions ?? [])].filter(Boolean).join("\n\n").trim();
  const selectedValidatedCandidate = validatedCandidateForLocalAnswer(hydratedPrimary, candidateRelevance);
  let answerGeneration: QaAnswerGenerationMode = shouldUseBroadLookup
    ? "broad-lookup"
    : explicitHsQuestion
      ? "template-classification"
      : detection.intent === "definition"
        ? "extractive-definition"
        : "safe-fallback";
  const localGeneratedAnswer = broadCanPreemptAnswer && broadQueryDecision.isBroad
    ? null
    : generateLocalAnswer({
        originalQuery: question,
        selectedCandidate: selectedValidatedCandidate,
        selectedSectionText,
        querySignals: extractQuerySignals(question),
        answerPolicy: {
          classificationRequested: explicitHsQuestion,
          definitionRequested: detection.intent === "definition",
          requestedField: detection.queryPlan?.requestedField ?? null,
          attachHsCode: true,
          allowRelatedHsCode: true
        }
      });
  let localExtractorUsed = false;
  let localExtractorConfidence: LocalAnswerResult["confidence"] | null = localGeneratedAnswer?.confidence ?? null;
  let localExtractorReason: string | null = localGeneratedAnswer?.reason ?? null;
  let hsCodeAttached = Boolean(localGeneratedAnswer?.answer && HS_CODE_PATTERN.test(localGeneratedAnswer.answer));
  if (explicitHsQuestion) {
    if (isSuccessfulLocalAnswer(localGeneratedAnswer) && localGeneratedAnswer.confidence !== "low") {
      llmAnswer = localGeneratedAnswer.answer;
      answerGeneration = localGeneratedAnswer.answerGeneration;
      localExtractorUsed = true;
      fallbackReason = null;
      llmSkippedReason = "local_extractor_succeeded";
      serverTrace("answerFromCachedTrees", "metadata template used", {
        intent: "product_classification",
        selectedSection: hits[0].section,
        answerStyle,
        localExtractorUsed,
        localExtractorReason
      });
      serverTrace("qna", "llm skipped", {
        reason: llmSkippedReason,
        answerGeneration
      });
    } else if (!enableLlmQa || sectionTextChars === 0) {
      llmSkippedReason = !enableLlmQa ? "ENABLE_LLM_QA=false" : "missing_section_text";
      serverTrace("answerFromCachedTrees", "metadata template used", {
        intent: "product_classification",
        selectedSection: hits[0].section,
        answerStyle,
        localExtractorUsed,
        localExtractorReason
      });
      serverTrace("qna", "llm skipped", {
        reason: llmSkippedReason,
        answerGeneration
      });
    } else {
      const llmAvailability = getLlmAvailability({ apiKeys: options.geminiApiKeys });
      const llmProvider = options.selectedSectionAnswerer ? "injected" : llmAvailability.provider;
      const llmKeyCount: number | "injected" = options.selectedSectionAnswerer ? "injected" : llmAvailability.keyCount;
      if (!options.selectedSectionAnswerer && !llmAvailability.configured) {
        llmSkippedReason = "llm_unavailable";
        serverTrace("qna", "llm skipped", {
          reason: llmSkippedReason,
          llmProvider,
          llmKeyCount,
          unavailableReason: llmAvailability.unavailableReason
        });
      } else {
        const llmStartedAt = Date.now();
        serverTrace("qna", "llm called for classification", { sectionTextChars, llmProvider, llmKeyCount });
        try {
          const llm = options.selectedSectionAnswerer ?? createLlmClient({ apiKeys: options.geminiApiKeys });
          llmCalled = true;
          llmAnswer = await llm.synthesizeSectionAnswer({
            document: hydratedPrimary.document,
            section: hydratedPrimary.section,
            title: hydratedPrimary.title,
            hsCode: hydratedPrimary.hsCode,
            source: hydratedPrimary.source,
            text: hydratedPrimary.text,
            context: selectedSectionContext
          }, question, { language: "Vietnamese" });
          if (llmAnswer?.trim()) {
            answerGeneration = "llm-selected-section";
            fallbackReason = null;
            serverTrace("qna", "llm completed", {
              answerChars: llmAnswer.length,
              elapsedMs: Date.now() - llmStartedAt,
              llmProvider,
              llmKeyCount
            });
          } else {
            answerGeneration = "template-classification";
            llmAnswer = undefined;
            serverTrace("qna", "llm empty, using template", { elapsedMs: Date.now() - llmStartedAt, llmProvider, llmKeyCount });
          }
        } catch (error) {
          llmError = error instanceof Error ? error.message : String(error);
          llmErrorType = classifyLlmErrorType(error);
          answerGeneration = "template-classification";
          serverTrace("qna", "llm failed, using template", {
            reason: llmError,
            elapsedMs: Date.now() - llmStartedAt,
            llmProvider,
            llmKeyCount
          });
        }
      }
    }
  } else if (broadCanPreemptAnswer && broadQueryDecision.isBroad) {
    llmSkippedReason = shouldClarifyBroadQuery ? "broad_query_clarification" : "broad_lookup";
    serverTrace("qna", "llm skipped", {
      reason: llmSkippedReason,
      answerGeneration
    });
  } else if (detection.intent === "definition") {
    if (isSuccessfulLocalAnswer(localGeneratedAnswer) && localGeneratedAnswer.confidence !== "low") {
      llmAnswer = localGeneratedAnswer.answer;
      answerGeneration = localGeneratedAnswer.answerGeneration;
      localExtractorUsed = true;
      fallbackReason = null;
      llmSkippedReason = "local_extractor_succeeded";
    } else if (!enableLlmQa || sectionTextChars === 0) {
      llmSkippedReason = !enableLlmQa ? "ENABLE_LLM_QA=false" : "missing_section_text";
    } else {
      const llmAvailability = getLlmAvailability({ apiKeys: options.geminiApiKeys });
      const llmProvider = options.selectedSectionAnswerer ? "injected" : llmAvailability.provider;
      const llmKeyCount: number | "injected" = options.selectedSectionAnswerer ? "injected" : llmAvailability.keyCount;
      if (!options.selectedSectionAnswerer && !llmAvailability.configured) {
        llmSkippedReason = "llm_unavailable";
        serverTrace("qna", "llm skipped", {
          reason: llmSkippedReason,
          llmProvider,
          llmKeyCount,
          unavailableReason: llmAvailability.unavailableReason
        });
      } else {
        const llmStartedAt = Date.now();
        serverTrace("qna", "llm called for definition", { sectionTextChars, llmProvider, llmKeyCount });
        try {
          const llm = options.selectedSectionAnswerer ?? createLlmClient({ apiKeys: options.geminiApiKeys });
          llmCalled = true;
          llmAnswer = await llm.synthesizeSectionAnswer({
            document: hydratedPrimary.document,
            section: hydratedPrimary.section,
            title: hydratedPrimary.title,
            hsCode: hydratedPrimary.hsCode,
            source: hydratedPrimary.source,
            text: hydratedPrimary.text,
            context: selectedSectionContext
          }, question, { language: "Vietnamese" });
          if (llmAnswer?.trim()) {
            answerGeneration = "llm-selected-section";
            fallbackReason = null;
          } else {
            answerGeneration = "extractive-definition";
            llmAnswer = undefined;
          }
        } catch (error) {
          llmError = error instanceof Error ? error.message : String(error);
          llmErrorType = classifyLlmErrorType(error);
          answerGeneration = "extractive-definition";
        }
      }
    }
    serverTrace("qna", "definition path", {
      llmSkippedReason,
      answerGeneration,
      localExtractorUsed,
      localExtractorReason
    });
  } else if (detection.intent === "selected_section_qa" || detection.intent === "section_attribute_question" || detection.intent === "comparison") {
    serverTrace("qna", "local extractor start", {
      sectionTextChars,
      contextChars: selectedSectionContextChars,
      selectedSection: hydratedPrimary.section
    });
    const localGeneratedSucceeded = isHighQualityLocalAnswer(localGeneratedAnswer, question);
    const legacyLocalAnswer = localGeneratedSucceeded ? null : extractLocalSelectedSectionAnswer(question, hydratedPrimary, detection);
    const legacyLocalSucceeded = isSuccessfulLegacyLocalAnswer(legacyLocalAnswer);
    fieldExtraction = legacyLocalAnswer?.fieldExtraction;
    serverTrace("qna", "local extractor end", {
      answerGeneration: localGeneratedAnswer?.answerGeneration ?? legacyLocalAnswer?.answerGeneration,
      answerChars: localGeneratedAnswer?.answer?.length ?? legacyLocalAnswer?.answer?.length ?? 0,
      fallbackReason: localGeneratedSucceeded || legacyLocalSucceeded ? null : legacyLocalAnswer?.fallbackReason ?? localGeneratedAnswer?.reason,
      requestedField: legacyLocalAnswer?.fieldExtraction?.requestedField ?? detection.queryPlan?.requestedField,
      matchedHeading: legacyLocalAnswer?.fieldExtraction?.matchedHeading,
      confidence: localGeneratedAnswer?.confidence ?? legacyLocalAnswer?.fieldExtraction?.confidence,
      localExtractorReason
    });

    const llmTraceDetails = {
      sectionTextChars,
      contextChars: selectedSectionContextChars,
      selectedSection: hydratedPrimary.section
    };
    if (localGeneratedSucceeded || legacyLocalSucceeded) {
      llmAnswer = localGeneratedSucceeded ? localGeneratedAnswer!.answer ?? undefined : legacyLocalAnswer?.answer;
      answerGeneration = localGeneratedSucceeded ? localGeneratedAnswer!.answerGeneration : legacyLocalAnswer?.answerGeneration ?? "extractive-field";
      localExtractorUsed = true;
      localExtractorConfidence = localGeneratedSucceeded ? localGeneratedAnswer!.confidence : legacyLocalAnswer?.fieldExtraction?.confidence ?? "medium";
      localExtractorReason = localGeneratedSucceeded ? localGeneratedAnswer!.reason : "field extracted from selected section text";
      hsCodeAttached = Boolean(llmAnswer && HS_CODE_PATTERN.test(llmAnswer));
      fallbackReason = null;
      llmSkippedReason = "local_extractor_succeeded";
      serverTrace("qna", "llm skipped", {
        ...llmTraceDetails,
        reason: llmSkippedReason,
        answerGeneration
      });
    } else if (!enableLlmQa) {
      fallbackReason = legacyLocalAnswer?.fallbackReason ?? localGeneratedAnswer?.reason ?? "local_extractor_no_answer";
      llmSkippedReason = "ENABLE_LLM_QA=false";
      serverTrace("qna", "llm skipped", {
        ...llmTraceDetails,
        reason: llmSkippedReason,
        fallbackReason
      });
    } else if (sectionTextChars === 0) {
      fallbackReason = "missing_section_text";
      llmSkippedReason = "missing_section_text";
      serverTrace("qna", "llm skipped", {
        ...llmTraceDetails,
        reason: llmSkippedReason
      });
    } else if (selectedSectionContextChars === 0) {
      fallbackReason = "missing_context";
      llmSkippedReason = "missing_context";
      serverTrace("qna", "llm skipped", {
        ...llmTraceDetails,
        reason: llmSkippedReason
      });
    } else {
      const llmAvailability = getLlmAvailability({ apiKeys: options.geminiApiKeys });
      const llmProvider = options.selectedSectionAnswerer ? "injected" : llmAvailability.provider;
      const llmKeyCount: number | "injected" = options.selectedSectionAnswerer ? "injected" : llmAvailability.keyCount;
      if (!options.selectedSectionAnswerer && !llmAvailability.configured) {
        fallbackReason = "llm_unavailable";
        llmSkippedReason = "llm_unavailable";
        serverTrace("qna", "llm skipped", {
          ...llmTraceDetails,
          llmKeyCount,
          llmProvider,
          unavailableReason: llmAvailability.unavailableReason,
          reason: llmSkippedReason
        });
      } else {
        const llmStartedAt = Date.now();
        serverTrace("qna", "llm called", {
          ...llmTraceDetails,
          llmKeyCount,
          llmProvider
        });
        try {
          const llm = options.selectedSectionAnswerer ?? createLlmClient({ apiKeys: options.geminiApiKeys });
          llmCalled = true;
          const contrastSignals = detectContrastTerms(question);
          const hasContrastQuery = contrastSignals.terms.length > 0 || contrastSignals.baselineTokens.length > 0;
          if (hasContrastQuery && alternatives.length > 0 && !options.selectedSectionAnswerer) {
            const comparisonSections = [hydratedPrimary, ...alternatives.slice(0, 1)].map((section) => ({
              document: section.document,
              section: section.section,
              title: section.title,
              hsCode: section.hsCode,
              source: section.source,
              text: section.text
            }));
            const comparisonLlm = createLlmClient({ apiKeys: options.geminiApiKeys });
            llmAnswer = await comparisonLlm.synthesizeComparisonAnswer(comparisonSections, question, { language: "Vietnamese" });
          } else {
            llmAnswer = await llm.synthesizeSectionAnswer({
              document: hydratedPrimary.document,
              section: hydratedPrimary.section,
              title: hydratedPrimary.title,
              hsCode: hydratedPrimary.hsCode,
              source: hydratedPrimary.source,
              text: hydratedPrimary.text,
              context: selectedSectionContext
            }, question, { language: "Vietnamese" });
          }

          if (!llmAnswer?.trim()) {
            fallbackReason = "empty_llm_answer";
            llmErrorType = "empty";
            llmError = fallbackReason;
            llmAnswer = undefined;
            answerGeneration = "safe-fallback";
            serverTrace("qna", "llm failed", {
              ...llmTraceDetails,
              llmKeyCount,
              llmProvider,
              reason: fallbackReason,
              llmErrorType,
              elapsedMs: Date.now() - llmStartedAt
            });
          } else {
            answerGeneration = "llm-selected-section";
            fallbackReason = null;
            serverTrace("answerFromCachedTrees", "selected_section_qa llm completed", {
              ...llmTraceDetails,
              llmKeyCount,
              llmProvider,
              answerChars: llmAnswer.length,
              elapsedMs: Date.now() - llmStartedAt
            });
            serverTrace("qna", "llm completed", {
              ...llmTraceDetails,
              llmKeyCount,
              llmProvider,
              answerChars: llmAnswer.length,
              elapsedMs: Date.now() - llmStartedAt
            });
          }
        } catch (error) {
          llmError = error instanceof Error ? error.message : String(error);
          llmErrorType = classifyLlmErrorType(error);
          fallbackReason = llmErrorType === "unknown" ? "llm_failed" : `llm_${llmErrorType}`;
          llmAnswer = undefined;
          answerGeneration = "safe-fallback";
          serverTrace("qna", "llm failed", {
            ...llmTraceDetails,
            llmKeyCount,
            llmProvider,
            reason: llmError,
            llmErrorType,
            elapsedMs: Date.now() - llmStartedAt
          });
        }
      }
    }
  }
  const routed = explicitHsQuestion
    ? handleProductClassification(question, hydratedPrimary, alternatives, llmAnswer, candidateRelevance, detection, {
        ...baseDebug,
        ...debugReport,
        answerGeneration,
        llmCalled,
        llmSkippedReason,
        llmErrorType,
        sectionTextChars,
        selectedSectionTextChars: selectedSectionText.length,
        contextChars: selectedSectionContextChars,
        fallbackReason,
        localExtractorUsed,
        localExtractorConfidence,
        localExtractorReason,
        hsCodeAttached,
        broadQueryDecision
      })
    : detection.intent === "definition"
      ? handleDefinition(question, hydratedPrimary, candidateRelevance, detection, {
          ...baseDebug,
          ...debugReport,
          answerGeneration,
          llmCalled,
          llmSkippedReason,
          llmErrorType,
          sectionTextChars,
          selectedSectionTextChars: selectedSectionText.length,
          contextChars: selectedSectionContextChars,
          fallbackReason,
          localExtractorUsed,
          localExtractorConfidence,
          localExtractorReason,
          hsCodeAttached,
          broadQueryDecision
        }, localGeneratedAnswer?.answer ?? undefined)
    : handleSelectedSectionQa(question, hydratedPrimary, llmAnswer, candidateRelevance, detection, {
        ...baseDebug,
        ...debugReport,
        answerGeneration,
        llmCalled,
        llmSkippedReason,
        llmErrorType,
        sectionTextChars,
        selectedSectionTextChars: selectedSectionText.length,
        contextChars: selectedSectionContextChars,
        fallbackReason,
        localExtractorUsed,
        localExtractorConfidence,
        localExtractorReason,
        hsCodeAttached,
        fieldExtraction,
        broadQueryDecision
      });
  const answer = sanitizeFinalAnswer(routed.answer, { maxWords: answerStyle === "class-eval" ? 180 : undefined });
  const finalAnswerGeneration = isQaAnswerGenerationMode(routed.debug.answerGeneration)
    ? routed.debug.answerGeneration
    : answerGeneration;
  const finalHsCodes = Array.isArray(routed.debug.finalHsCodes) ? routed.debug.finalHsCodes as string[] : hsCodesForSection(hits[0]);
  const answerRepairApplied = Boolean(routed.debug.answerRepairApplied);
  const marker13 = TokenValidator.validateOutputSize(answer, { maxWords: 180 });
  const validation = QAValidator.validateResponse(answer, { requireCitations: false });
  serverTrace("qna", "final answer generation mode", {
    answerGeneration: finalAnswerGeneration,
    llmCalled,
    llmSkippedReason,
    llmErrorType,
    fallbackReason
  });
  serverTrace("answerFromCachedTrees", "completed", { elapsedMs: Date.now() - startedAt });
  const sourceDocuments = uniqueStrings(hits.map((hit) => hit.document));
  const indexSource = buildIndexSource(retrieval, documents, sourceDocuments);
  const cacheInfo = buildCacheResponseFields(documents, retrieval.retrievalSource);

  const response = {
    intent: routed.intent,
    answerMode: routed.answerMode,
    answerConfidence: routed.answerConfidence,
    confidenceReason: routed.debug.confidenceReason,
    finalScore: routed.debug.finalScore,
    strongSignals: routed.debug.strongSignals ?? [],
    contradictions: routed.debug.contradictions ?? [],
    answer,
    selectedPrimary: withPdfCitationLinks(routed.selectedPrimary, answer),
    documentSummary: routed.documentSummary,
    scope: scopeSnapshot(scope, documents.map((document) => document.document)),
    docIds: [],
    documents: sourceDocuments,
    mode: "cached-tree",
    indexSource: cacheInfo.indexSource,
    indexSourceDetails: indexSource,
    cachedDocumentCount: cacheInfo.cachedDocumentCount,
    cacheFreshness: cacheInfo.cacheFreshness,
    pageIndexUploadStatus: cacheInfo.pageIndexUploadStatus,
    retrieval: {
      source: retrieval.retrievalSource,
      bm25FallbackUsed: retrieval.bm25FallbackUsed,
      pageIndexResultCount: retrieval.pageIndexResultCount,
      contrastTerms: retrieval.contrastTerms,
      selectedSection: withPdfCitationLinks(routed.selectedPrimary, answer),
      finalHsCodes,
      answerRepairApplied
    },
    citations: withPdfCitationLinksList(routed.citations, answer),
    retrievedSections: topHits.slice(0, 5).map(publicSectionCitation),
    metadataWarnings: hits[0].metadataWarnings,
    answerGeneration: finalAnswerGeneration,
    llmCalled,
    llmSkippedReason,
    llmErrorType,
    sectionTextChars,
    selectedSectionTextChars: selectedSectionText.length,
    localExtractorUsed,
    localExtractorConfidence,
    localExtractorReason,
    hsCodeAttached,
    contextChars: selectedSectionContextChars,
    fallbackReason,
    llmError,
    validation: {
      ...validation,
      markers: [marker12, marker13, ...validation.markers]
    }
  };
  return options.debug ? { ...response, debug: { ...routed.debug, scope: response.scope, scopeApplied: true, finalAnswerSanitized: true } } : response;
}

async function searchCachedTreeDocuments(
  question: string,
  documents: CachedTreeDocument[],
  scope: QaScopeTracker,
  queryExpansion?: QueryExpansionResult
): Promise<CachedTreeRetrievalResult> {
  const contrast = detectContrastTerms(question);
  const signals = extractQuerySignals(question);
  const scoringContext = buildSearchScoringContext(question, signals, contrast);
  const scopedDocuments = documents.filter((document) => scopeAllowsDocument(scope, document.document));
  const scopedDocumentNames = scopedDocuments.map((document) => document.document);
  const [sectionMetadata, documentMetadata] = await Promise.all([
    loadSectionMetadata(scopedDocumentNames, scope),
    loadDocumentMetadata(scopedDocumentNames)
  ]);
  const pageIndexHits: EnrichedRetrievedSection[] = [];

  for (const document of scopedDocuments) {
    const treeJson = await readOptionalJson<Record<string, unknown>>(path.resolve(process.cwd(), document.treePath));
    const roots = normalizeTreeRoots(treeJson);
    for (const node of flattenCachedTreeNodes(roots)) {
      const scored = scoreSearchFields(scoringContext, {
        title: node.title,
        heading: node.title,
        body: node.text,
        captions: "",
        source: document.document
      });
      const score = scored.total;
      if (score > 0) {
        const rawHit: RetrievedTreeHit = {
          document: document.document,
          title: node.title,
          text: node.text.slice(0, 2400),
          score
        };
        pageIndexHits.push({
          ...enrichRetrievedHit(rawHit, sectionMetadata),
          scoreBreakdown: scored.breakdown,
          hydrationSource: "retrieval"
        });
      }
    }
  }

  const localSearchHits = searchLocalSectionMetadataFallback(scoringContext, sectionMetadata, documentMetadata);
  const hydratedPageIndexHits = hydrateSectionsForSearch(pageIndexHits, sectionMetadata, documentMetadata);
  const rankedPageIndexHits = rankRetrievedSectionsByUsability(mergeSearchCandidates([
    ...hydratedPageIndexHits,
    ...localSearchHits
  ]), question);
  const pageIndexSelection = selectRelevantSections(rankedPageIndexHits, question, {
    requireHsMetadata: asksForHsCodeOrClassification(queryExpansion?.originalQuery ?? question),
    originalQuestion: queryExpansion?.originalQuery ?? question,
    expansionTerms: queryExpansion?.expansionTerms ?? [],
    expansionConfidence: queryExpansion?.confidence,
    scope
  });
  const usablePageIndexHits = pageIndexSelection.ranked;
  if (usablePageIndexHits.length > 0) {
    return {
      hits: usablePageIndexHits,
      retrievalSource: "cached-pageindex-tree",
      bm25FallbackUsed: false,
      pageIndexResultCount: rankedPageIndexHits.length,
      contrastTerms: contrast.terms,
      signals,
      pageIndexResults: pageIndexSelection.candidates,
      bm25Results: []
    };
  }

  serverTrace("searchCachedTreeDocuments", "BM25 fallback used", {
    pageIndexResultCount: rankedPageIndexHits.length,
    contrastTerms: contrast.terms
  });
  const bm25Candidates = rankRetrievedSectionsByUsability(localSearchHits, question);
  const bm25Selection = selectRelevantSections(bm25Candidates, question, {
    requireHsMetadata: asksForHsCodeOrClassification(queryExpansion?.originalQuery ?? question),
    originalQuestion: queryExpansion?.originalQuery ?? question,
    expansionTerms: queryExpansion?.expansionTerms ?? [],
    expansionConfidence: queryExpansion?.confidence,
    scope
  });
  return {
    hits: bm25Selection.ranked,
    retrievalSource: "bm25-fallback",
    bm25FallbackUsed: true,
    pageIndexResultCount: rankedPageIndexHits.length,
    contrastTerms: contrast.terms,
    signals,
    pageIndexResults: pageIndexSelection.candidates,
    bm25Results: bm25Selection.candidates
  };
}

export async function answerQuestionForEval(
  question: string,
  options: {
    cachedTreeDocuments?: string[];
    localSectionDocuments?: string[];
    selectedSectionAnswerer?: Pick<LlmClient, "synthesizeSectionAnswer">;
    candidateReranker?: Pick<LlmClient, "planQuery">;
    enableLlmQa?: boolean;
    queryExpansionProvider?: QueryExpansionProvider;
    queryExpansionConfig?: Partial<QueryExpansionRuntimeConfig>;
    debug?: boolean;
  } = {}
): Promise<Record<string, unknown>> {
  return await answerFromCachedTrees(question, {
    ...options,
    answerStyle: "class-eval",
    geminiApiKeys: [],
    enableLlmQa: options.enableLlmQa ?? false
  });
}

interface LlmCandidateRerankDebug {
  llmRerankCalled: boolean;
  llmRerankSelectedHsCode: string | null;
  llmRerankReason: string | null;
  llmRerankAccepted: boolean;
  llmRerankProvider: string | null;
  llmRerankErrorType: string | null;
  llmRerankCandidateCount: number;
}

async function maybeRerankCandidateHitsWithLlm(args: {
  question: string;
  hits: EnrichedRetrievedSection[];
  candidates: CandidateRelevance[];
  enableLlmQa: boolean;
  geminiApiKeys?: string[];
  candidateReranker?: Pick<LlmClient, "planQuery">;
}): Promise<{ hits: EnrichedRetrievedSection[]; debug: LlmCandidateRerankDebug }> {
  const debug = defaultLlmCandidateRerankDebug();
  if (args.hits.length <= 1 || !asksForHsCodeOrClassification(args.question)) {
    return { hits: args.hits, debug };
  }
  if (!args.enableLlmQa) {
    return { hits: args.hits, debug: { ...debug, llmRerankReason: "ENABLE_LLM_QA=false" } };
  }

  const availability = getLlmAvailability({ apiKeys: args.geminiApiKeys });
  const injected = Boolean(args.candidateReranker);
  if (!injected && availability.provider !== "bifrost") {
    return { hits: args.hits, debug: { ...debug, llmRerankProvider: availability.provider, llmRerankReason: "provider_not_bifrost" } };
  }
  if (!injected && !availability.configured) {
    return {
      hits: args.hits,
      debug: {
        ...debug,
        llmRerankProvider: availability.provider,
        llmRerankReason: availability.unavailableReason ?? "llm_unavailable"
      }
    };
  }

  const candidatePayload = args.hits.slice(0, 6).map((hit, index) => {
    const candidate = matchingCandidateForSection(hit, args.candidates);
    return {
      rank: index + 1,
      document: hit.document,
      hsCode: hit.hsCode ?? null,
      groupedHsCodes: hit.groupedHsCodes ?? [],
      title: hit.title ?? null,
      section: hit.section ?? null,
      source: hit.source ?? null,
      score: hit.score,
      matchedTerms: candidate?.matchedTerms ?? [],
      matchedPhrases: candidate?.candidateMatchedPhrases ?? [],
      aliasSignals: candidate?.candidateAliasSignals ?? [],
      validationStrongSignals: candidate?.validation?.strongSignals ?? [],
      validationWeakSignals: candidate?.validation?.weakSignals ?? [],
      excerpt: shortPromptExcerpt([hit.text, ...(hit.captions ?? [])].filter(Boolean).join("\n"))
    };
  });
  const allowedHsCodes = new Set(candidatePayload.flatMap((candidate) => [
    typeof candidate.hsCode === "string" ? candidate.hsCode : "",
    ...candidate.groupedHsCodes
  ]).filter(Boolean));
  if (allowedHsCodes.size === 0) {
    return { hits: args.hits, debug: { ...debug, llmRerankReason: "no_candidate_hscode" } };
  }

  const provider = injected ? "injected" : availability.provider;
  const prompt = [
    "You are reranking HS code candidates using only the candidate list below.",
    "Select the candidate that best matches the user query. Do not invent HS codes.",
    "Return strict JSON only: {\"selectedHsCode\":\"1000.00.00\",\"confidence\":\"high|medium|low\",\"reason\":\"short reason\"}.",
    "",
    `User query: ${args.question}`,
    "",
    `Candidates:\n${JSON.stringify(candidatePayload, null, 2)}`
  ].join("\n");

  serverTrace("qna", "llm rerank called", {
    provider,
    candidateCount: candidatePayload.length,
    aliasSignals: uniqueStrings(candidatePayload.flatMap((candidate) => candidate.aliasSignals))
  });
  try {
    const reranker = args.candidateReranker ?? createLlmClient({ apiKeys: args.geminiApiKeys });
    const raw = await reranker.planQuery(prompt, { temperature: 0, maxOutputTokens: 300 });
    const parsed = parseLlmRerankResponse(raw);
    const selectedHsCode = parsed?.selectedHsCode ?? null;
    const confidence = parsed?.confidence ?? "low";
    const selectedIndex = selectedHsCode
      ? args.hits.findIndex((hit) => hsCodesForSection(hit).includes(selectedHsCode))
      : -1;
    const accepted = Boolean(selectedHsCode && allowedHsCodes.has(selectedHsCode) && (confidence === "medium" || confidence === "high") && selectedIndex >= 0);
    serverTrace("qna", "llm rerank completed", {
      provider,
      selectedHsCode,
      confidence,
      accepted,
      reason: parsed?.reason ?? null
    });
    if (!accepted) {
      return {
        hits: args.hits,
        debug: {
          ...debug,
          llmRerankCalled: true,
          llmRerankProvider: provider,
          llmRerankSelectedHsCode: selectedHsCode,
          llmRerankReason: parsed?.reason ?? "rerank_response_not_accepted",
          llmRerankCandidateCount: candidatePayload.length
        }
      };
    }

    const selected = args.hits[selectedIndex];
    return {
      hits: [selected, ...args.hits.filter((_, index) => index !== selectedIndex)],
      debug: {
        ...debug,
        llmRerankCalled: true,
        llmRerankAccepted: true,
        llmRerankProvider: provider,
        llmRerankSelectedHsCode: selectedHsCode,
        llmRerankReason: parsed?.reason ?? null,
        llmRerankCandidateCount: candidatePayload.length
      }
    };
  } catch (error) {
    const errorType = classifyLlmErrorType(error);
    serverTrace("qna", "llm rerank failed", {
      provider,
      errorType,
      reason: error instanceof Error ? error.message : String(error)
    });
    return {
      hits: args.hits,
      debug: {
        ...debug,
        llmRerankCalled: true,
        llmRerankProvider: provider,
        llmRerankErrorType: errorType,
        llmRerankReason: errorType === "unknown" ? "llm_rerank_failed" : `llm_rerank_${errorType}`,
        llmRerankCandidateCount: candidatePayload.length
      }
    };
  }
}

function defaultLlmCandidateRerankDebug(): LlmCandidateRerankDebug {
  return {
    llmRerankCalled: false,
    llmRerankSelectedHsCode: null,
    llmRerankReason: null,
    llmRerankAccepted: false,
    llmRerankProvider: null,
    llmRerankErrorType: null,
    llmRerankCandidateCount: 0
  };
}

function parseLlmRerankResponse(value: string): { selectedHsCode: string | null; confidence: "high" | "medium" | "low"; reason: string | null } | null {
  const json = extractJsonObjectText(value);
  if (!json) {
    return null;
  }
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const selectedHsCode = typeof parsed.selectedHsCode === "string"
      ? parsed.selectedHsCode.match(HS_CODE_PATTERN)?.[0] ?? null
      : typeof parsed.hsCode === "string"
        ? parsed.hsCode.match(HS_CODE_PATTERN)?.[0] ?? null
        : null;
    const confidence = parsed.confidence === "high" || parsed.confidence === "medium" || parsed.confidence === "low"
      ? parsed.confidence
      : "low";
    const reason = typeof parsed.reason === "string" ? parsed.reason.slice(0, 240) : null;
    return { selectedHsCode, confidence, reason };
  } catch {
    return null;
  }
}

function extractJsonObjectText(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : null;
}

function shortPromptExcerpt(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 700);
}

async function searchLocalSectionsOnly(
  question: string,
  documentNames: string[] = [],
  scope: QaScopeTracker = createQaScope(documentNames),
  queryExpansion?: QueryExpansionResult
): Promise<CachedTreeRetrievalResult> {
  const contrast = detectContrastTerms(question);
  const signals = extractQuerySignals(question);
  const scoringContext = buildSearchScoringContext(question, signals, contrast);
  const allowedDocuments = new Set(documentNames);
  const [loadedSectionMetadata, documentMetadata] = await Promise.all([
    loadSectionMetadata(documentNames, scope),
    loadDocumentMetadata(documentNames)
  ]);
  const sectionMetadata = loadedSectionMetadata
    .filter((section) => (allowedDocuments.size === 0 || allowedDocuments.has(section.document)) && scopeAllowsDocument(scope, section.document));
  const bm25Candidates = rankRetrievedSectionsByUsability(searchLocalSectionMetadataFallback(scoringContext, sectionMetadata, documentMetadata), question);
  const bm25Selection = selectRelevantSections(bm25Candidates, question, {
    requireHsMetadata: asksForHsCodeOrClassification(queryExpansion?.originalQuery ?? question),
    originalQuestion: queryExpansion?.originalQuery ?? question,
    expansionTerms: queryExpansion?.expansionTerms ?? [],
    expansionConfidence: queryExpansion?.confidence,
    scope
  });
  return {
    hits: bm25Selection.ranked,
    retrievalSource: "local-sections",
    bm25FallbackUsed: true,
    pageIndexResultCount: 0,
    contrastTerms: contrast.terms,
    signals,
    pageIndexResults: [],
    bm25Results: bm25Selection.candidates
  };
}

function buildIndexSource(
  retrieval: CachedTreeRetrievalResult,
  cachedDocuments: CachedTreeDocument[],
  sourceDocuments: string[]
): Record<string, unknown> {
  if (retrieval.retrievalSource === "local-sections") {
    return {
      label: "Local sections only",
      source: "local-sections",
      cachedDocumentCount: 0,
      documents: sourceDocuments.map((document) => ({ document, status: "local-sections" }))
    };
  }

  if (retrieval.retrievalSource === "bm25-fallback") {
    return {
      label: "BM25 fallback",
      source: "bm25-fallback",
      cachedDocumentCount: cachedDocuments.length,
      documents: cachedDocuments.map(publicCachedTreeDocument),
      warning: cachedDocuments.some((document) => document.pageIndexCacheStatus === "stale")
        ? "Cached tree may be stale; re-upload PageIndex to sync with latest Markdown."
        : undefined
    };
  }

  const hasStale = cachedDocuments.some((document) => document.pageIndexCacheStatus === "stale");
  const hasFailed = cachedDocuments.some((document) => document.pageIndexCacheStatus === "failed");
  const status = hasFailed ? "failed" : hasStale ? "stale" : "fresh";
  return {
    label: status === "fresh" ? "Cached PageIndex tree" : "Stale cached PageIndex tree",
    source: "cached-pageindex-tree",
    cachedDocumentCount: cachedDocuments.length,
    cacheStatus: status,
    documents: cachedDocuments.map(publicCachedTreeDocument),
    warning: status === "stale" ? "Cached tree may be stale; re-upload PageIndex to sync with latest Markdown." : undefined
  };
}

function buildCacheResponseFields(
  cachedDocuments: CachedTreeDocument[],
  retrievalSource: CachedTreeRetrievalResult["retrievalSource"] | "local-sections"
): {
  indexSource: PublicIndexSource;
  cachedDocumentCount: number;
  cacheFreshness: CacheFreshnessSummary;
  pageIndexUploadStatus: string;
} {
  const cacheFreshness = summarizeCacheFreshness(cachedDocuments);
  const indexSource = publicIndexSource(retrievalSource, cacheFreshness);
  return {
    indexSource,
    cachedDocumentCount: cachedDocuments.length,
    cacheFreshness,
    pageIndexUploadStatus: summarizePageIndexUploadStatus(cachedDocuments)
  };
}

function summarizeCacheFreshness(cachedDocuments: CachedTreeDocument[]): CacheFreshnessSummary {
  return {
    fresh: cachedDocuments.filter((document) => document.pageIndexCacheStatus === "fresh").map((document) => document.document),
    stale: cachedDocuments.filter((document) => document.pageIndexCacheStatus === "stale").map((document) => document.document),
    missing: cachedDocuments.filter((document) => !["fresh", "stale"].includes(document.pageIndexCacheStatus)).map((document) => document.document)
  };
}

function publicIndexSource(
  retrievalSource: CachedTreeRetrievalResult["retrievalSource"] | "local-sections",
  freshness: CacheFreshnessSummary
): PublicIndexSource {
  if (retrievalSource === "local-sections") return "local_sections";
  if (retrievalSource === "bm25-fallback") return "bm25_fallback";
  if (retrievalSource === "pageindex-tree") return "pageindex_live";
  if (retrievalSource === "cached-pageindex-tree") {
    return freshness.stale.length > 0 ? "stale_cached_tree" : "fresh_cached_tree";
  }
  return "unknown";
}

function summarizePageIndexUploadStatus(cachedDocuments: CachedTreeDocument[]): string {
  if (cachedDocuments.length === 0) return "missing";
  if (cachedDocuments.some((document) => document.pageIndexCacheStatus === "failed")) return "failed";
  if (cachedDocuments.some((document) => document.pageIndexCacheStatus === "stale")) return "stale";
  if (cachedDocuments.every((document) => document.pageIndexCacheStatus === "fresh")) return "fresh";
  return "skipped";
}

class TemplateFastPathSkip extends Error {}

function classifyLlmErrorType(error: unknown): "quota" | "rate_limit" | "permission" | "timeout" | "empty" | "unknown" {
  const status = errorStatus(error);
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (message.includes("timeout") || message.includes("timed out") || message.includes("deadline")) {
    return "timeout";
  }
  if (status === 401 || status === 403 ||
    message.includes("api key not valid") ||
    message.includes("invalid api key") ||
    message.includes("unauthorized") ||
    message.includes("permission denied") ||
    message.includes("forbidden")) {
    return "permission";
  }
  if (message.includes("quota") || message.includes("resource exhausted")) {
    return "quota";
  }
  if (status === 429 || message.includes("rate limit") || message.includes("too many requests")) {
    return "rate_limit";
  }
  return "unknown";
}

function errorStatus(error: unknown): number | undefined {
  const candidate = error as { status?: unknown; response?: { status?: unknown }; code?: unknown };
  if (typeof candidate.status === "number") return candidate.status;
  if (typeof candidate.response?.status === "number") return candidate.response.status;
  if (typeof candidate.code === "number") return candidate.code;
  return undefined;
}

function shouldUseTemplateFastPath(intent: string, section: EnrichedRetrievedSection, answerStyle: AnswerStyleOption): boolean {
  if (answerStyle === "verbose") {
    return false;
  }
  const hasCodes = hsCodesForSection(section).length > 0;
  const hasTitle = Boolean(section.title || section.section);
  if (!hasCodes || !hasTitle) {
    return false;
  }
  if (intent === "definition") {
    return Boolean(section.text || section.captions.length > 0);
  }
  return intent === "product_classification";
}

function finalizeRoutedAnswer(
  routed: RoutedQaAnswer,
  options: {
    mode: string;
    documents: CachedTreeDocument[];
    sourceDocuments: string[];
    retrieval?: CachedTreeRetrievalResult;
    debug?: boolean;
    cacheInfo?: ReturnType<typeof buildCacheResponseFields>;
    scope?: QaScopeTracker;
  }
): Record<string, unknown> {
  const indexSource = options.retrieval
    ? buildIndexSource(options.retrieval, options.documents, options.sourceDocuments)
    : {
        label: options.sourceDocuments.length > 0 ? "Local metadata" : "Local metadata",
        source: "local-metadata",
        cachedDocumentCount: options.documents.length,
        documents: options.sourceDocuments.map((document) => ({ document, status: "metadata" }))
      };
  const finalHsCodes = routed.selectedPrimary
    ? uniqueStrings([
        ...(Array.isArray(routed.selectedPrimary.groupedHsCodes) ? routed.selectedPrimary.groupedHsCodes.map(String) : []),
        typeof routed.selectedPrimary.hsCode === "string" ? routed.selectedPrimary.hsCode : ""
      ].filter(Boolean))
    : [];
  const cacheInfo = options.cacheInfo ?? buildCacheResponseFields(options.documents, options.retrieval?.retrievalSource ?? "local-sections");
  const responseScope = options.scope
    ? scopeSnapshot(options.scope, options.documents.map((document) => document.document))
    : routed.debug.scope ?? null;
  const answerGeneration = responseAnswerGeneration(routed);
  const llmCalled = Boolean(routed.debug.llmCalled);
  const llmSkippedReason = typeof routed.debug.llmSkippedReason === "string" ? routed.debug.llmSkippedReason : null;
  const llmErrorType = typeof routed.debug.llmErrorType === "string" ? routed.debug.llmErrorType : null;
  const fallbackReason = typeof routed.debug.fallbackReason === "string" ? routed.debug.fallbackReason : null;
  const localExtractorConfidence = isAnswerConfidence(routed.debug.localExtractorConfidence)
    ? routed.debug.localExtractorConfidence
    : null;
  const response = {
    intent: routed.intent,
    answerMode: routed.answerMode,
    answerConfidence: routed.answerConfidence,
    confidenceReason: routed.debug.confidenceReason,
    finalScore: routed.debug.finalScore,
    strongSignals: routed.debug.strongSignals ?? [],
    contradictions: routed.debug.contradictions ?? [],
    answer: sanitizeFinalAnswer(routed.answer),
    selectedPrimary: withPdfCitationLinks(routed.selectedPrimary, routed.answer),
    documentSummary: routed.documentSummary,
    scope: responseScope,
    docIds: [],
    documents: options.sourceDocuments,
    mode: options.mode,
    indexSource: cacheInfo.indexSource,
    indexSourceDetails: indexSource,
    cachedDocumentCount: cacheInfo.cachedDocumentCount,
    cacheFreshness: cacheInfo.cacheFreshness,
    pageIndexUploadStatus: cacheInfo.pageIndexUploadStatus,
    retrieval: {
      source: options.retrieval?.retrievalSource ?? "local-metadata",
      bm25FallbackUsed: options.retrieval?.bm25FallbackUsed ?? false,
      pageIndexResultCount: options.retrieval?.pageIndexResultCount ?? 0,
      contrastTerms: options.retrieval?.contrastTerms ?? [],
      selectedSection: withPdfCitationLinks(routed.selectedPrimary, routed.answer),
      finalHsCodes,
      answerRepairApplied: false
    },
    citations: withPdfCitationLinksList(routed.citations, routed.answer),
    retrievedSections: [],
    metadataWarnings: [],
    answerGeneration,
    llmCalled,
    llmSkippedReason,
    llmErrorType,
    sectionTextChars: typeof routed.debug.sectionTextChars === "number" ? routed.debug.sectionTextChars : 0,
    selectedSectionTextChars: typeof routed.debug.selectedSectionTextChars === "number" ? routed.debug.selectedSectionTextChars : 0,
    localExtractorUsed: Boolean(routed.debug.localExtractorUsed),
    localExtractorConfidence,
    localExtractorReason: typeof routed.debug.localExtractorReason === "string" ? routed.debug.localExtractorReason : null,
    hsCodeAttached: Boolean(routed.debug.hsCodeAttached),
    contextChars: typeof routed.debug.contextChars === "number" ? routed.debug.contextChars : 0,
    fallbackReason,
    validation: QAValidator.validateResponse(routed.answer, { requireCitations: false })
  };
  return options.debug ? { ...response, debug: { ...routed.debug, scope: response.scope, scopeApplied: true, finalAnswerSanitized: true } } : response;
}

function responseAnswerGeneration(routed: RoutedQaAnswer): QaAnswerGenerationMode {
  if (isQaAnswerGenerationMode(routed.debug.answerGeneration)) {
    return routed.debug.answerGeneration;
  }
  if (routed.intent === "exact_hscode_lookup" || routed.intent === "product_classification") {
    return "template-classification";
  }
  if (routed.intent === "definition") {
    return "extractive-definition";
  }
  return "safe-fallback";
}

function isQaAnswerGenerationMode(value: unknown): value is QaAnswerGenerationMode {
  return value === "template-classification" ||
    value === "extractive-definition" ||
    value === "extractive-field" ||
    value === "broad-lookup" ||
    value === "llm-selected-section" ||
    value === "safe-fallback";
}

function isSuccessfulLocalAnswer(result: LocalAnswerResult | null | undefined): result is LocalAnswerResult & { answer: string } {
  if (!result?.answer) {
    return false;
  }
  return (
    result.answerGeneration !== "safe-fallback" &&
    result.confidence !== "low" &&
    (
      result.answerGeneration === "template-classification" ||
      result.answerGeneration === "extractive-definition" ||
      result.answerGeneration === "extractive-field" ||
      result.answerGeneration === "broad-lookup"
    )
  );
}

function isHighQualityLocalAnswer(result: LocalAnswerResult | null | undefined, query: string): boolean {
  if (!isSuccessfulLocalAnswer(result)) return false;
  if (result.answerGeneration === "template-classification") return true;
  if (result.answerGeneration === "broad-lookup") return true;
  const answer = normalizeSearchText(result.answer);
  const queryTokens = tokenizeForSearch(query).filter((token) => token.length >= 4);
  if (queryTokens.length === 0) return true;
  const matchedInAnswer = queryTokens.filter((token) => answer.includes(token));
  if (matchedInAnswer.length === 0) return false;
  if (queryTokens.length >= 3 && matchedInAnswer.length <= 1) return false;
  return true;
}

function isSuccessfulLegacyLocalAnswer(result: LocalSelectedSectionAnswer | null | undefined): result is LocalSelectedSectionAnswer & { answer: string } {
  const confidence = result?.fieldExtraction?.confidence;
  return Boolean(result?.answer) &&
    result?.answerGeneration !== null &&
    result?.answerGeneration !== "safe-fallback" &&
    confidence !== "low";
}

function isAnswerConfidence(value: unknown): value is "high" | "medium" | "low" {
  return value === "high" || value === "medium" || value === "low";
}

function publicCachedTreeDocument(document: CachedTreeDocument): Record<string, unknown> {
  return {
    document: document.document,
    docId: document.docId ?? null,
    treePath: document.treePath,
    pdfUrl: pdfUrlForDocument(document.document),
    status: document.pageIndexCacheStatus
  };
}

function rankRetrievedSectionsByUsability(hits: EnrichedRetrievedSection[], question: string): EnrichedRetrievedSection[] {
  const ranked = rankSectionsForQuestion(hits, question);
  const hasHsCodeHit = ranked.some(hasSectionHsMetadata);
  return ranked.sort((left, right) => {
    if (hasHsCodeHit && hasSectionHsMetadata(left) !== hasSectionHsMetadata(right)) {
      return hasSectionHsMetadata(left) ? -1 : 1;
    }
    return right.score - left.score || left.document.localeCompare(right.document);
  });
}

interface SearchScoringContext {
  queryTokens: string[];
  signals: QuerySignals;
  contrast: ReturnType<typeof detectContrastTerms>;
}

interface SearchDocumentFields {
  title: string;
  heading: string;
  body: string;
  captions: string;
  source: string;
  hsCodes?: string[];
}

function searchLocalSectionMetadataFallback(
  scoringContext: SearchScoringContext,
  sections: SectionMetadata[],
  documentMetadata: QaDocumentMetadata[] = []
): EnrichedRetrievedSection[] {
  const baseSections = hydrateSectionsForSearch(sections.map((section) => sectionMetadataToRetrievedForSearch(section)), sections, documentMetadata);
  return baseSections.flatMap((section) => {
    const scored = scoreSearchFields(scoringContext, searchFieldsForSection(section));
    const score = scored.total;
    if (score <= 0) {
      return [];
    }

    return [{
      ...section,
      score,
      scoreBreakdown: scored.breakdown
    }];
  });
}

function buildSearchScoringContext(
  question: string,
  signals: QuerySignals = extractQuerySignals(question),
  contrast: ReturnType<typeof detectContrastTerms> = detectContrastTerms(question)
): SearchScoringContext {
  const baselineTokens = new Set(contrast.baselineTokens);
  const queryTokens = uniqueStrings([
    ...tokenizeForSearch(question),
    ...signals.queryTokens,
    ...signals.physicalAttributes.flatMap(tokenizeForSearch),
    ...signals.usageTerms.flatMap(tokenizeForSearch),
    ...signals.tradeForms.flatMap(tokenizeForSearch),
    ...signals.scientificNames.flatMap(tokenizeForSearch)
  ]).filter((token) => !baselineTokens.has(token));
  return { queryTokens, signals, contrast };
}

function scoreSearchFields(scoringContext: SearchScoringContext, fields: SearchDocumentFields): { total: number; breakdown: ScoreBreakdown } {
  const baselineTokens = new Set(scoringContext.contrast.baselineTokens);
  const titleHaystack = normalizeSearchText(`${fields.title} ${(fields.hsCodes ?? []).join(" ")}`);
  const headingHaystack = normalizeSearchText(fields.heading);
  const bodyHaystack = normalizeSearchText(fields.body);
  const captionHaystack = normalizeSearchText(fields.captions);
  const sourceHaystack = normalizeSearchText(fields.source);
  const positiveTokens = scoringContext.queryTokens.filter((token) => !baselineTokens.has(token));
  const exactHsCodeTokens = positiveTokens.filter((token) => HS_CODE_PATTERN.test(token));
  const phraseSignals = uniqueStrings([
    ...scoringContext.signals.queryPhrases,
    ...scoringContext.signals.physicalAttributes,
    ...scoringContext.signals.usageTerms,
    ...scoringContext.signals.tradeForms,
    ...scoringContext.signals.scientificNames
  ]).filter((phrase) => tokenizeForSearch(phrase).length >= 2);
  const aliasSignals = scoringContext.signals.domainAliasTerms;

  const breakdown: ScoreBreakdown = {
    hsCode: exactHsCodeTokens.reduce((sum, token) => sum + countSearchToken(titleHaystack, token) * 40, 0),
    alias:
      phraseFieldScore(aliasSignals, titleHaystack, 42) +
      phraseFieldScore(aliasSignals, headingHaystack, 34) +
      phraseFieldScore(aliasSignals, bodyHaystack, 26) +
      phraseFieldScore(aliasSignals, captionHaystack, 22),
    title: tokenFieldScore(positiveTokens, titleHaystack, 7) + phraseFieldScore(phraseSignals, titleHaystack, 14),
    heading: tokenFieldScore(positiveTokens, headingHaystack, 6) + phraseFieldScore(phraseSignals, headingHaystack, 11),
    body: tokenFieldScore(positiveTokens, bodyHaystack, 3) + phraseFieldScore(phraseSignals, bodyHaystack, 8),
    captions: tokenFieldScore(positiveTokens, captionHaystack, 4) + phraseFieldScore(phraseSignals, captionHaystack, 6),
    source: tokenFieldScore(positiveTokens, sourceHaystack, 1),
    numeric: scoringContext.signals.numericRanges.reduce((sum, range) =>
      sum + (fieldIncludesSignal(`${titleHaystack} ${headingHaystack} ${bodyHaystack} ${captionHaystack}`, range) ? 11 : 0), 0),
    scientific: scoringContext.signals.scientificNames.reduce((sum, name) =>
      sum + (fieldIncludesSignal(titleHaystack, name) ? 12 : fieldIncludesSignal(bodyHaystack, name) ? 8 : 0), 0),
    contrastPenalty: -scoringContext.contrast.baselineTokens.reduce((sum, token) =>
      sum + countSearchToken(titleHaystack, token) * 6 + countSearchToken(headingHaystack, token) * 4 + countSearchToken(bodyHaystack, token) * 1, 0)
  };
  return {
    total: Object.values(breakdown).reduce((sum, value) => sum + value, 0),
    breakdown
  };
}

function tokenFieldScore(tokens: string[], haystack: string, weight: number): number {
  return tokens.reduce((sum, token) => sum + countSearchToken(haystack, token) * weight, 0);
}

function phraseFieldScore(phrases: string[], haystack: string, weight: number): number {
  return phrases.reduce((sum, phrase) => sum + (fieldIncludesSignal(haystack, phrase) ? weight : 0), 0);
}

function fieldIncludesSignal(haystack: string, signal: string): boolean {
  const normalized = normalizeSearchText(signal);
  if (!normalized) {
    return false;
  }
  if (/^[a-z0-9.]+$/i.test(normalized)) {
    return countSearchToken(haystack, normalized) > 0;
  }
  return haystack.includes(normalized);
}

function countSearchToken(text: string, token: string): number {
  let count = 0;
  const pattern = new RegExp(`(?:^|[^a-z0-9.])${escapeRegExp(token)}(?=$|[^a-z0-9.])`, "g");
  for (const _match of text.matchAll(pattern)) {
    count += 1;
  }
  return count;
}

function searchFieldsForSection(section: EnrichedRetrievedSection): SearchDocumentFields {
  return {
    title: `${section.hsCode ?? ""} ${(section.groupedHsCodes ?? []).join(" ")} ${section.title ?? ""}`,
    heading: `${section.section ?? ""} ${section.title ?? ""}`,
    body: section.text ?? "",
    captions: (section.captions ?? []).join(" "),
    source: `${section.source ?? ""} ${section.chapter ?? ""} ${section.document}`,
    hsCodes: hsCodesForSection(section)
  };
}

function sectionMetadataToRetrievedForSearch(section: SectionMetadata): EnrichedRetrievedSection {
  return {
    document: section.document,
    chapter: section.chapter,
    hsCode: section.hsCode,
    groupedHsCodes: section.groupedHsCodes ?? [],
    title: section.title,
    section: section.section,
    pageStart: section.pageStart,
    pageEnd: section.pageEnd,
    source: section.source,
    text: section.text ?? section.textPreview ?? "",
    captions: section.captions ?? [],
    score: 0,
    metadataWarnings: [],
    hydrationSource: section.text ? "section-metadata" : "retrieval"
  };
}

export function hydrateSectionsForSearch(
  sections: EnrichedRetrievedSection[],
  sectionMetadata: SectionMetadata[],
  documentMetadata: QaDocumentMetadata[]
): EnrichedRetrievedSection[] {
  return sections.map((section) => hydrateSectionForSearch(section, sectionMetadata, documentMetadata));
}

function hydrateSectionForSearch(
  section: EnrichedRetrievedSection,
  sectionMetadata: SectionMetadata[],
  documentMetadata: QaDocumentMetadata[]
): EnrichedRetrievedSection {
  const metadata = findMatchingSectionMetadata(section, sectionMetadata);
  const metadataText = [metadata?.text, metadata?.textPreview].filter(Boolean).join("\n\n").trim();
  const metadataCaptions = metadata?.captions ?? [];
  const markdownText = documentMetadata
    .filter((document) => document.document === section.document)
    .map((document) => [document.markdownText, document.rootText].filter(Boolean).join("\n\n"))
    .find((text) => text.trim()) ?? "";
  const markdownSection = markdownText ? extractMarkdownSectionBody(markdownText, {
    ...section,
    hsCode: section.hsCode ?? metadata?.hsCode,
    title: section.title ?? metadata?.title,
    section: section.section ?? metadata?.section
  }) : "";
  const currentText = section.text ?? "";
  const candidates = [
    { text: currentText, source: section.hydrationSource ?? "retrieval" as const },
    { text: metadataText, source: "section-metadata" as const },
    { text: markdownSection, source: "markdown" as const }
  ].filter((item) => item.text.trim());
  const best = candidates.sort((left, right) => hydrationTextQuality(right.text) - hydrationTextQuality(left.text))[0];
  return {
    ...section,
    chapter: section.chapter ?? metadata?.chapter,
    hsCode: section.hsCode ?? metadata?.hsCode,
    groupedHsCodes: section.groupedHsCodes?.length ? section.groupedHsCodes : metadata?.groupedHsCodes ?? [],
    title: section.title ?? metadata?.title,
    section: section.section ?? metadata?.section,
    pageStart: section.pageStart ?? metadata?.pageStart,
    pageEnd: section.pageEnd ?? metadata?.pageEnd,
    source: section.source ?? metadata?.source,
    text: best?.text ?? currentText,
    captions: uniqueStrings([...(section.captions ?? []), ...metadataCaptions]),
    hydrationSource: best?.source ?? section.hydrationSource ?? "retrieval"
  };
}

function hydrationTextQuality(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) {
    return 0;
  }
  const previewPenalty = isLikelyPreviewOnlyText(trimmed) ? 500 : 0;
  return trimmed.length - previewPenalty;
}

function mergeSearchCandidates(sections: EnrichedRetrievedSection[]): EnrichedRetrievedSection[] {
  const byKey = new Map<string, EnrichedRetrievedSection>();
  for (const section of sections) {
    const key = [
      section.document,
      hsCodesForSection(section).join("|"),
      normalizeSearchText(section.title ?? ""),
      normalizeSearchText(section.section ?? "")
    ].join("|");
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, section);
      continue;
    }
    byKey.set(key, {
      ...existing,
      ...section,
      text: hydrationTextQuality(section.text) > hydrationTextQuality(existing.text) ? section.text : existing.text,
      captions: uniqueStrings([...(existing.captions ?? []), ...(section.captions ?? [])]),
      score: Math.max(existing.score, section.score),
      scoreBreakdown: (section.score >= existing.score ? section.scoreBreakdown : existing.scoreBreakdown) ?? section.scoreBreakdown ?? existing.scoreBreakdown,
      hydrationSource: section.hydrationSource === "markdown" || existing.hydrationSource === "markdown"
        ? "markdown"
        : section.hydrationSource ?? existing.hydrationSource
    });
  }
  return [...byKey.values()];
}

async function loadSectionMetadata(documentNames: string[], scope: QaScopeTracker = createQaScope(documentNames)): Promise<SectionMetadata[]> {
  const records: SectionMetadata[] = [];
  const seen = new Set<string>();
  const allowedDocuments = new Set(documentNames);
  const append = (items: unknown[], fallbackDocument?: string) => {
    for (const item of items) {
      if (typeof item !== "object" || item === null) {
        continue;
      }
      const section = normalizeSectionMetadata(item as Record<string, unknown>, fallbackDocument);
      if (allowedDocuments.size > 0 && !allowedDocuments.has(section.document)) {
        if (scope.mode === "selected") {
          scope.filteredOutCandidateCount += 1;
        }
        continue;
      }
      if (!scopeAllowsDocument(scope, section.document)) {
        continue;
      }
      const key = `${section.document}|${section.hsCode ?? ""}|${section.section ?? ""}`;
      if (!section.document || seen.has(key)) {
        continue;
      }
      seen.add(key);
      records.push(section);
    }
  };

  const allSections = await readOptionalJson<unknown>(path.join(convertedDir, "all.sections.json"));
  if (Array.isArray(allSections)) {
    append(allSections);
  }

  for (const documentName of documentNames) {
    const sectionPath = path.join(convertedDir, documentName.replace(/\.pdf$/i, ".sections.json"));
    const payload = await readOptionalJson<unknown>(sectionPath);
    if (Array.isArray(payload)) {
      append(payload, documentName);
      continue;
    }
    if (typeof payload === "object" && payload !== null && Array.isArray((payload as { sections?: unknown[] }).sections)) {
      append((payload as { sections: unknown[] }).sections, documentName);
    }
  }

  return propagateGroupedSectionPageRanges(records);
}

async function loadDocumentMetadata(documentNames: string[]): Promise<QaDocumentMetadata[]> {
  const byDocument = new Map<string, QaDocumentMetadata>();
  const scoped = new Set(documentNames);
  const put = (document: QaDocumentMetadata) => {
    if (!document.document) {
      return;
    }
    if (scoped.size > 0 && !scoped.has(document.document)) {
      return;
    }
    byDocument.set(document.document, { ...(byDocument.get(document.document) ?? {}), ...document });
  };

  const manifest = await readOptionalJson<{ documents?: unknown[] }>(path.join(convertedDir, "batch.manifest.json"));
  for (const item of manifest?.documents ?? []) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const input = stringValue(record.input);
    const document = input ? path.basename(input) : path.basename(stringValue(record.sections) ?? "");
    const markdownPath = stringValue(record.markdown);
    const rootText = markdownPath ? await readOptionalText(resolveWorkspacePath(markdownPath)) : "";
    put({
      document: document || path.basename(stringValue(record.tree) ?? ""),
      input,
      markdown: markdownPath,
      sections: stringValue(record.sections),
      tree: stringValue(record.tree),
      documentType: stringValue(record.documentType),
      markdownText: rootText,
      rootText
    });
  }

  const allDocuments = await readOptionalJson<unknown>(path.join(convertedDir, "all.documents.json"));
  if (Array.isArray(allDocuments)) {
    for (const item of allDocuments) {
      if (typeof item !== "object" || item === null) {
        continue;
      }
      const record = item as Record<string, unknown>;
      const document = stringValue(record.document);
      if (!document) {
        continue;
      }
      put({
        document,
        documentType: stringValue(record.documentType) ?? stringValue(record.status)
      });
    }
  }

  for (const documentName of documentNames) {
    if (!byDocument.has(documentName)) {
      const markdown = await readOptionalText(path.join(convertedDir, documentName.replace(/\.pdf$/i, ".milestone1.md")));
      put({
        document: documentName,
        markdown: markdown ? relativePath(path.join(convertedDir, documentName.replace(/\.pdf$/i, ".milestone1.md"))) : undefined,
        markdownText: markdown,
        rootText: markdown
      });
    }
  }

  return [...byDocument.values()].sort((left, right) => left.document.localeCompare(right.document));
}

async function buildSourceTextView(
  documentName: string,
  options: { query?: string; hsCode?: string; section?: string; page?: number }
): Promise<SourceTextView> {
  const document = safeRequestedPdfName(documentName);
  if (!document) {
    throw new Error("Invalid PDF filename.");
  }

  const inputPath = path.resolve(uploadsDir, document);
  if (!inputPath.startsWith(`${uploadsDir}${path.sep}`) || !(await fileExists(inputPath))) {
    throw new Error("Source PDF is not available.");
  }

  const query = normalizeSourceWhitespace(options.query ?? "").replace(/\.\.\.$/, "").trim();
  const sections = await loadSectionMetadata([document], createQaScope([document]));
  const selected = selectSourceSection(sections, {
    query,
    hsCode: options.hsCode,
    section: options.section,
    page: options.page
  });
  const documentMetadata = await loadDocumentMetadata([document]);
  const fallbackText = documentMetadata.map((item) => item.markdownText || item.rootText || "").find((text) => text.trim()) ?? "";
  const sourceText = normalizeSourceWhitespace(selected ? sourceTextFromSection(selected) : fallbackText);
  if (!sourceText) {
    throw new Error("No source text is available for this document.");
  }

  return {
    document,
    pdfUrl: `/api/uploads/${encodeURIComponent(document)}`,
    page: selected?.pageStart ?? options.page,
    hsCode: selected?.hsCode ?? options.hsCode,
    section: selected?.section ?? options.section,
    title: selected?.title,
    sourceText,
    query,
    matchFound: Boolean(query && sourceTextIncludesQuery(sourceText, query))
  };
}

function selectSourceSection(
  sections: SectionMetadata[],
  options: { query?: string; hsCode?: string; section?: string; page?: number }
): SectionMetadata | undefined {
  if (sections.length === 0) {
    return undefined;
  }
  const queryTokens = sourceScoringTokens(options.query ?? "");
  const requestedSection = normalizeSearchText(options.section ?? "");
  const scored = sections.map((section, index) => {
    const sourceText = sourceTextFromSection(section);
    const normalizedSource = normalizeSearchText(sourceText);
    const pageStart = Number(section.pageStart || 0);
    const pageEnd = Number(section.pageEnd || pageStart);
    let score = 0;
    if (options.hsCode && (section.hsCode === options.hsCode || (section.groupedHsCodes ?? []).includes(options.hsCode))) {
      score += 20;
    }
    if (options.section && requestedSection && normalizeSearchText(section.section ?? "").includes(requestedSection)) {
      score += 12;
    }
    if (options.page && pageStart > 0 && options.page >= pageStart && options.page <= (pageEnd || pageStart)) {
      score += 8;
    }
    if (options.query && normalizedSource.includes(normalizeSearchText(options.query))) {
      score += 30;
    }
    if (queryTokens.length > 0) {
      const sourceTokens = new Set(sourceScoringTokens(sourceText));
      score += queryTokens.filter((token) => sourceTokens.has(token)).length;
    }
    return { section, score, index };
  });
  return scored.sort((left, right) => right.score - left.score || left.index - right.index)[0]?.section;
}

function createQaDebugReport(question: string, retrieval: CachedTreeRetrievalResult): Record<string, unknown> {
  const candidates = retrieval.bm25FallbackUsed ? retrieval.bm25Results : retrieval.pageIndexResults;
  const acceptedCandidates = candidates.filter((candidate) => candidate.validation?.accepted ?? !candidate.rejected);
  const selectedCandidateValidation = acceptedCandidates[0]?.validation ?? null;
  return {
    query: question,
    extractedSignals: retrieval.signals,
    domainAliasTerms: retrieval.signals.domainAliasTerms,
    retrieval: {
      pageIndexResults: retrieval.pageIndexResults,
      bm25FallbackUsed: retrieval.bm25FallbackUsed,
      bm25Results: retrieval.bm25Results
    },
    candidates,
    candidateAliasSignals: uniqueStrings(candidates.flatMap((candidate) => candidate.candidateAliasSignals ?? [])),
    candidatesBeforeValidation: candidates.length,
    candidatesAfterValidation: acceptedCandidates.length,
    rejectedCandidateReasons: candidates
      .filter((candidate) => candidate.rejected || candidate.validation?.accepted === false)
      .map((candidate) => ({
        document: candidate.document,
        hsCode: candidate.hsCode ?? null,
        title: candidate.title ?? null,
        section: candidate.section ?? null,
        reason: candidate.validation?.reason ?? candidate.rejectedReason,
        validation: candidate.validation ?? null
      })),
    selectedCandidateValidation,
    strongSignals: selectedCandidateValidation?.strongSignals ?? [],
    weakSignals: selectedCandidateValidation?.weakSignals ?? [],
    missingEvidence: selectedCandidateValidation?.missingEvidence ?? [],
    selectedPrimary: {},
    finalAnswerHsCodes: [],
    answerRepairApplied: false
  };
}

function defaultQueryExpansionDebug(question: string): QueryExpansionDebug {
  return {
    originalQuery: question,
    expandedQuery: question,
    expansionTerms: [],
    expansionSource: "none",
    confidence: "low",
    error: null,
    cacheHit: false
  };
}

function hydrateSelectedSectionText(
  section: EnrichedRetrievedSection,
  sectionMetadata: SectionMetadata[],
  documentMetadata: QaDocumentMetadata[]
): EnrichedRetrievedSection {
  if (selectedSectionTextChars(section) > 0 && !isLikelyPreviewOnlyText(section.text)) {
    return section;
  }

  let metadataHydrated: EnrichedRetrievedSection | undefined;
  const metadata = findMatchingSectionMetadata(section, sectionMetadata);
  if (metadata) {
    const text = [metadata.text, metadata.textPreview].filter(Boolean).join("\n\n").trim();
    const captions = uniqueStrings([...(section.captions ?? []), ...(metadata.captions ?? [])]);
    if (text || captions.length > 0) {
      metadataHydrated = {
        ...section,
        chapter: section.chapter ?? metadata.chapter,
        pageStart: section.pageStart ?? metadata.pageStart,
        pageEnd: section.pageEnd ?? metadata.pageEnd,
        source: section.source ?? metadata.source,
        text,
        captions
      };
      if (!isLikelyPreviewOnlyText(text)) {
        return metadataHydrated;
      }
    }
  }

  const markdownText = documentMetadata
    .filter((document) => document.document === section.document)
    .map((document) => [document.markdownText, document.rootText].filter(Boolean).join("\n\n"))
    .find((text) => text.trim());
  const markdownSection = markdownText ? extractMarkdownSectionBody(markdownText, section) : "";
  return markdownSection ? { ...section, text: markdownSection } : metadataHydrated ?? section;
}

function selectedSectionTextChars(section: EnrichedRetrievedSection): number {
  return `${section.text ?? ""} ${(section.captions ?? []).join(" ")}`.trim().length;
}

function isLikelyPreviewOnlyText(text: string | undefined): boolean {
  const trimmed = text?.trim() ?? "";
  return Boolean(trimmed) && trimmed.length < 700 && /\.\.\./.test(trimmed);
}

function validatedCandidateForLocalAnswer(
  section: EnrichedRetrievedSection,
  candidates: CandidateRelevance[]
): ValidatedCandidate {
  const relevance = matchingCandidateForSection(section, candidates) ?? evaluateCandidateRelevance(section, section.title ?? section.section ?? section.text);
  const validation: ValidatedCandidate["validation"] = relevance.validation ?? {
    accepted: !relevance.rejected,
    confidence: relevance.rejected ? "low" : "medium",
    reason: relevance.rejectedReason ?? "selected candidate accepted by retrieval",
    strongSignals: [],
    weakSignals: relevance.rejected ? ["existing_relevance_rejection"] : [],
    missingEvidence: relevance.rejected ? ["accepted_relevance_gate"] : []
  };

  return {
    ...section,
    relevance,
    validation
  };
}

function validatedCandidateFromRelevanceCandidate(candidate: CandidateRelevance): ValidatedCandidate {
  return {
    document: candidate.document,
    hsCode: candidate.hsCode,
    groupedHsCodes: candidate.groupedHsCodes,
    title: candidate.title,
    section: candidate.section,
    pageStart: candidate.pageStart ?? undefined,
    pageEnd: candidate.pageEnd ?? undefined,
    source: candidate.source,
    text: "",
    captions: [],
    score: candidate.finalScore,
    metadataWarnings: [],
    relevance: candidate,
    validation: candidate.validation ?? {
      accepted: !candidate.rejected,
      confidence: candidate.rejected ? "low" : "medium",
      reason: candidate.rejectedReason ?? "candidate accepted by retrieval",
      strongSignals: [],
      weakSignals: candidate.rejected ? ["existing_relevance_rejection"] : [],
      missingEvidence: candidate.rejected ? ["accepted_relevance_gate"] : []
    }
  };
}

function matchingCandidateForSection(
  section: EnrichedRetrievedSection,
  candidates: CandidateRelevance[]
): CandidateRelevance | undefined {
  const codes = new Set(hsCodesForSection(section));
  const sectionTitle = normalizeSearchText(section.title ?? "");
  const sectionHeading = normalizeSearchText(section.section ?? "");
  return candidates.find((candidate) => {
    if (candidate.document !== section.document) {
      return false;
    }
    if (candidate.hsCode && codes.has(candidate.hsCode)) {
      return true;
    }
    if (candidate.groupedHsCodes.some((code) => codes.has(code))) {
      return true;
    }
    const candidateTitle = normalizeSearchText(candidate.title ?? "");
    const candidateHeading = normalizeSearchText(candidate.section ?? "");
    return Boolean(
      (sectionTitle && candidateTitle && sectionTitle === candidateTitle) ||
      (sectionHeading && candidateHeading && sectionHeading === candidateHeading)
    );
  });
}

function findMatchingSectionMetadata(
  section: EnrichedRetrievedSection,
  sectionMetadata: SectionMetadata[]
): SectionMetadata | undefined {
  const codes = new Set(hsCodesForSection(section));
  const normalizedTitle = normalizeSearchText(`${section.title ?? ""} ${section.section ?? ""}`);
  return sectionMetadata.find((candidate) => {
    if (candidate.document !== section.document) {
      return false;
    }
    const candidateCodes = new Set([...(candidate.groupedHsCodes ?? []), candidate.hsCode].filter((code): code is string => Boolean(code)));
    if ([...codes].some((code) => candidateCodes.has(code))) {
      return true;
    }
    const candidateTitle = normalizeSearchText(`${candidate.title ?? ""} ${candidate.section ?? ""}`);
    return Boolean(normalizedTitle && candidateTitle && (normalizedTitle.includes(candidateTitle) || candidateTitle.includes(normalizedTitle)));
  });
}

function extractMarkdownSectionBody(markdown: string, section: EnrichedRetrievedSection): string {
  const lines = markdown.split(/\r?\n/g);
  const code = section.hsCode;
  const title = normalizeSearchText(section.title ?? section.section ?? "");
  const startIndex = lines.findIndex((line) => {
    const normalized = normalizeSearchText(line);
    return Boolean(
      line.startsWith("#") &&
      ((code && line.includes(code)) || (title && normalized.includes(title)))
    );
  });
  if (startIndex < 0) {
    return "";
  }
  const startLevel = headingLevel(lines[startIndex]);
  const body: string[] = [];
  for (const line of lines.slice(startIndex + 1)) {
    const level = headingLevel(line);
    if (level > 0 && level <= startLevel) {
      break;
    }
    body.push(line);
  }
  return body.join("\n").replace(/\s+/g, " ").trim();
}

function headingLevel(line: string): number {
  return line.match(/^(#{1,6})\s/)?.[1].length ?? 0;
}

function answerMentionsHsCodeOutsideSection(answer: string, section: EnrichedRetrievedSection): boolean {
  const allowedCodes = new Set(hsCodesForSection(section));
  if (allowedCodes.size === 0) {
    return false;
  }
  const mentionedCodes = [...answer.matchAll(new RegExp(HS_CODE_PATTERN.source, "g"))].map((match) => match[0]);
  return mentionedCodes.some((code) => !allowedCodes.has(code));
}

function isNumericOnlyQuestion(question: string): boolean {
  return /^\s*\d+(?:[.,]\d+)?\s*%?\s*$/.test(question);
}

function normalizeTreeRoots(payload: Record<string, unknown> | undefined): unknown[] {
  if (!payload) {
    return [];
  }
  if (Array.isArray(payload.tree)) {
    return payload.tree;
  }
  const rawResponse = typeof payload.rawResponse === "object" && payload.rawResponse !== null
    ? (payload.rawResponse as Record<string, unknown>)
    : undefined;
  return Array.isArray(rawResponse?.structure) ? rawResponse.structure : [];
}

function flattenCachedTreeNodes(nodes: unknown[]): Array<{ title: string; text: string }> {
  const refs: Array<{ title: string; text: string }> = [];
  for (const node of nodes) {
    if (typeof node !== "object" || node === null) {
      continue;
    }
    const record = node as Record<string, unknown>;
    const title = stringValue(record.title) ?? "";
    const text = [stringValue(record.text), stringValue(record.summary), stringValue(record.prefix_summary)]
      .filter(Boolean)
      .join("\n");
    if (title || text) {
      refs.push({ title, text });
    }
    const children = Array.isArray(record.nodes) ? record.nodes : Array.isArray(record.children) ? record.children : [];
    refs.push(...flattenCachedTreeNodes(children));
  }
  return refs;
}

function tokenizeForSearch(text: string): string[] {
  const tokens = uniqueStrings(
    normalizeSearchText(text)
      .split(/[^a-z0-9.]+/g)
      .map(normalizeSearchToken)
      .filter((token) => token.length >= 3 && !SEARCH_STOPWORDS.has(token))
  );
  return tokens.length > 0 ? tokens : uniqueStrings(normalizeSearchText(text).split(/[^a-z0-9.]+/g).map(normalizeSearchToken).filter((token) => token.length >= 3));
}

function normalizeSearchText(text: string): string {
  return text
    .replace(/[đĐ]/g, "d")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\bca\s+phe\b/g, "coffee")
    .replace(/\bwoodchips\b/g, "wood chips");
}

function normalizeSearchToken(token: string): string {
  if (token === "higher" || token === "highest") return "high";
  if (token === "lower" || token === "lowest") return "low";
  if (token === "larger" || token === "largest") return "large";
  if (token === "longer" || token === "longest") return "long";
  if (token === "rounder") return "round";
  if (token === "coarser") return "coarse";
  if (token === "smoother") return "smooth";
  if (token === "dried" || token === "drier") return "dry";
  return token;
}

function countOccurrences(text: string, token: string): number {
  let count = 0;
  let index = text.indexOf(token);
  while (index >= 0) {
    count += 1;
    index = text.indexOf(token, index + token.length);
  }
  return count;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractCachedDocId(payload: Record<string, unknown> | undefined): string | undefined {
  if (!payload) {
    return undefined;
  }

  const rawResponse =
    typeof payload.rawResponse === "object" && payload.rawResponse !== null
      ? (payload.rawResponse as Record<string, unknown>)
      : undefined;

  return (
    stringValue(payload.docId) ??
    stringValue(payload.doc_id) ??
    stringValue(payload.id) ??
    stringValue(rawResponse?.doc_id) ??
    stringValue(rawResponse?.docId) ??
    stringValue(rawResponse?.id)
  );
}

function pageNumberFromAssetName(fileName: string): number | undefined {
  const match = /-p(\d+)-/i.exec(fileName);
  if (!match) {
    return undefined;
  }
  const page = Number(match[1]);
  return Number.isFinite(page) ? page : undefined;
}

interface CacheStatusFile {
  name: string;
  size?: number;
  lastModified?: number;
  inputHash?: string;
}

function parseCacheStatusFiles(value: unknown): CacheStatusFile[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item) => {
    if (typeof item !== "object" || item === null) {
      throw new Error("Invalid cache status file payload.");
    }
    const record = item as Record<string, unknown>;
    const name = stringValue(record.name);
    if (!name || path.extname(name).toLowerCase() !== ".pdf") {
      throw new Error("Cache status only accepts .pdf files.");
    }
    return {
      name,
      size: numberValue(record.size),
      lastModified: numberValue(record.lastModified),
      inputHash: stringValue(record.inputHash)
    };
  });
}

function parseCachedRunFiles(value: unknown): CacheStatusFile[] {
  const text = Array.isArray(value) ? stringValue(value[0]) : stringValue(value);
  if (!text) {
    return [];
  }
  const parsed = JSON.parse(text) as unknown;
  return parseCacheStatusFiles(Array.isArray(parsed) ? parsed : []);
}

async function resolveCachedRunFiles(files: CacheStatusFile[]): Promise<string[]> {
  const inputFiles: string[] = [];
  for (const file of files) {
    const document = safePdfFileName(file.name);
    const inputPath = path.resolve(uploadsDir, document);
    if (!inputPath.startsWith(`${uploadsDir}${path.sep}`)) {
      throw new Error(`Invalid cached PDF filename: ${file.name}`);
    }
    const fileStat = await stat(inputPath).catch(() => undefined);
    if (!fileStat?.isFile()) {
      throw new Error(`Cached input ${document} is not available on the server. Upload the PDF and retry.`);
    }
    if (file.inputHash) {
      const currentHash = await sha256File(inputPath);
      if (currentHash !== file.inputHash.toLowerCase()) {
        throw new Error(`Cached input ${document} no longer matches the selected PDF. Upload the PDF and retry.`);
      }
    }
    inputFiles.push(inputPath);
  }
  return inputFiles;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function safePdfFileName(fileName: string): string {
  const parsed = path.parse(fileName);
  const base = parsed.name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "upload";
  return `${base}.pdf`;
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

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstStringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    const resolved = stringValue(value);
    if (resolved) {
      return resolved;
    }
  }

  return undefined;
}

function stringListValue(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => splitDocIds(stringValue(item)));
}

function splitDocIds(value: string | undefined): string[] {
  return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function numberValue(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function numberFromUnknown(value: unknown): number | undefined {
  return numberValue(value);
}

function booleanValue(value: unknown): boolean {
  return value === "true" || value === "on" || value === "1" || value === true;
}

function hasOwn(value: unknown, key: string): boolean {
  return typeof value === "object" && value !== null && Object.prototype.hasOwnProperty.call(value, key);
}

function parseAnswerStyle(value: unknown): AnswerStyleOption {
  return value === "verbose" ? "verbose" : "class-eval";
}

function relativePath(filePath: string | undefined): string | undefined {
  if (!filePath) {
    return undefined;
  }

  return path.relative(process.cwd(), path.resolve(filePath)).replace(/\\/g, "/");
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

async function writeJson(filePath: string, content: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(content, null, 2)}\n`, "utf8");
}

async function saveJobDebugLog(
  jobId: string,
  inputFile: string,
  command: string | undefined,
  error: string
): Promise<void> {
  const job = JobStore.snapshot(jobId);
  if (!job) {
    return;
  }

  await ensureDirectory(tmpDir);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const baseName = path.basename(inputFile, path.extname(inputFile));
  const filePath = path.join(tmpDir, `${baseName}.ui-job-${jobId}.${timestamp}.json`);
  JobStore.addTrace(jobId, "saveJobDebugLog", "writing debug log", {
    inputFile: relativePath(inputFile),
    path: relativePath(filePath)
  });
  await writeFile(
    filePath,
    `${JSON.stringify(
      {
        jobId,
        inputFile: relativePath(inputFile),
        command,
        status: job.status,
        currentStep: job.currentStep,
        elapsedMs: job.elapsedMs,
        error,
        logs: job.logs
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

function serverTrace(functionName: string, message: string, details: Record<string, unknown> = {}): void {
  if (process.env.QA_EVAL_QUIET === "1") {
    return;
  }
  const suffix = formatTraceDetails(details);
  console.log(`[${new Date().toISOString()}] ${functionName}: ${message}${suffix}`);
}

function formatTraceDetails(details: Record<string, unknown>): string {
  const entries = Object.entries(details).filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (entries.length === 0) {
    return "";
  }

  return ` | ${entries.map(([key, value]) => `${key}=${formatTraceValue(value)}`).join(" ")}`;
}

function formatTraceValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(formatTraceValue).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return JSON.stringify(value);
  }
  return String(value).replace(/\s+/g, "_");
}

interface ValidationJson {
  passed: boolean;
  markers: Array<{
    marker: string;
    passed: boolean;
    message: string;
    details?: Record<string, unknown>;
  }>;
  warnings?: string[];
}

interface SectionMapJson {
  sections: unknown[];
}
