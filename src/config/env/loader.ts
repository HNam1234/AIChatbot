import {
  DEFAULT_BIFROST_MODEL,
  DEFAULT_HOST,
  DEFAULT_MAX_CONCURRENT_JOBS,
  DEFAULT_PAGEINDEX_BASE_URL,
  DEFAULT_PAGEINDEX_POLL_INTERVAL_MS,
  DEFAULT_PAGEINDEX_POLL_MAX_ATTEMPTS,
  DEFAULT_PORT,
  DEFAULT_TMP_RETENTION_HOURS,
  DEFAULT_UI_PIPELINE_TIMEOUT_MS,
  GEMINI_KEY_SLOTS
} from "./constants";
import {
  isEnabled,
  nonEmpty,
  readBoolean,
  readLlmProvider,
  readPositiveInteger,
  readQueryExpansionProvider
} from "./parsers";
import type { AppConfig } from "./types";

/**
 * Reads process env into one typed config object.
 *
 * Parsing stays centralized here so callers do not duplicate default values or
 * string-to-boolean rules.
 */
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
