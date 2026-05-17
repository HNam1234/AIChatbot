import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveGeminiApiKeys } from "../src/config/gemini";

describe("resolveGeminiApiKeys", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("skips disabled Gemini key slots", () => {
    vi.stubEnv("GEMINI_KEY_1", "banned-key");
    vi.stubEnv("GEMINI_KEY_1_ENABLED", "false");
    vi.stubEnv("GEMINI_KEY_2", "healthy-key");
    vi.stubEnv("GEMINI_KEY_2_ENABLED", "true");
    vi.stubEnv("GEMINI_KEY_3", "off-key");
    vi.stubEnv("GEMINI_KEY_3_ENABLED", "0");
    vi.stubEnv("GEMINI_API_KEY", "");

    expect(resolveGeminiApiKeys()).toEqual(["healthy-key"]);
  });

  it("uses explicit override keys only", () => {
    vi.stubEnv("GEMINI_KEY_1", "saved-key");
    vi.stubEnv("GEMINI_KEY_1_ENABLED", "true");
    vi.stubEnv("GEMINI_KEY_2", "");
    vi.stubEnv("GEMINI_KEY_3", "");
    vi.stubEnv("GEMINI_API_KEY", "");

    expect(resolveGeminiApiKeys(["typed-key"])).toEqual(["typed-key"]);
  });
});
