import dotenv from "dotenv";

dotenv.config({ quiet: true });

export {
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
export {
  isEnabled,
  nonEmpty,
  readBoolean,
  readLlmProvider,
  readPositiveInteger,
  readQueryExpansionProvider
} from "./parsers";
export { loadEnvConfig } from "./loader";
export {
  canWriteSecretsFromUi,
  isGeminiKeySlotName,
  isLocalhostHost,
  localhostExposureWarning,
  maskSecret
} from "./localAccess";
export {
  getApiSettingsStatus,
  getPageIndexSettingsStatus
} from "./settingsStatus";
export {
  resolvePageIndexSettings,
  saveBifrostSettingsToEnv,
  saveGeminiApiKeyToEnv,
  saveGeminiKeySlotEnabledToEnv,
  saveGeminiKeySlotToEnv,
  savePageIndexApiKeyToEnv
} from "./secretWriters";
export type {
  ApiSettingsStatus,
  AppConfig,
  GeminiKeySlotEnabledName,
  GeminiKeySlotName,
  GeminiKeySlotStatus,
  LlmProviderName,
  QueryExpansionProviderName,
  WritableEnvKeyName
} from "./types";
