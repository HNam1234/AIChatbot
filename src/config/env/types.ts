export type LlmProviderName = "gemini" | "bifrost";
export type QueryExpansionProviderName = "none" | "gemini" | "openai" | "translation";
export type GeminiKeySlotName = "GEMINI_KEY_1" | "GEMINI_KEY_2" | "GEMINI_KEY_3";
export type GeminiKeySlotEnabledName =
  | "GEMINI_KEY_1_ENABLED"
  | "GEMINI_KEY_2_ENABLED"
  | "GEMINI_KEY_3_ENABLED";

export type WritableEnvKeyName =
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

export interface GeminiKeySlotStatus {
  name: GeminiKeySlotName;
  configured: boolean;
  enabled: boolean;
  maskedKey: string | null;
}

export interface ApiSettingsStatus {
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
}
