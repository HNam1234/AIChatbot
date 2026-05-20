import { beforeEach, describe, expect, it } from "vitest";
import {
  clearQueryExpansionCache,
  expandQueryForRetrievalWithDebug,
  type QueryExpansionProvider,
  type QueryExpansionRuntimeConfig
} from "../src/agent/queryExpansion";

const enabledConfig: QueryExpansionRuntimeConfig = {
  enabled: true,
  provider: "gemini",
  maxTerms: 12,
  timeoutMs: 3000,
  cacheEnabled: true,
  retryCount: 0
};

beforeEach(() => {
  clearQueryExpansionCache();
});

describe("query expansion", () => {
  it("returns the original query without calling a provider when expansion is disabled", async () => {
    let callCount = 0;
    const provider = mockProvider(async () => {
      callCount += 1;
      return { englishQuery: "round cabbage", confidence: "high" };
    });

    const { result, debug } = await expandQueryForRetrievalWithDebug("bap cai tron", {
      provider,
      config: { ...enabledConfig, enabled: false }
    });

    expect(callCount).toBe(0);
    expect(result.originalQuery).toBe("bap cai tron");
    expect(result.expandedQuery).toBe("bap cai tron");
    expect(result.expansionTerms).toEqual([]);
    expect(result.expansionSource).toBe("none");
    expect(debug.cacheHit).toBe(false);
  });

  it("uses a mocked LLM provider and deduplicates expansion terms", async () => {
    const provider = mockProvider(async () => ({
      englishQuery: "breeding fish requirements",
      keywords: ["breeding fish", "requirements", "breeding fish"],
      phrases: ["certification requirements", "breeding fish"],
      confidence: "high"
    }));

    const { result } = await expandQueryForRetrievalWithDebug("ca giong can gi", {
      provider,
      config: enabledConfig
    });

    expect(result.originalQuery).toBe("ca giong can gi");
    expect(result.expandedQuery).toContain("ca giong can gi");
    expect(result.expandedQuery).toContain("breeding fish requirements");
    expect(result.expansionSource).toBe("llm");
    expect(result.confidence).toBe("high");
    expect(result.expansionTerms).toEqual([
      "breeding fish requirements",
      "breeding fish",
      "requirements",
      "certification requirements"
    ]);
  });

  it("falls back to the original query and records provider failures", async () => {
    const provider = mockProvider(async () => {
      throw new Error("quota exceeded");
    });

    const { result, debug } = await expandQueryForRetrievalWithDebug("ca giong", {
      provider,
      config: enabledConfig
    });

    expect(result.expandedQuery).toBe("ca giong");
    expect(result.expansionTerms).toEqual([]);
    expect(result.expansionSource).toBe("fallback");
    expect(result.error).toContain("quota exceeded");
    expect(debug.error).toContain("quota exceeded");
  });

  it("retries once with compact prompt and falls back with timeout debug when retry also fails", async () => {
    let callCount = 0;
    const provider = mockProvider(async (_query, prompt) => {
      callCount += 1;
      expect(prompt).toContain(callCount === 1 ? "retrieval query expansion module" : "Expand this HS code search query");
      throw new Error("Query expansion timed out after 12000ms.");
    });

    const { result, debug } = await expandQueryForRetrievalWithDebug("bong ca kho", {
      provider,
      config: { ...enabledConfig, timeoutMs: 12000, retryCount: 1 }
    });

    expect(callCount).toBe(2);
    expect(result.expandedQuery).toBe("bong ca kho");
    expect(result.expansionSource).toBe("fallback");
    expect(debug.retryCount).toBe(1);
    expect(debug.timedOut).toBe(true);
    expect(debug.error).toContain("timed out");
  });

  it("uses the cache for repeated normalized queries", async () => {
    let callCount = 0;
    const provider = mockProvider(async () => {
      callCount += 1;
      return {
        englishQuery: "round cabbage",
        keywords: ["cabbage"],
        phrases: ["round cabbage"],
        confidence: "high"
      };
    });

    const first = await expandQueryForRetrievalWithDebug("Cá giống", {
      provider,
      config: enabledConfig
    });
    const second = await expandQueryForRetrievalWithDebug("ca giong", {
      provider,
      config: enabledConfig
    });

    expect(callCount).toBe(1);
    expect(first.debug.cacheHit).toBe(false);
    expect(second.debug.cacheHit).toBe(true);
    expect(second.result.originalQuery).toBe("ca giong");
    expect(second.result.expandedQuery).toContain("ca giong");
    expect(second.result.expandedQuery).toContain("round cabbage");
  });
});

function mockProvider(expand: QueryExpansionProvider["expand"]): QueryExpansionProvider {
  return {
    name: "gemini",
    source: "llm",
    model: "mock-expander",
    expand
  };
}
