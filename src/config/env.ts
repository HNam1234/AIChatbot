import dotenv from "dotenv";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

dotenv.config({ quiet: true });

export interface AppConfig {
  pageIndexApiKey?: string;
  geminiApiKey?: string;
  pageIndexBaseUrl: string;
  pageIndexPollIntervalMs: number;
  pageIndexPollMaxAttempts: number;
  uiPipelineTimeoutMs: number;
  port: number;
}

const DEFAULT_PAGEINDEX_BASE_URL = "https://api.pageindex.ai";
const DEFAULT_PAGEINDEX_POLL_INTERVAL_MS = 5000;
const DEFAULT_PAGEINDEX_POLL_MAX_ATTEMPTS = 60;
const DEFAULT_UI_PIPELINE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_PORT = 3000;

export function loadEnvConfig(): AppConfig {
  return {
    pageIndexApiKey: nonEmpty(process.env.PAGEINDEX_API_KEY),
    geminiApiKey: nonEmpty(process.env.GEMINI_API_KEY),
    pageIndexBaseUrl: nonEmpty(process.env.PAGEINDEX_API_BASE_URL) ?? DEFAULT_PAGEINDEX_BASE_URL,
    pageIndexPollIntervalMs: readPositiveInteger(
      process.env.PAGEINDEX_POLL_INTERVAL_MS,
      DEFAULT_PAGEINDEX_POLL_INTERVAL_MS
    ),
    pageIndexPollMaxAttempts: readPositiveInteger(
      process.env.PAGEINDEX_POLL_MAX_ATTEMPTS,
      DEFAULT_PAGEINDEX_POLL_MAX_ATTEMPTS
    ),
    uiPipelineTimeoutMs: readPositiveInteger(process.env.UI_PIPELINE_TIMEOUT_MS, DEFAULT_UI_PIPELINE_TIMEOUT_MS),
    port: readPositiveInteger(process.env.PORT, DEFAULT_PORT)
  };
}

export function maskSecret(value: string | undefined): string | null {
  const trimmed = nonEmpty(value);
  if (!trimmed) {
    return null;
  }

  const suffix = trimmed.slice(-4);
  return `********...${suffix}`;
}

export function getApiSettingsStatus(): {
  hasPageIndexApiKey: boolean;
  maskedPageIndexApiKey: string | null;
  hasGeminiApiKey: boolean;
  maskedGeminiApiKey: string | null;
  pageIndexBaseUrl: string;
  pollIntervalMs: number;
  pollMaxAttempts: number;
} {
  const config = loadEnvConfig();
  return {
    hasPageIndexApiKey: Boolean(config.pageIndexApiKey),
    maskedPageIndexApiKey: maskSecret(config.pageIndexApiKey),
    hasGeminiApiKey: Boolean(config.geminiApiKey),
    maskedGeminiApiKey: maskSecret(config.geminiApiKey),
    pageIndexBaseUrl: config.pageIndexBaseUrl,
    pollIntervalMs: config.pageIndexPollIntervalMs,
    pollMaxAttempts: config.pageIndexPollMaxAttempts
  };
}

export const getPageIndexSettingsStatus = getApiSettingsStatus;

export async function savePageIndexApiKeyToEnv(apiKey: string): Promise<{ maskedKey: string }> {
  return await saveApiKeyToEnv("PAGEINDEX_API_KEY", apiKey);
}

export async function saveGeminiApiKeyToEnv(apiKey: string): Promise<{ maskedKey: string }> {
  return await saveApiKeyToEnv("GEMINI_API_KEY", apiKey);
}

async function saveApiKeyToEnv(keyName: "PAGEINDEX_API_KEY" | "GEMINI_API_KEY", apiKey: string): Promise<{ maskedKey: string }> {
  const trimmed = nonEmpty(apiKey);
  if (!trimmed) {
    throw new Error(`${keyName} cannot be empty.`);
  }

  const envPath = path.resolve(process.cwd(), ".env");
  const current = await readFile(envPath, "utf8").catch(() => "");
  const next = upsertEnvValue(current, keyName, trimmed);
  await writeFile(envPath, next, "utf8");
  process.env[keyName] = trimmed;

  return {
    maskedKey: maskSecret(trimmed) ?? "********"
  };
}

export function resolvePageIndexSettings(overrides: {
  apiKey?: string;
  baseUrl?: string;
  pollIntervalMs?: number;
  pollMaxAttempts?: number;
} = {}): Required<Pick<AppConfig, "pageIndexApiKey" | "pageIndexBaseUrl" | "pageIndexPollIntervalMs" | "pageIndexPollMaxAttempts">> {
  const env = loadEnvConfig();
  const apiKey = nonEmpty(overrides.apiKey) ?? env.pageIndexApiKey;
  if (!apiKey) {
    throw new Error("PAGEINDEX_API_KEY is missing. Create .env at project root or pass --pageindex-api-key.");
  }

  return {
    pageIndexApiKey: apiKey,
    pageIndexBaseUrl: nonEmpty(overrides.baseUrl) ?? env.pageIndexBaseUrl,
    pageIndexPollIntervalMs: overrides.pollIntervalMs ?? env.pageIndexPollIntervalMs,
    pageIndexPollMaxAttempts: overrides.pollMaxAttempts ?? env.pageIndexPollMaxAttempts
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function upsertEnvValue(envText: string, key: string, value: string): string {
  const normalized = envText.replace(/\r\n/g, "\n");
  const lines = normalized ? normalized.split("\n") : [];
  const escaped = `${key}=${quoteEnvValue(value)}`;
  let replaced = false;

  const nextLines = lines.map((line) => {
    if (line.match(new RegExp(`^\\s*${key}\\s*=`))) {
      replaced = true;
      return escaped;
    }
    return line;
  });

  if (!replaced) {
    if (nextLines.length > 0 && nextLines[nextLines.length - 1] !== "") {
      nextLines.push(escaped);
    } else if (nextLines.length > 0) {
      nextLines[nextLines.length - 1] = escaped;
      nextLines.push("");
    } else {
      nextLines.push(escaped);
    }
  }

  return `${nextLines.join("\n").replace(/\n*$/g, "")}\n`;
}

function quoteEnvValue(value: string): string {
  if (/[\s"'#]/.test(value)) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}
