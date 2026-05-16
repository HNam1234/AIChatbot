import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import express from "express";
import multer from "multer";
import {
  getApiSettingsStatus,
  loadEnvConfig,
  maskSecret,
  saveGeminiApiKeyToEnv,
  savePageIndexApiKeyToEnv
} from "../config/env";
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

const uploadsDir = path.resolve(process.cwd(), "data", "uploads");
const assetsRoot = path.resolve(process.cwd(), "data", "converted", "assets");
const tmpDir = path.resolve(process.cwd(), "data", "tmp");

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
      if (!apiKey) {
        res.status(400).json({ error: "Gemini API key is required." });
        return;
      }

      const result = await saveGeminiApiKeyToEnv(apiKey);
      res.json({ ok: true, maskedKey: result.maskedKey });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/run-pipeline", upload.any(), (req, res) => {
    const files = (req.files ?? []) as Express.Multer.File[];
    const pdfFiles = files.filter((file) => file.fieldname === "pdf" || file.fieldname === "files" || file.fieldname === "files[]");
    if (pdfFiles.length === 0) {
      res.status(400).json({ error: "At least one PDF file is required." });
      return;
    }

    const inputFiles = pdfFiles.map((file) => file.path);
    const job = JobStore.create(inputFiles);
    JobStore.addLog(job.id, "upload received");
    for (const file of pdfFiles) {
      JobStore.addLog(job.id, `file saved: ${relativePath(file.path)}`);
      JobStore.setFileStep(job.id, file.filename, "file saved");
    }
    const options = {
      ocrLanguage: stringValue(req.body.ocrLang) ?? stringValue(req.body.ocrLanguage) ?? "vie",
      doclingThreads: numberValue(req.body.doclingThreads) ?? 4,
      exportAssets: booleanValue(req.body.exportAssets),
      uploadPageIndex: booleanValue(req.body.uploadPageIndex),
      failFast: booleanValue(req.body.failFast),
      pageIndexApiKey: stringValue(req.body.temporaryPageIndexApiKey) ?? stringValue(req.body.pageIndexApiKey),
      geminiApiKey: stringValue(req.body.temporaryGeminiApiKey) ?? stringValue(req.body.geminiApiKey)
    };

    void runJob(job.id, inputFiles, options);
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

  router.post("/ask", (_req, res) => {
    res.json({ answer: "Milestone 3 not implemented yet." });
  });

  return router;
}

async function runJob(
  jobId: string,
  inputFiles: string[],
  options: {
    ocrLanguage: string;
    doclingThreads: number;
    exportAssets: boolean;
    uploadPageIndex: boolean;
    failFast: boolean;
    pageIndexApiKey?: string;
    geminiApiKey?: string;
  }
): Promise<void> {
  const documentOutputs: Record<string, unknown>[] = [];
  let lastCommand: string | undefined;
  try {
    const config = loadEnvConfig();
    JobStore.setRunning(jobId, "parse started");

    for (const inputFile of inputFiles) {
      const filename = path.basename(inputFile);
      let command: string | undefined;
      try {
        JobStore.startFile(jobId, filename, "parse started");
        const result = await runPipelineProcess({
          inputFile,
          ...options,
          timeoutMs: config.uiPipelineTimeoutMs,
          onLog: (message) => JobStore.addLog(jobId, `${filename}: ${message}`),
          onStep: (step) => JobStore.setFileStep(jobId, filename, step)
        });
        command = result.command;
        lastCommand = command;

        if (result.timedOut) {
          throw new Error(`UI pipeline job timed out after ${config.uiPipelineTimeoutMs}ms. Child process was killed.`);
        }

        if (result.exitCode !== 0) {
          throw new Error(`Pipeline command failed with exit code ${result.exitCode}.`);
        }

        const outputs = await buildDocumentBundle(inputFile, options.uploadPageIndex, "passed");
        documentOutputs.push(outputs);
        JobStore.completeFile(jobId, filename, outputs);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await saveJobDebugLog(jobId, inputFile, command, message);
        const outputs = await buildDocumentBundle(inputFile, options.uploadPageIndex, "failed", message);
        documentOutputs.push(outputs);
        JobStore.failFile(jobId, filename, message, outputs);
        if (options.failFast) {
          break;
        }
      }
    }

    const outputs = await buildBatchOutputs(documentOutputs);
    JobStore.setOutputs(jobId, outputs);
    const hasFailure = documentOutputs.some((document) => document.status === "failed");
    if (hasFailure && options.failFast) {
      JobStore.fail(jobId, "Batch stopped on first failure.");
      return;
    }
    JobStore.complete(jobId, outputs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
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
    pageIndex: uploadPageIndex ? (treeValidation?.passed ? "completed" : treeJson ? "validation failed" : "failed") : "skipped",
    pageIndexDocId: treeJson?.docId,
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
      error: output.error ?? null
    }))
  };

  const convertedDir = path.resolve(process.cwd(), "data", "converted");
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
