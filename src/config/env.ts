import dotenv from "dotenv";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

dotenv.config({ quiet: true });

export interface AppConfig {
  pageIndexApiKey?: string;
  geminiApiKey?: string;
  geminiApiKeys: string[];
  pageIndexBaseUrl: string;
  pageIndexPollIntervalMs: number;
  pageIndexPollMaxAttempts: number;
  uiPipelineTimeoutMs: number;
  port: number;
}

export type GeminiKeySlotName = "GEMINI_KEY_1" | "GEMINI_KEY_2" | "GEMINI_KEY_3";
export type GeminiKeySlotEnabledName =
  | "GEMINI_KEY_1_ENABLED"
  | "GEMINI_KEY_2_ENABLED"
  | "GEMINI_KEY_3_ENABLED";

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
  legacyGeminiKeyConfigured: boolean;
  maskedLegacyGeminiApiKey: string | null;
  geminiKeySlots: GeminiKeySlotStatus[];
  configuredGeminiKeyCount: number;
  enabledGeminiKeyCount: number;
  pageIndexBaseUrl: string;
  pollIntervalMs: number;
  pollMaxAttempts: number;
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

export function isGeminiKeySlotName(value: unknown): value is GeminiKeySlotName {
  return typeof value === "string" && GEMINI_KEY_SLOTS.some((slot) => slot.name === value);
}

async function saveApiKeyToEnv(
  keyName: "PAGEINDEX_API_KEY" | "GEMINI_API_KEY" | GeminiKeySlotName | GeminiKeySlotEnabledName,
  apiKey: string
): Promise<{ maskedKey: string }> {
  const trimmed = nonEmpty(apiKey);
  if (!trimmed) {
    throw new Error(`${keyName} cannot be empty.`);
  }

  await saveEnvValueToEnv(keyName, trimmed);

  return {
    maskedKey: maskSecret(trimmed) ?? "********"
  };
}

async function saveEnvValueToEnv(
  keyName: "PAGEINDEX_API_KEY" | "GEMINI_API_KEY" | GeminiKeySlotName | GeminiKeySlotEnabledName,
  value: string
): Promise<void> {
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
