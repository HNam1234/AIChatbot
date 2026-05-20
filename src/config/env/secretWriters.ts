import { GEMINI_KEY_SLOTS } from "./constants";
import { saveEnvValueToEnv } from "./envFile";
import { maskSecret } from "./localAccess";
import { loadEnvConfig } from "./loader";
import { nonEmpty } from "./parsers";
import type {
  AppConfig,
  GeminiKeySlotName,
  LlmProviderName,
  QueryExpansionProviderName,
  WritableEnvKeyName
} from "./types";

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
