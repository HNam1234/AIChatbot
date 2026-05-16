import { describe, expect, it } from "vitest";
import {
  buildHsCodePrompt,
  GeminiRoundRobinClient,
  isRetryableGeminiError,
  type GeminiTextGenerator
} from "../src/agent/geminiClient";

describe("GeminiRoundRobinClient", () => {
  it("fails over to the next key on retryable errors", async () => {
    const calls: string[] = [];
    const generator: GeminiTextGenerator = {
      async generateText({ apiKey }) {
        calls.push(apiKey);
        if (apiKey === "key-1") {
          const error = new Error("Resource exhausted");
          (error as Error & { status?: number }).status = 429;
          throw error;
        }
        return "0704.90.10 - ROUND CABBAGES";
      }
    };
    const client = new GeminiRoundRobinClient({
      apiKeys: ["key-1", "key-2"],
      generator
    });

    await expect(client.synthesizeAnswer("ROUND CABBAGES", "cabbage")).resolves.toContain("0704.90.10");
    expect(calls).toEqual(["key-1", "key-2"]);
  });

  it("does not retry non-retryable errors", async () => {
    const calls: string[] = [];
    const generator: GeminiTextGenerator = {
      async generateText({ apiKey }) {
        calls.push(apiKey);
        const error = new Error("Bad request");
        (error as Error & { status?: number }).status = 400;
        throw error;
      }
    };
    const client = new GeminiRoundRobinClient({
      apiKeys: ["key-1", "key-2"],
      generator
    });

    await expect(client.synthesizeAnswer("context", "query")).rejects.toThrow("Bad request");
    expect(calls).toEqual(["key-1"]);
  });

  it("detects retryable Gemini quota and transient failures", () => {
    expect(isRetryableGeminiError(Object.assign(new Error("quota exceeded"), { status: 429 }))).toBe(true);
    expect(isRetryableGeminiError(Object.assign(new Error("server error"), { status: 503 }))).toBe(true);
    expect(isRetryableGeminiError(Object.assign(new Error("invalid key"), { status: 401 }))).toBe(false);
  });

  it("builds a grounded HS Code prompt", () => {
    const prompt = buildHsCodePrompt("Context text", "Question text", "Vietnamese");

    expect(prompt).toContain("Use only the provided context");
    expect(prompt).toContain("Context text");
    expect(prompt).toContain("Question text");
  });
});
