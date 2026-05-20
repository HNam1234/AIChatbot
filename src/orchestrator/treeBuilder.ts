import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PageIndexClient, type PageIndexJson } from "../api";
import { ensureDirectory } from "../utils/paths";

export interface TreeBuilderOptions {
  apiKey: string;
  outputPath?: string;
  baseUrl?: string;
  pollIntervalMs?: number;
  pollMaxAttempts?: number;
  timeoutMs?: number;
}

export interface TreeBuildResult {
  docId?: string;
  treeData: unknown;
  rawResponse: PageIndexJson;
  outputPath?: string;
  fromCache?: boolean;
  cacheWarnings?: string[];
}

const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_POLL_MAX_ATTEMPTS = 60;

export class TreeBuilder {
  public static async loadCached(markdownPath: string, outputPath: string): Promise<TreeBuildResult | undefined> {
    const cachedText = await readFile(outputPath, "utf8").catch(() => undefined);
    if (!cachedText) {
      return undefined;
    }

    const cachedPayload = parseJsonObject(cachedText);
    if (!cachedPayload) {
      return undefined;
    }

    const cacheWarnings: string[] = [];
    const cachedHash = stringValue(objectValue(cachedPayload.cache)?.sourceMarkdownSha256);
    if (cachedHash) {
      const currentHash = await sha256File(markdownPath).catch(() => undefined);
      if (currentHash && cachedHash !== currentHash) {
        cacheWarnings.push("cached-tree-markdown-hash-differs");
      }
    }

    const rawResponse = objectValue(cachedPayload.rawResponse) ?? cachedPayload;
    const treeData = extractTreeData(cachedPayload) ?? extractTreeData(rawResponse);
    if (treeData === undefined) {
      return undefined;
    }

    return {
      docId: extractDocId(cachedPayload) ?? extractDocId(rawResponse),
      treeData,
      rawResponse,
      outputPath,
      fromCache: true,
      cacheWarnings
    };
  }

  public static async buildAndWait(markdownPath: string, options: TreeBuilderOptions): Promise<TreeBuildResult> {
    const client = new PageIndexClient(options.apiKey, { baseUrl: options.baseUrl });
    const uploadResponse = await client.uploadMarkdown(markdownPath);
    const immediateTree = extractTreeData(uploadResponse);
    const immediateDocId = extractDocId(uploadResponse);

    if (immediateTree !== undefined) {
      const result: TreeBuildResult = {
        docId: immediateDocId,
        treeData: immediateTree,
        rawResponse: uploadResponse,
        outputPath: options.outputPath,
        fromCache: false
      };
      await writeTreeIfRequested(result, options.outputPath, markdownPath);
      return result;
    }

    const docId = immediateDocId;
    if (!docId) {
      throw new Error("[TreeBuilder] PageIndex markdown response did not include `structure`, `result`, or `doc_id`.");
    }

    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const pollMaxAttempts =
      options.pollMaxAttempts ?? timeoutToAttempts(options.timeoutMs, pollIntervalMs) ?? DEFAULT_POLL_MAX_ATTEMPTS;
    let lastResponse: PageIndexJson = uploadResponse;

    for (let attempt = 1; attempt <= pollMaxAttempts; attempt += 1) {
      await sleep(pollIntervalMs);
      const statusResponse = await client.getTreeStatus(docId);
      lastResponse = statusResponse;
      const status = String(statusResponse.status ?? "").toLowerCase();

      if (status === "completed") {
        const treeData = extractTreeData(statusResponse);
        if (treeData === undefined) {
          throw new Error("[TreeBuilder] PageIndex completed but no tree payload was returned.");
        }

        const result: TreeBuildResult = {
          docId,
          treeData,
          rawResponse: statusResponse,
          outputPath: options.outputPath,
          fromCache: false
        };
        await writeTreeIfRequested(result, options.outputPath, markdownPath);
        return result;
      }

      if (status === "failed" || status === "error") {
        await writePageIndexDebug(markdownPath, "failed", statusResponse);
        throw new Error(`[TreeBuilder] PageIndex tree build failed for doc_id ${docId}.`);
      }
    }

    await writePageIndexDebug(markdownPath, "timeout", lastResponse);
    throw new Error(
      `[TreeBuilder] Timed out after ${pollMaxAttempts} attempts waiting for PageIndex tree doc_id ${docId}.`
    );
  }
}

function extractDocId(payload: PageIndexJson): string | undefined {
  const value = payload.doc_id ?? payload.docId ?? payload.id;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function extractTreeData(payload: PageIndexJson): unknown {
  if (isTreePayload(payload.structure)) {
    return payload.structure;
  }
  if (isTreePayload(payload.result)) {
    return payload.result;
  }
  if (isTreePayload(payload.tree)) {
    return payload.tree;
  }
  return undefined;
}

function isTreePayload(value: unknown): boolean {
  return Array.isArray(value) || (typeof value === "object" && value !== null);
}

async function writeTreeIfRequested(result: TreeBuildResult, outputPath: string | undefined, markdownPath: string): Promise<void> {
  if (!outputPath) {
    return;
  }

  await ensureDirectory(path.dirname(outputPath));
  await writeFile(outputPath, `${JSON.stringify({
    docId: result.docId,
    tree: result.treeData,
    rawResponse: result.rawResponse,
    cache: {
      generatedAt: new Date().toISOString(),
      sourceMarkdown: path.relative(process.cwd(), path.resolve(markdownPath)).replace(/\\/g, "/"),
      sourceMarkdownSha256: await sha256File(markdownPath)
    }
  }, null, 2)}\n`, "utf8");
}

async function writePageIndexDebug(markdownPath: string, reason: "failed" | "timeout", response: PageIndexJson): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const baseName = path
    .basename(markdownPath, path.extname(markdownPath))
    .replace(/\.milestone1$/i, "");
  const filePath = path.resolve(process.cwd(), "data", "tmp", `${baseName}.pageindex-${reason}.${timestamp}.json`);

  await ensureDirectory(path.dirname(filePath));
  await writeFile(filePath, `${JSON.stringify(response, null, 2)}\n`, "utf8");
}

function timeoutToAttempts(timeoutMs: number | undefined, pollIntervalMs: number): number | undefined {
  if (!timeoutMs || timeoutMs <= 0 || pollIntervalMs <= 0) {
    return undefined;
  }

  return Math.max(1, Math.ceil(timeoutMs / pollIntervalMs));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function sha256File(filePath: string): Promise<string> {
  const buffer = await readFile(filePath);
  return createHash("sha256").update(buffer).digest("hex");
}

function parseJsonObject(text: string): PageIndexJson | undefined {
  try {
    return objectValue(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function objectValue(value: unknown): PageIndexJson | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as PageIndexJson)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
