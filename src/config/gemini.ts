export function resolveGeminiApiKeys(overrides: string[] = []): string[] {
  const keys = overrides.length > 0
    ? overrides
    : [
        enabledEnvKey("GEMINI_KEY_1", "GEMINI_KEY_1_ENABLED"),
        enabledEnvKey("GEMINI_KEY_2", "GEMINI_KEY_2_ENABLED"),
        enabledEnvKey("GEMINI_KEY_3", "GEMINI_KEY_3_ENABLED"),
        process.env.GEMINI_API_KEY
      ];
  const seen = new Set<string>();
  const resolved: string[] = [];

  for (const key of keys) {
    const trimmed = key?.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      resolved.push(trimmed);
    }
  }

  if (resolved.length === 0) {
    throw new Error("No Gemini API keys found. Set GEMINI_KEY_1..3, GEMINI_API_KEY, or pass --gemini-api-key.");
  }

  return resolved;
}

function enabledEnvKey(keyName: string, enabledName: string): string | undefined {
  return isEnabled(process.env[enabledName]) ? process.env[keyName] : undefined;
}

function isEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized !== "false" && normalized !== "0" && normalized !== "off" && normalized !== "no";
}
