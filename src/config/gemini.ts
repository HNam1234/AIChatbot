export function resolveGeminiApiKeys(overrides: string[] = []): string[] {
  const keys = [
    ...overrides,
    process.env.GEMINI_KEY_1,
    process.env.GEMINI_KEY_2,
    process.env.GEMINI_KEY_3,
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
