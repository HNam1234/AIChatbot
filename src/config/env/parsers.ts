import type { LlmProviderName, QueryExpansionProviderName } from "./types";

export function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function isEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized !== "false" && normalized !== "0" && normalized !== "off" && normalized !== "no";
}

export function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "on", "yes"].includes(normalized)) return true;
  if (["false", "0", "off", "no"].includes(normalized)) return false;
  return fallback;
}

export function readQueryExpansionProvider(value: string | undefined): QueryExpansionProviderName {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "gemini" || normalized === "openai" || normalized === "translation") {
    return normalized;
  }
  return "none";
}

export function readLlmProvider(value: string | undefined): LlmProviderName {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "bifrost") {
    return "bifrost";
  }
  return "gemini";
}
