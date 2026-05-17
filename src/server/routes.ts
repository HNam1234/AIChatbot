import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import express from "express";
import multer from "multer";
import {
  getApiSettingsStatus,
  isGeminiKeySlotName,
  loadEnvConfig,
  maskSecret,
  resolvePageIndexSettings,
  saveGeminiApiKeyToEnv,
  saveGeminiKeySlotEnabledToEnv,
  saveGeminiKeySlotToEnv,
  savePageIndexApiKeyToEnv
} from "../config/env";
import { PageIndexClient } from "../api/pageindexClient";
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
import { runPipelineProcess } from "./pipelineProcessRunner";
import { QAValidator } from "../validators/qaValidator";
import { GeminiRoundRobinClient } from "../agent/geminiClient";
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
  rankSectionsForQuestion,
  renderHsCodeAnswer,
  selectRelevantSections,
  selectAlternativeSections,
  type CandidateRelevance,
  type EnrichedRetrievedSection,
  type QuerySignals,
  type RetrievedTreeHit,
  type SectionMetadata
} from "../agent/qaAnswerFormatter";
import { resolveGeminiApiKeys } from "../config/gemini";
import { TokenValidator } from "../validators/tokenValidator";

const uploadsDir = path.resolve(process.cwd(), "data", "uploads");
const convertedDir = path.resolve(process.cwd(), "data", "converted");
const assetsRoot = path.resolve(process.cwd(), "data", "converted", "assets");
const tmpDir = path.resolve(process.cwd(), "data", "tmp");
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
  "cua",
  "cho",
  "thuoc",
  "trong",
  "mot",
  "cac"
]);

interface CachedTreeRetrievalResult {
  hits: EnrichedRetrievedSection[];
  retrievalSource: "pageindex-tree" | "bm25-fallback";
  bm25FallbackUsed: boolean;
  pageIndexResultCount: number;
  contrastTerms: string[];
  signals: QuerySignals;
  pageIndexResults: CandidateRelevance[];
  bm25Results: CandidateRelevance[];
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
    callback(null, isPdf);
  },
  limits: {
    files: 25,
    fileSize: 100 * 1024 * 1024
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

  router.post("/run-pipeline", handleRunPipelineUpload, (req, res) => {
    const startedAt = Date.now();
    const files = (req.files ?? []) as Express.Multer.File[];
    const pdfFiles = files.filter((file) => file.fieldname === "pdf" || file.fieldname === "files" || file.fieldname === "files[]");
    if (pdfFiles.length === 0) {
      res.status(400).json({ error: "At least one PDF file is required." });
      return;
    }

    const inputFiles = pdfFiles.map((file) => file.path);
    const job = JobStore.create(inputFiles);
    JobStore.addTrace(job.id, "routes.runPipeline", "upload accepted", {
      fileCount: pdfFiles.length,
      totalBytes: pdfFiles.reduce((sum, file) => sum + file.size, 0),
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
    const options = {
      ocrLanguage: stringValue(req.body.ocrLang) ?? stringValue(req.body.ocrLanguage) ?? "vie",
      doclingThreads: numberValue(req.body.doclingThreads) ?? 4,
      exportAssets: booleanValue(req.body.exportAssets),
      uploadPageIndex: booleanValue(req.body.uploadPageIndex),
      forcePageIndexUpload:
        booleanValue(req.body.forcePageIndexUpload) ||
        (req.body.reusePageIndexCache !== undefined && !booleanValue(req.body.reusePageIndexCache)),
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
      forcePageIndexUpload: Boolean(options.forcePageIndexUpload),
      failFast: options.failFast,
      hasTemporaryPageIndexKey: Boolean(options.pageIndexApiKey),
      hasTemporaryGeminiKey: Boolean(options.geminiApiKey)
    });

    void runJob(job.id, inputFiles, options);
    JobStore.addTrace(job.id, "routes.runPipeline", "response sent", { jobId: job.id });
    res.json({
      jobId: job.id,
      pageIndexKey: options.pageIndexApiKey ? maskSecret(options.pageIndexApiKey) : undefined,
      geminiKey: options.geminiApiKey ? maskSecret(options.geminiApiKey) : undefined
    });
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
        cachedDocIds: cachedDocIds.length,
        overrideGeminiKeys: requestGeminiApiKeys.length
      });
      if (stringValue(req.body.scope) === "all") {
        const cachedAnswer = await answerFromCachedTrees(question, {
          geminiApiKeys: requestGeminiApiKeys,
          debug: booleanValue(req.body.debug)
        });
        serverTrace("routes.ask", "cached-tree answer sent", { elapsedMs: Date.now() - startedAt });
        res.json(cachedAnswer);
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
  serverTrace("handleRunPipelineUpload", "upload started", {
    contentLength: req.headers["content-length"] ?? "unknown"
  });
  runPipelineUpload(req, res, (error: unknown) => {
    if (!error) {
      const files = Array.isArray(req.files) ? req.files as Express.Multer.File[] : [];
      serverTrace("handleRunPipelineUpload", "upload completed", {
        fileCount: files.length,
        totalBytes: files.reduce((sum, file) => sum + file.size, 0),
        elapsedMs: Date.now() - startedAt
      });
      next();
      return;
    }

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
      error: "Upload request was aborted before the server finished receiving files. Keep the tab open and retry."
    });
    return;
  }

  if (error instanceof multer.MulterError) {
    serverTrace("sendUploadError", "multer rejected upload", {
      code: error.code,
      elapsedMs
    });
    res.status(400).json({ error: uploadMulterErrorMessage(error) });
    return;
  }

  serverTrace("sendUploadError", "upload failed", {
    elapsedMs,
    error: error instanceof Error ? error.message : String(error)
  });
  res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
}

function isRequestAbortedError(error: unknown): boolean {
  const record = error as { code?: unknown; message?: unknown };
  return record.code === "ECONNABORTED" || record.code === "ECONNRESET" || record.message === "Request aborted";
}

function uploadMulterErrorMessage(error: multer.MulterError): string {
  if (error.code === "LIMIT_FILE_SIZE") {
    return "PDF upload is too large. Max file size is 100 MB per file.";
  }
  if (error.code === "LIMIT_FILE_COUNT") {
    return "Too many PDFs selected. Max is 25 files per run.";
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

async function listCachedTreeDocuments(): Promise<Array<{ document: string; docId?: string; treePath: string }>> {
  const exists = await stat(convertedDir).then((item) => item.isDirectory()).catch(() => false);
  if (!exists) {
    return [];
  }

  const entries = await readdir(convertedDir, { withFileTypes: true });
  const documents: Array<{ document: string; docId?: string; treePath: string }> = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".tree.json")) {
      continue;
    }

    const treePath = path.join(convertedDir, entry.name);
    const treeJson = await readOptionalJson<Record<string, unknown>>(treePath);
    const docId = extractCachedDocId(treeJson);

    documents.push({
      document: entry.name.replace(/\.tree\.json$/i, ".pdf"),
      docId,
      treePath: relativePath(treePath) ?? treePath
    });
  }

  return documents.sort((left, right) => left.document.localeCompare(right.document));
}

async function answerFromCachedTrees(
  question: string,
  options: { geminiApiKeys?: string[]; debug?: boolean } = {}
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  serverTrace("answerFromCachedTrees", "started", {
    overrideGeminiKeys: options.geminiApiKeys?.length ?? 0
  });
  const documents = await listCachedTreeDocuments();
  serverTrace("answerFromCachedTrees", "cached tree documents loaded", {
    documentCount: documents.length,
    elapsedMs: Date.now() - startedAt
  });
  if (documents.length === 0) {
    throw new Error("No cached tree JSON found in data/converted. Run parse with Upload to PageIndex once.");
  }

  const searchStartedAt = Date.now();
  const retrieval = await searchCachedTreeDocuments(question, documents);
  const hits = retrieval.hits;
  const debugReport = createQaDebugReport(question, retrieval);
  serverTrace("answerFromCachedTrees", "cached tree search completed", {
    hitCount: hits.length,
    pageIndexResultCount: retrieval.pageIndexResultCount,
    bm25FallbackUsed: retrieval.bm25FallbackUsed,
    contrastTerms: retrieval.contrastTerms,
    elapsedMs: Date.now() - searchStartedAt
  });
  if (hits.length === 0) {
    const emptyResponse = {
      answer: "Không tìm thấy ngữ cảnh phù hợp trong các cached tree JSON.",
      docIds: [],
      documents: documents.map((document) => document.document),
      mode: "cached-tree",
      retrieval: {
        source: retrieval.retrievalSource,
        bm25FallbackUsed: retrieval.bm25FallbackUsed,
        pageIndexResultCount: retrieval.pageIndexResultCount,
        contrastTerms: retrieval.contrastTerms,
        selectedSection: null,
        finalHsCodes: [],
        answerRepairApplied: false
      }
    };
    return options.debug ? { ...emptyResponse, debug: debugReport } : emptyResponse;
  }

  const topHits = hits.slice(0, 10);
  const context = buildStructuredRetrievedContext(topHits);
  const marker12 = TokenValidator.validateContextSize(context.slice(0, 12000), { maxChars: 12000 });
  serverTrace("answerFromCachedTrees", "context prepared", {
    contextChars: context.length,
    truncatedChars: context.slice(0, 12000).length,
    sourceDocuments: uniqueStrings(hits.map((hit) => hit.document)).length
  });
  let llmAnswer: string | undefined;
  let llmError: string | undefined;
  try {
    const llm = new GeminiRoundRobinClient({ apiKeys: resolveGeminiApiKeys(options.geminiApiKeys ?? []) });
    const llmStartedAt = Date.now();
    serverTrace("answerFromCachedTrees", "gemini synthesis started", { keyCount: llm.keyCount });
    llmAnswer = await llm.synthesizeAnswer(
      context.slice(0, 12000),
      [
        question,
        "",
        "Use the retrieved section metadata. If hsCode is present, final answer must include HS Code.",
        "Citation must include document, page/page range, and section.",
        "Do not invent HS Code. Prefer metadata for hsCode/title/citation."
      ].join("\n")
    );
    if (llmAnswer && answerMentionsHsCodeOutsideSection(llmAnswer, topHits[0])) {
      serverTrace("answerFromCachedTrees", "unsupported HS code detected; retrying strict prompt", {
        selectedSection: topHits[0].section,
        allowedCodes: hsCodesForSection(topHits[0])
      });
      llmAnswer = await llm.synthesizeAnswer(
        context.slice(0, 12000),
        [
          question,
          "",
          "Your previous answer selected an HS code not present in the retrieved section metadata.",
          "Re-answer using only the provided section metadata.",
          `Allowed HS codes for the selected section: ${hsCodesForSection(topHits[0]).join(", ")}`
        ].join("\n")
      );
    }
    serverTrace("answerFromCachedTrees", "gemini synthesis completed", {
      answerChars: llmAnswer.length,
      elapsedMs: Date.now() - llmStartedAt
    });
  } catch (error) {
    llmError = error instanceof Error ? error.message : String(error);
    serverTrace("answerFromCachedTrees", "gemini synthesis failed; using fallback formatter", { error: llmError });
  }
  const alternatives = selectAlternativeSections(hits, question);
  const rendered = renderHsCodeAnswer(llmAnswer, hits[0], alternatives, { question });
  const answer = rendered.answer;
  debugReport.selectedPrimary = publicSectionCitation(hits[0]);
  debugReport.finalAnswerHsCodes = rendered.finalHsCodes;
  debugReport.answerRepairApplied = rendered.answerRepairApplied;
  const marker13 = TokenValidator.validateOutputSize(answer, { maxWords: 180 });
  const validation = QAValidator.validateResponse(answer, { requireCitations: false });
  serverTrace("answerFromCachedTrees", "completed", { elapsedMs: Date.now() - startedAt });

  const response = {
    answer,
    docIds: [],
    documents: uniqueStrings(hits.map((hit) => hit.document)),
    mode: "cached-tree",
    retrieval: {
      source: retrieval.retrievalSource,
      bm25FallbackUsed: retrieval.bm25FallbackUsed,
      pageIndexResultCount: retrieval.pageIndexResultCount,
      contrastTerms: retrieval.contrastTerms,
      selectedSection: publicSectionCitation(hits[0]),
      finalHsCodes: rendered.finalHsCodes,
      answerRepairApplied: rendered.answerRepairApplied
    },
    citations: rendered.citations.map(publicSectionCitation),
    retrievedSections: topHits.slice(0, 5).map(publicSectionCitation),
    metadataWarnings: rendered.metadataWarnings,
    llmError,
    validation: {
      ...validation,
      markers: [marker12, marker13, ...validation.markers]
    }
  };
  return options.debug ? { ...response, debug: debugReport } : response;
}

async function searchCachedTreeDocuments(
  question: string,
  documents: Array<{ document: string; treePath: string }>
): Promise<CachedTreeRetrievalResult> {
  const contrast = detectContrastTerms(question);
  const signals = extractQuerySignals(question);
  const queryTokens = tokenizeForSearch(question);
  const scoringContext = { queryTokens, contrast };
  const sectionMetadata = await loadSectionMetadata(documents.map((document) => document.document));
  const pageIndexHits: EnrichedRetrievedSection[] = [];

  for (const document of documents) {
    const treeJson = await readOptionalJson<Record<string, unknown>>(path.resolve(process.cwd(), document.treePath));
    const roots = normalizeTreeRoots(treeJson);
    for (const node of flattenCachedTreeNodes(roots)) {
      const score = scoreRetrievedCandidate(scoringContext, node.title, node.text);
      if (score > 0) {
        const rawHit: RetrievedTreeHit = {
          document: document.document,
          title: node.title,
          text: node.text.slice(0, 2400),
          score
        };
        pageIndexHits.push(enrichRetrievedHit(rawHit, sectionMetadata));
      }
    }
  }

  const rankedPageIndexHits = rankRetrievedSectionsByUsability(pageIndexHits, question);
  const pageIndexSelection = selectRelevantSections(rankedPageIndexHits, question, { requireHsMetadata: true });
  const usablePageIndexHits = pageIndexSelection.ranked;
  if (usablePageIndexHits.length > 0) {
    return {
      hits: usablePageIndexHits,
      retrievalSource: "pageindex-tree",
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
  const bm25Candidates = rankRetrievedSectionsByUsability(searchLocalSectionMetadataFallback(scoringContext, sectionMetadata), question);
  const bm25Selection = selectRelevantSections(bm25Candidates, question, { requireHsMetadata: true });
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
  contrast: ReturnType<typeof detectContrastTerms>;
}

function searchLocalSectionMetadataFallback(
  scoringContext: SearchScoringContext,
  sections: SectionMetadata[]
): EnrichedRetrievedSection[] {
  return sections.flatMap((section) => {
    const score = scoreRetrievedCandidate(
      scoringContext,
      `${section.title ?? ""} ${section.section ?? ""}`,
      `${section.text ?? ""} ${section.textPreview ?? ""} ${(section.captions ?? []).join(" ")}`
    );
    if (score <= 0) {
      return [];
    }

    return [{
      document: section.document,
      chapter: section.chapter,
      hsCode: section.hsCode,
      groupedHsCodes: section.groupedHsCodes,
      title: section.title,
      section: section.section,
      pageStart: section.pageStart,
      pageEnd: section.pageEnd,
      source: section.source,
      text: section.text ?? section.textPreview ?? "",
      captions: section.captions ?? [],
      score,
      metadataWarnings: []
    }];
  });
}

function scoreRetrievedCandidate(scoringContext: SearchScoringContext, title: string, text: string): number {
  const baselineTokens = new Set(scoringContext.contrast.baselineTokens);
  const titleHaystack = normalizeSearchText(title);
  const textHaystack = normalizeSearchText(text);
  const positiveTokens = scoringContext.queryTokens.filter((token) => !baselineTokens.has(token));
  const positiveScore = positiveTokens.reduce(
    (sum, token) => sum + (countOccurrences(titleHaystack, token) * 5) + countOccurrences(textHaystack, token),
    0
  );
  const baselinePenalty = scoringContext.contrast.baselineTokens.reduce((sum, token) => sum + countOccurrences(titleHaystack, token), 0) * 6;
  return positiveScore - baselinePenalty;
}

async function loadSectionMetadata(documentNames: string[]): Promise<SectionMetadata[]> {
  const records: SectionMetadata[] = [];
  const seen = new Set<string>();
  const append = (items: unknown[], fallbackDocument?: string) => {
    for (const item of items) {
      if (typeof item !== "object" || item === null) {
        continue;
      }
      const section = normalizeSectionMetadata(item as Record<string, unknown>, fallbackDocument);
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

  return records;
}

function publicSectionCitation(section: EnrichedRetrievedSection): Record<string, unknown> {
  return {
    document: section.document,
    chapter: section.chapter,
    hsCode: section.hsCode ?? null,
    groupedHsCodes: section.groupedHsCodes ?? [],
    title: section.title ?? null,
    section: section.section ?? null,
    pageStart: section.pageStart ?? null,
    pageEnd: section.pageEnd ?? null,
    source: section.source ?? null,
    captions: section.captions,
    score: section.score,
    metadataWarnings: section.metadataWarnings
  };
}

function createQaDebugReport(question: string, retrieval: CachedTreeRetrievalResult): Record<string, unknown> {
  return {
    query: question,
    extractedSignals: retrieval.signals,
    retrieval: {
      pageIndexResults: retrieval.pageIndexResults,
      bm25FallbackUsed: retrieval.bm25FallbackUsed,
      bm25Results: retrieval.bm25Results
    },
    candidates: retrieval.bm25FallbackUsed ? retrieval.bm25Results : retrieval.pageIndexResults,
    selectedPrimary: {},
    finalAnswerHsCodes: [],
    answerRepairApplied: false
  };
}

function answerMentionsHsCodeOutsideSection(answer: string, section: EnrichedRetrievedSection): boolean {
  const allowedCodes = new Set(hsCodesForSection(section));
  if (allowedCodes.size === 0) {
    return false;
  }
  const mentionedCodes = [...answer.matchAll(new RegExp(HS_CODE_PATTERN.source, "g"))].map((match) => match[0]);
  return mentionedCodes.some((code) => !allowedCodes.has(code));
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
      .filter((token) => token.length >= 3 && !SEARCH_STOPWORDS.has(token))
  );
  return tokens.length > 0 ? tokens : uniqueStrings(normalizeSearchText(text).split(/[^a-z0-9.]+/g).filter((token) => token.length >= 3));
}

function normalizeSearchText(text: string): string {
  return text
    .replace(/[đĐ]/g, "d")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\bca\s+phe\b/g, "coffee");
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

function safePdfFileName(fileName: string): string {
  const parsed = path.parse(fileName);
  const base = parsed.name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "upload";
  return `${base}.pdf`;
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

function booleanValue(value: unknown): boolean {
  return value === "true" || value === "on" || value === "1" || value === true;
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
