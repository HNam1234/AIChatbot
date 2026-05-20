import { GEMINI_KEY_SLOTS } from "./constants";
import { canWriteSecretsFromUi, maskSecret } from "./localAccess";
import { loadEnvConfig } from "./loader";
import { isEnabled, nonEmpty } from "./parsers";
import type { ApiSettingsStatus } from "./types";

/**
 * Public settings DTO consumed by the local UI.
 *
 * Secrets are never returned raw; each configured key is represented only by a
 * boolean and masked suffix.
 */
export function getApiSettingsStatus(): ApiSettingsStatus {
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
