import type { GeminiKeySlotEnabledName, GeminiKeySlotName } from "./types";

export const DEFAULT_PAGEINDEX_BASE_URL = "https://api.pageindex.ai";
export const DEFAULT_PAGEINDEX_POLL_INTERVAL_MS = 5000;
export const DEFAULT_PAGEINDEX_POLL_MAX_ATTEMPTS = 60;
export const DEFAULT_UI_PIPELINE_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_PORT = 3000;
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_MAX_CONCURRENT_JOBS = 1;
export const DEFAULT_TMP_RETENTION_HOURS = 24;
export const DEFAULT_BIFROST_MODEL = "gpt-5.5";

export const GEMINI_KEY_SLOTS: Array<{
  name: GeminiKeySlotName;
  enabledName: GeminiKeySlotEnabledName;
}> = [
  { name: "GEMINI_KEY_1", enabledName: "GEMINI_KEY_1_ENABLED" },
  { name: "GEMINI_KEY_2", enabledName: "GEMINI_KEY_2_ENABLED" },
  { name: "GEMINI_KEY_3", enabledName: "GEMINI_KEY_3_ENABLED" }
];
