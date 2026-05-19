import dotenv from "dotenv";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

dotenv.config({ quiet: true });

export interface AppConfig {
  pageIndexApiKey?: string;
  geminiApiKey?: string;
  geminiApiKeys: string[];
  bifrostApiKey?: string;
  bifrostBaseUrl?: string;
  bifrostModel: string;
  llmProvider: LlmProviderName;
  pageIndexBaseUrl: string;
  pageIndexPollIntervalMs: number;
  pageIndexPollMaxAttempts: number;
  uiPipelineTimeoutMs: number;
  port: number;
  host: string;
  maxConcurrentJobs: number;
  tmpRetentionHours: number;
  tmpCleanupOnStart: boolean;
  allowLocalSecretWrite: boolean;
  enableLlmQa: boolean;
  enableLlmQueryExpansion: boolean;
  queryExpansionProvider: QueryExpansionProviderName;
  queryExpansionMaxTerms: number;
  queryExpansionTimeoutMs: number;
  queryExpansionCacheEnabled: boolean;
}

export type LlmProviderName = "gemini" | "bifrost";
export type QueryExpansionProviderName = "none" | "gemini" | "openai" | "translation";
export type GeminiKeySlotName = "GEMINI_KEY_1" | "GEMINI_KEY_2" | "GEMINI_KEY_3";
export type GeminiKeySlotEnabledName =
  | "GEMINI_KEY_1_ENABLED"
  | "GEMINI_KEY_2_ENABLED"
  | "GEMINI_KEY_3_ENABLED";
type WritableEnvKeyName =
  | "PAGEINDEX_API_KEY"
  | "GEMINI_API_KEY"
  | "BIFROST_API_KEY"
  | "BIFROST_BASE_URL"
  | "BIFROST_MODEL"
  | "LLM_PROVIDER"
  | "ENABLE_LLM_QA"
  | "ENABLE_LLM_QUERY_EXPANSION"
  | "QUERY_EXPANSION_PROVIDER"
  | GeminiKeySlotName
  | GeminiKeySlotEnabledName;

export interface GeminiKeySlotStatus {
  name: GeminiKeySlotName;
  configured: boolean;
  enabled: boolean;
  maskedKey: string | null;
}

const DEFAULT_PAGEINDEX_BASE_URL = "https://api.pageindex.ai";
const DEFAULT_PAGEINDEX_POLL_INTERVAL_MS = 5000;
const DEFAULT_PAGEINDEX_POLL_MAX_ATTEMPTS = 60;
const DEFAULT_UI_PIPELINE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_PORT = 3000;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_MAX_CONCURRENT_JOBS = 1;
const DEFAULT_TMP_RETENTION_HOURS = 24;
const DEFAULT_BIFROST_MODEL = "gpt-5.5";
const GEMINI_KEY_SLOTS: Array<{ name: GeminiKeySlotName; enabledName: GeminiKeySlotEnabledName }> = [
  { name: "GEMINI_KEY_1", enabledName: "GEMINI_KEY_1_ENABLED" },
  { name: "GEMINI_KEY_2", enabledName: "GEMINI_KEY_2_ENABLED" },
  { name: "GEMINI_KEY_3", enabledName: "GEMINI_KEY_3_ENABLED" }
];

export function loadEnvConfig(): AppConfig {
  return {
    pageIndexApiKey: nonEmpty(process.env.PAGEINDEX_API_KEY),
    geminiApiKey: nonEmpty(process.env.GEMINI_API_KEY),
    geminiApiKeys: resolveGeminiEnvKeys(),
    bifrostApiKey: nonEmpty(process.env.BIFROST_API_KEY),
    bifrostBaseUrl: nonEmpty(process.env.BIFROST_BASE_URL),
    bifrostModel: nonEmpty(process.env.BIFROST_MODEL) ?? DEFAULT_BIFROST_MODEL,
    llmProvider: readLlmProvider(process.env.LLM_PROVIDER),
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
    port: readPositiveInteger(process.env.PORT, DEFAULT_PORT),
    host: nonEmpty(process.env.HOST) ?? DEFAULT_HOST,
    maxConcurrentJobs: readPositiveInteger(process.env.MAX_CONCURRENT_JOBS, DEFAULT_MAX_CONCURRENT_JOBS),
    tmpRetentionHours: readPositiveInteger(process.env.TMP_RETENTION_HOURS, DEFAULT_TMP_RETENTION_HOURS),
    tmpCleanupOnStart: readBoolean(process.env.TMP_CLEANUP_ON_START, true),
    allowLocalSecretWrite: readBoolean(process.env.ALLOW_LOCAL_SECRET_WRITE, false),
    enableLlmQa: readBoolean(process.env.ENABLE_LLM_QA, false),
    enableLlmQueryExpansion: readBoolean(process.env.ENABLE_LLM_QUERY_EXPANSION, false),
    queryExpansionProvider: readQueryExpansionProvider(process.env.QUERY_EXPANSION_PROVIDER),
    queryExpansionMaxTerms: readPositiveInteger(process.env.QUERY_EXPANSION_MAX_TERMS, 12),
    queryExpansionTimeoutMs: readPositiveInteger(process.env.QUERY_EXPANSION_TIMEOUT_MS, 3000),
    queryExpansionCacheEnabled: readBoolean(process.env.QUERY_EXPANSION_CACHE_ENABLED, true)
  };
}

export function isLocalhostHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1" || normalized === "[::1]";
}

export function canWriteSecretsFromUi(config: Pick<AppConfig, "host" | "allowLocalSecretWrite"> = loadEnvConfig()): boolean {
  return isLocalhostHost(config.host) || config.allowLocalSecretWrite;
}

export function localhostExposureWarning(host: string): string | undefined {
  return isLocalhostHost(host)
    ? undefined
    : "Warning: server is not bound to localhost. Do not expose this local demo without auth.";
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
  legacyGeminiKeyConfigured: boolean;
  maskedLegacyGeminiApiKey: string | null;
  geminiKeySlots: GeminiKeySlotStatus[];
  configuredGeminiKeyCount: number;
  enabledGeminiKeyCount: number;
  llmProvider: LlmProviderName;
  hasBifrostApiKey: boolean;
  maskedBifrostApiKey: string | null;
  bifrostBaseUrl: string | null;
  bifrostModel: string;
  enableLlmQa: boolean;
  enableLlmQueryExpansion: boolean;
  queryExpansionProvider: QueryExpansionProviderName;
  pageIndexBaseUrl: string;
  pollIntervalMs: number;
  pollMaxAttempts: number;
  host: string;
  localDemoSecretWriteEnabled: boolean;
} {
  const config = loadEnvConfig();
  const geminiKeySlots = GEMINI_KEY_SLOTS.map((slot) => {
    const key = nonEmpty(process.env[slot.name]);
    return {
      name: slot.name,
      configured: Boolean(key),
      enabled: isEnabled(process.env[slot.enabledName]),
      maskedKey: maskSecret(key)
    };
  });
  const firstGeminiKey = config.geminiApiKeys[0] ?? config.geminiApiKey;

  return {
    hasPageIndexApiKey: Boolean(config.pageIndexApiKey),
    maskedPageIndexApiKey: maskSecret(config.pageIndexApiKey),
    hasGeminiApiKey: Boolean(firstGeminiKey),
    maskedGeminiApiKey: maskSecret(firstGeminiKey),
    legacyGeminiKeyConfigured: Boolean(config.geminiApiKey),
    maskedLegacyGeminiApiKey: maskSecret(config.geminiApiKey),
    geminiKeySlots,
    configuredGeminiKeyCount: geminiKeySlots.filter((slot) => slot.configured).length,
    enabledGeminiKeyCount: geminiKeySlots.filter((slot) => slot.configured && slot.enabled).length,
    llmProvider: config.llmProvider,
    hasBifrostApiKey: Boolean(config.bifrostApiKey),
    maskedBifrostApiKey: maskSecret(config.bifrostApiKey),
    bifrostBaseUrl: config.bifrostBaseUrl ?? null,
    bifrostModel: config.bifrostModel,
    enableLlmQa: config.enableLlmQa,
    enableLlmQueryExpansion: config.enableLlmQueryExpansion,
    queryExpansionProvider: config.queryExpansionProvider,
    pageIndexBaseUrl: config.pageIndexBaseUrl,
    pollIntervalMs: config.pageIndexPollIntervalMs,
    pollMaxAttempts: config.pageIndexPollMaxAttempts,
    host: config.host,
    localDemoSecretWriteEnabled: canWriteSecretsFromUi(config)
  };
}

export const getPageIndexSettingsStatus = getApiSettingsStatus;

export async function savePageIndexApiKeyToEnv(apiKey: string): Promise<{ maskedKey: string }> {
  return await saveApiKeyToEnv("PAGEINDEX_API_KEY", apiKey);
}

export async function saveGeminiApiKeyToEnv(apiKey: string): Promise<{ maskedKey: string }> {
  return await saveApiKeyToEnv("GEMINI_API_KEY", apiKey);
}

export async function saveGeminiKeySlotToEnv(
  slotName: GeminiKeySlotName,
  apiKey: string
): Promise<{ maskedKey: string; slotName: GeminiKeySlotName }> {
  const result = await saveApiKeyToEnv(slotName, apiKey);
  return {
    ...result,
    slotName
  };
}

export async function saveGeminiKeySlotEnabledToEnv(
  slotName: GeminiKeySlotName,
  enabled: boolean
): Promise<{ slotName: GeminiKeySlotName; enabled: boolean }> {
  const slot = GEMINI_KEY_SLOTS.find((candidate) => candidate.name === slotName);
  if (!slot) {
    throw new Error("Invalid Gemini key slot.");
  }

  await saveEnvValueToEnv(slot.enabledName, enabled ? "true" : "false");
  return { slotName, enabled };
}

export async function saveBifrostSettingsToEnv(settings: {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  llmProvider?: LlmProviderName;
  enableLlmQa?: boolean;
  enableLlmQueryExpansion?: boolean;
  queryExpansionProvider?: QueryExpansionProviderName;
}): Promise<{
  maskedKey: string | null;
  baseUrl: string | null;
  model: string;
  llmProvider: LlmProviderName;
  enableLlmQa: boolean;
  enableLlmQueryExpansion: boolean;
  queryExpansionProvider: QueryExpansionProviderName;
}> {
  const apiKey = nonEmpty(settings.apiKey);
  const baseUrl = nonEmpty(settings.baseUrl);
  const model = nonEmpty(settings.model);
  const llmProvider = settings.llmProvider;
  const queryExpansionProvider = settings.queryExpansionProvider;

  if (
    !apiKey &&
    !baseUrl &&
    !model &&
    !llmProvider &&
    settings.enableLlmQa === undefined &&
    settings.enableLlmQueryExpansion === undefined &&
    !queryExpansionProvider
  ) {
    throw new Error("No Bifrost settings were provided.");
  }

  if (llmProvider && llmProvider !== "gemini" && llmProvider !== "bifrost") {
    throw new Error("Invalid LLM provider.");
  }
  if (
    queryExpansionProvider &&
    queryExpansionProvider !== "none" &&
    queryExpansionProvider !== "gemini" &&
    queryExpansionProvider !== "openai" &&
    queryExpansionProvider !== "translation"
  ) {
    throw new Error("Invalid query expansion provider.");
  }

  if (apiKey) {
    await saveEnvValueToEnv("BIFROST_API_KEY", apiKey);
  }
  if (baseUrl) {
    await saveEnvValueToEnv("BIFROST_BASE_URL", baseUrl);
  }
  if (model) {
    await saveEnvValueToEnv("BIFROST_MODEL", model);
  }
  if (llmProvider) {
    await saveEnvValueToEnv("LLM_PROVIDER", llmProvider);
  }
  if (settings.enableLlmQa !== undefined) {
    await saveEnvValueToEnv("ENABLE_LLM_QA", settings.enableLlmQa ? "true" : "false");
  }
  if (settings.enableLlmQueryExpansion !== undefined) {
    await saveEnvValueToEnv("ENABLE_LLM_QUERY_EXPANSION", settings.enableLlmQueryExpansion ? "true" : "false");
  }
  if (queryExpansionProvider) {
    await saveEnvValueToEnv("QUERY_EXPANSION_PROVIDER", queryExpansionProvider);
  }

  const config = loadEnvConfig();
  return {
    maskedKey: maskSecret(config.bifrostApiKey),
    baseUrl: config.bifrostBaseUrl ?? null,
    model: config.bifrostModel,
    llmProvider: config.llmProvider,
    enableLlmQa: config.enableLlmQa,
    enableLlmQueryExpansion: config.enableLlmQueryExpansion,
    queryExpansionProvider: config.queryExpansionProvider
  };
}

export function isGeminiKeySlotName(value: unknown): value is GeminiKeySlotName {
  return typeof value === "string" && GEMINI_KEY_SLOTS.some((slot) => slot.name === value);
}

async function saveApiKeyToEnv(keyName: WritableEnvKeyName, apiKey: string): Promise<{ maskedKey: string }> {
  const trimmed = nonEmpty(apiKey);
  if (!trimmed) {
    throw new Error(`${keyName} cannot be empty.`);
  }

  await saveEnvValueToEnv(keyName, trimmed);

  return {
    maskedKey: maskSecret(trimmed) ?? "********"
  };
}

async function saveEnvValueToEnv(keyName: WritableEnvKeyName, value: string): Promise<void> {
  const envPath = path.resolve(process.cwd(), ".env");
  const current = await readFile(envPath, "utf8").catch(() => "");
  const next = upsertEnvValue(current, keyName, value);
  await writeFile(envPath, next, "utf8");
  process.env[keyName] = value;
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

function resolveGeminiEnvKeys(): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];

  for (const slot of GEMINI_KEY_SLOTS) {
    if (!isEnabled(process.env[slot.enabledName])) {
      continue;
    }

    const key = nonEmpty(process.env[slot.name]);
    if (key && !seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }

  const legacyKey = nonEmpty(process.env.GEMINI_API_KEY);
  if (legacyKey && !seen.has(legacyKey)) {
    keys.push(legacyKey);
  }

  return keys;
}

function isEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized !== "false" && normalized !== "0" && normalized !== "off" && normalized !== "no";
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "on", "yes"].includes(normalized)) return true;
  if (["false", "0", "off", "no"].includes(normalized)) return false;
  return fallback;
}

function readQueryExpansionProvider(value: string | undefined): QueryExpansionProviderName {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "gemini" || normalized === "openai" || normalized === "translation") {
    return normalized;
  }
  return "none";
}

function readLlmProvider(value: string | undefined): LlmProviderName {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "bifrost") {
    return "bifrost";
  }
  return "gemini";
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
