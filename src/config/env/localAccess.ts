import { GEMINI_KEY_SLOTS } from "./constants";
import { loadEnvConfig } from "./loader";
import { nonEmpty } from "./parsers";
import type { AppConfig, GeminiKeySlotName } from "./types";

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

export function isGeminiKeySlotName(value: unknown): value is GeminiKeySlotName {
  return typeof value === "string" && GEMINI_KEY_SLOTS.some((slot) => slot.name === value);
}
