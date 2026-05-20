import { loadEnvConfig, type LlmProviderName } from "../config";
import { BifrostClient } from "./bifrostClient";
import { GeminiRoundRobinClient, type SelectedSectionAnswerContext } from "./geminiClient";

export interface LlmClient {
  synthesizeAnswer(context: string, query: string, options?: { language?: string }): Promise<string>;
  synthesizeSectionAnswer(
    section: SelectedSectionAnswerContext,
    query: string,
    options?: { language?: string }
  ): Promise<string>;
  synthesizeComparisonAnswer(
    sections: SelectedSectionAnswerContext[],
    query: string,
    options?: { language?: string }
  ): Promise<string>;
  planQuery(prompt: string, options?: { temperature?: number; maxOutputTokens?: number }): Promise<string>;
}

export interface LlmFactoryOptions {
  apiKeys?: string[];
  geminiModel?: string;
}

export interface LlmAvailability {
  provider: LlmProviderName;
  configured: boolean;
  keyCount: number;
  unavailableReason: string | null;
}

export function createLlmClient(options: LlmFactoryOptions = {}): LlmClient {
  const env = loadEnvConfig();
  if (env.llmProvider === "bifrost") {
    return new BifrostClient({
      apiKey: requiredConfig(env.bifrostApiKey, "BIFROST_API_KEY"),
      baseUrl: requiredConfig(env.bifrostBaseUrl, "BIFROST_BASE_URL"),
      model: env.bifrostModel
    });
  }

  return new GeminiRoundRobinClient({ apiKeys: options.apiKeys, model: options.geminiModel });
}

export function getLlmAvailability(options: LlmFactoryOptions = {}): LlmAvailability {
  const env = loadEnvConfig();
  if (env.llmProvider === "bifrost") {
    const missing = [
      env.bifrostApiKey ? null : "BIFROST_API_KEY",
      env.bifrostBaseUrl ? null : "BIFROST_BASE_URL",
      env.bifrostModel ? null : "BIFROST_MODEL"
    ].filter((name): name is string => Boolean(name));

    return {
      provider: "bifrost",
      configured: missing.length === 0,
      keyCount: env.bifrostApiKey ? 1 : 0,
      unavailableReason: missing.length > 0 ? `missing ${missing.join(", ")}` : null
    };
  }

  const apiKeys = options.apiKeys !== undefined ? uniqueStrings(options.apiKeys) : env.geminiApiKeys;
  return {
    provider: "gemini",
    configured: apiKeys.length > 0,
    keyCount: apiKeys.length,
    unavailableReason: apiKeys.length > 0 ? null : "missing Gemini API key"
  };
}

function requiredConfig(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${name} is missing.`);
  }
  return trimmed;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
