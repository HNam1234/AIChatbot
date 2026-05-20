import { describe, expect, it } from "vitest";
import { answerFromCachedTrees, answerQuestionForEval } from "../src/server/routes";
import type { QueryExpansionProvider } from "../src/agent/queryExpansion";

describe("Q&A scope isolation", () => {
  it("answers simple small-talk without retrieval or LLM", async () => {
    const response = await answerQuestionForEval("hello", { debug: true });

    expect(response.intent).toBe("small_talk");
    expect(response.answerMode).toBe("small_talk");
    expect(response.answerConfidence).toBe("high");
    expect(response.llmCalled).toBe(false);
    expect(response.llmSkippedReason).toBe("small_talk_fast_path");
    expect(response.citations).toEqual([]);
    expect(response.selectedPrimary).toBeNull();
    expect(response.retrieval).toMatchObject({
      source: "local-metadata",
      pageIndexResultCount: 0,
      selectedSection: null
    });
    expect((response.debug as { queryExpansion?: { expandedQuery?: string } }).queryExpansion?.expandedQuery).toBe("hello");
  });

  it("does not return Chapter10 results when local scope is Chapter01", async () => {
    const response = await answerQuestionForEval("Tra cứu HS Code 1001.99.99", {
      localSectionDocuments: ["Chapter01.pdf"],
      debug: true
    });

    expect(response.intent).toBe("exact_hscode_lookup");
    expect(response.selectedPrimary).toBeNull();
    expect(String(response.answer)).not.toContain("Chapter10");
    expect(JSON.stringify(response)).not.toContain("1001.99.99 — WHEAT");
    expect((response.debug as { scope?: { mode?: string; allowedDocuments?: string[] } })?.scope?.mode).toBe("selected");
    expect((response.debug as { scope?: { allowedDocuments?: string[] } })?.scope?.allowedDocuments).toEqual(["Chapter01.pdf"]);
  });

  it("can return Chapter10 when local scope is Chapter10", async () => {
    const response = await answerQuestionForEval("Tra cứu HS Code 1001.99.99", {
      localSectionDocuments: ["Chapter10.pdf"],
      debug: true
    });

    expect(response.selectedPrimary).toMatchObject({
      document: "Chapter10.pdf",
      hsCode: "1001.99.99"
    });
    expect(String(response.answer)).not.toMatch(/Index source|PageIndex tree result used|Final HS Code|Primary citation|Related citation|Marker 12/i);
  });

  it("can return Chapter10 in all-documents scope", async () => {
    const response = await answerQuestionForEval("Tra cứu HS Code 1001.99.99", { debug: true });

    expect(response.selectedPrimary).toMatchObject({
      document: "Chapter10.pdf",
      hsCode: "1001.99.99"
    });
  });

  it("keeps summary answers free of product citations", async () => {
    const response = await answerQuestionForEval("chapter 10 nói về gì", {
      localSectionDocuments: ["Chapter10.pdf"],
      debug: true
    });

    expect(response.intent).toBe("chapter_summary");
    expect(response.selectedPrimary).toBeNull();
    expect(response.citations).toEqual([]);
  });

  it("keeps related candidates inside selected scope", async () => {
    const response = await answerQuestionForEval("Which coffee is more bitter than Arabica and has higher caffeine?", {
      localSectionDocuments: ["Chapter09.pdf"],
      debug: true
    });
    const retrievedSections = response.retrievedSections as Array<{ document?: string }> | undefined;

    expect(response.selectedPrimary).toMatchObject({ document: "Chapter09.pdf" });
    expect((retrievedSections ?? []).every((section) => section.document === "Chapter09.pdf")).toBe(true);
  });

  it("does not repair an answer with HS metadata from outside selected scope", async () => {
    const response = await answerQuestionForEval("Tra cứu HS Code 1005.90.10", {
      localSectionDocuments: ["Chapter01.pdf"],
      debug: true
    });
    const retrieval = response.retrieval as { finalHsCodes?: string[] } | undefined;

    expect(response.selectedPrimary).toBeNull();
    expect(String(response.answer)).toContain("tài liệu đã chọn");
    expect(retrieval?.finalHsCodes ?? []).not.toContain("1005.90.10");
    expect(JSON.stringify(response)).not.toContain("Chapter10.pdf");
  });

  it("uses local extractive generation before selected-section LLM for non-HS appearance questions", async () => {
    let capturedTextLength = 0;
    const response = await answerFromCachedTrees("Breeding fish appearance requirements?", {
      localSectionDocuments: ["Chapter03.pdf"],
      geminiApiKeys: [],
      enableLlmQa: true,
      debug: true,
      selectedSectionAnswerer: {
        async synthesizeSectionAnswer(section) {
          capturedTextLength = section.text.length;
          return "Yêu cầu ngoại quan: thân cân đối, không dị tật, vây đầy đủ và bình thường.";
        }
      }
    });

    expect(response.intent).toBe("selected_section_qa");
    expect(response.answerGeneration).toBe("extractive-field");
    expect((response.debug as { answerGeneration?: string; llmCalled?: boolean; sectionTextChars?: number }).answerGeneration).toBe("extractive-field");
    expect((response.debug as { llmCalled?: boolean }).llmCalled).toBe(false);
    expect((response.debug as { localExtractorUsed?: boolean }).localExtractorUsed).toBe(true);
    expect((response.debug as { llmSkippedReason?: string | null }).llmSkippedReason).toBe("local_extractor_succeeded");
    expect((response.debug as { sectionTextChars?: number }).sectionTextChars ?? 0).toBeGreaterThan(0);
    expect(capturedTextLength).toBe(0);
    expect(String(response.answer)).toContain("General requirements on appearance");
    expect(String(response.answer)).toContain("Well-proportioned body");
    expect(String(response.answer)).not.toContain("Sản phẩm là");
    expect(String(response.answer)).not.toContain("HS Code");
  });

  it("does not call selected-section LLM generation by default", async () => {
    let callCount = 0;
    const response = await answerFromCachedTrees("Breeding fish appearance requirements?", {
      localSectionDocuments: ["Chapter03.pdf"],
      geminiApiKeys: [],
      debug: true,
      selectedSectionAnswerer: {
        async synthesizeSectionAnswer() {
          callCount += 1;
          return "This should not be used.";
        }
      }
    });

    expect(response.intent).toBe("selected_section_qa");
    expect(response.answerGeneration).toBe("extractive-field");
    expect(response.llmCalled).toBe(false);
    expect((response.debug as { llmCalled?: boolean; llmSkippedReason?: string | null }).llmCalled).toBe(false);
    expect((response.debug as { llmSkippedReason?: string | null }).llmSkippedReason).toBe("local_extractor_succeeded");
    expect((response.debug as { localExtractorUsed?: boolean }).localExtractorUsed).toBe(true);
    expect(callCount).toBe(0);
    expect(String(response.answer)).not.toContain("This should not be used");
    expect(String(response.answer)).not.toMatch(/Answer generation|llmCalled|llmSkippedReason|fallbackReason/i);
  });

  it("uses expanded query for retrieval while keeping the original query for answer generation", async () => {
    const originalQuery = "ca giong thong tin?";
    let expansionCallCount = 0;
    let capturedAnswerQuery = "";
    const queryExpansionProvider = mockQueryExpansionProvider(async (query, prompt) => {
      expansionCallCount += 1;
      expect(query).toBe(originalQuery);
      expect(prompt).toContain("Do not answer the question.");
      return {
        englishQuery: "breeding fish requirements",
        keywords: ["breeding fish", "requirements"],
        phrases: ["breeding fish"],
        confidence: "high"
      };
    });

    const response = await answerFromCachedTrees(originalQuery, {
      localSectionDocuments: ["Chapter03.pdf"],
      enableLlmQa: true,
      debug: true,
      queryExpansionProvider,
      queryExpansionConfig: {
        enabled: true,
        provider: "gemini",
        maxTerms: 12,
        timeoutMs: 3000,
        cacheEnabled: false
      },
      selectedSectionAnswerer: {
        async synthesizeSectionAnswer(_section, query) {
          capturedAnswerQuery = query;
          return "Thong tin ve section breeding fish.";
        }
      }
    });

    const debug = response.debug as {
      queryExpansion?: { expandedQuery?: string; expansionTerms?: string[]; expansionSource?: string };
      candidates?: Array<{ matchedOriginalTerms?: string[]; matchedExpansionTerms?: string[] }>;
    };

    expect(expansionCallCount).toBe(1);
    expect(capturedAnswerQuery).toBe(originalQuery);
    expect(response.selectedPrimary).toMatchObject({ document: "Chapter03.pdf" });
    expect(debug.queryExpansion?.expandedQuery).toContain(originalQuery);
    expect(debug.queryExpansion?.expandedQuery).toContain("breeding fish");
    expect(debug.queryExpansion?.expansionSource).toBe("llm");
    expect((debug.candidates ?? []).some((candidate) => (candidate.matchedExpansionTerms ?? []).length > 0)).toBe(true);
  });

  it("uses safe fallback for non-HS selected-section questions when local extraction fails and LLM is unavailable", async () => {
    const response = await answerQuestionForEval("Breeding fish warranty handling details?", {
      localSectionDocuments: ["Chapter03.pdf"],
      debug: true
    });

    expect(response.intent).toBe("selected_section_qa");
    expect(response.answerGeneration).toBe("safe-fallback");
    expect((response.debug as { answerGeneration?: string; llmCalled?: boolean; fallbackReason?: string | null; llmSkippedReason?: string | null }).answerGeneration).toBe("safe-fallback");
    expect((response.debug as { llmCalled?: boolean }).llmCalled).toBe(false);
    expect((response.debug as { llmSkippedReason?: string | null }).llmSkippedReason).toBe("ENABLE_LLM_QA=false");
    expect((response.debug as { fallbackReason?: string | null }).fallbackReason).toBe("local_extractor_no_requested_field");
    expect(String(response.answer)).toBe("I found a relevant section, but I could not extract the answer from its text. Please try again or enable an API key.");
    expect(String(response.answer)).not.toContain("Sản phẩm là");
    expect(String(response.answer)).not.toContain("HS Code");
  });

  it("does not treat safe fallback as local extractor success", async () => {
    const response = await answerQuestionForEval("Breeding fish warranty handling details?", {
      localSectionDocuments: ["Chapter03.pdf"],
      debug: true
    });

    expect(response.answerGeneration).toBe("safe-fallback");
    expect((response.debug as { localExtractorUsed?: boolean }).localExtractorUsed).toBe(false);
    expect((response.debug as { llmSkippedReason?: string | null }).llmSkippedReason).toBe("ENABLE_LLM_QA=false");
    expect((response.debug as { fallbackReason?: string | null }).fallbackReason).toBe("local_extractor_no_requested_field");
    expect(String(response.answer)).not.toMatch(/Answer generation|llmCalled|fallbackReason|Index source|PageIndex/i);
  });

  it("falls back and records LLM quota failures without retrying the injected answerer", async () => {
    let callCount = 0;
    const response = await answerFromCachedTrees("Breeding fish warranty handling details?", {
      localSectionDocuments: ["Chapter03.pdf"],
      geminiApiKeys: [],
      enableLlmQa: true,
      debug: true,
      selectedSectionAnswerer: {
        async synthesizeSectionAnswer() {
          callCount += 1;
          throw new Error("quota exceeded");
        }
      }
    });

    expect(response.intent).toBe("selected_section_qa");
    expect(response.answerGeneration).toBe("safe-fallback");
    expect(response.llmCalled).toBe(true);
    expect(response.llmErrorType).toBe("quota");
    expect((response.debug as { llmErrorType?: string | null; fallbackReason?: string | null }).llmErrorType).toBe("quota");
    expect((response.debug as { fallbackReason?: string | null }).fallbackReason).toBe("llm_quota");
    expect(callCount).toBe(1);
    expect(String(response.answer)).not.toContain("Sản phẩm là");
    expect(String(response.answer)).not.toContain("HS Code");
  });

  it("still uses metadata template for explicit HS code selected-section questions", async () => {
    const response = await answerQuestionForEval("Agarwood chips HS Code?", {
      localSectionDocuments: ["Chapter12.pdf"],
      debug: true
    });

    expect(response.intent).toBe("product_classification");
    expect(response.answerGeneration).toBe("template-classification");
    expect((response.debug as { answerGeneration?: string }).answerGeneration).toBe("template-classification");
    expect(String(response.answer)).toContain("The product is Agarwood (Gaharu) chips, HS Code: 1211.90.95.");
    expect(String(response.answer)).not.toMatch(/Index source|PageIndex|cache freshness|candidate debug/i);
  });

  it("classifies Cambodia premium fragrant rice as Malys rice without LLM QA", async () => {
    const query = "Một loại gạo thơm của Cambodia, có hạt dài, mùi thơm tự nhiên và thường được gọi là premium fragrant rice. HS Code đúng là gì?";
    const response = await answerFromCachedTrees(query, {
      cachedTreeDocuments: ["Chapter10.pdf"],
      geminiApiKeys: [],
      enableLlmQa: false,
      debug: true,
      queryExpansionConfig: { enabled: false }
    });

    expect(response.intent).toBe("product_classification");
    expect(response.selectedPrimary).toMatchObject({
      document: "Chapter10.pdf",
      hsCode: "1006.30.60",
      title: "MALYS RICE"
    });
    expect(String(response.answer)).toContain("HS Code: 1006.30.60");
    expect((response.debug as { domainAliasTerms?: string[] }).domainAliasTerms).toContain("malys rice");
    expect((response.debug as { candidateAliasSignals?: string[] }).candidateAliasSignals).toContain("malys rice");
    expect((response.debug as { llmRerankCalled?: boolean }).llmRerankCalled).toBe(false);
  });

  it("answers Chapter08 coconut water reducing sugars table comparisons without LLM QA", async () => {
    const response = await answerFromCachedTrees("Dua tren bang so sanh nuoc dua, loai coconut water nao co reducing sugars cao hon: mature hay tender/young?", {
      cachedTreeDocuments: ["Chapter08.pdf"],
      geminiApiKeys: [],
      enableLlmQa: false,
      debug: true,
      queryExpansionConfig: { enabled: false }
    });

    expect(response.selectedPrimary).toMatchObject({ document: "Chapter08.pdf", hsCode: "0801.19.10" });
    expect(response.selectedPrimary).toMatchObject({
      pdfUrl: "/api/uploads/Chapter08.pdf",
      pdfPageUrl: expect.stringMatching(/^\/api\/uploads\/Chapter08\.pdf#page=\d+$/)
    });
    expect((response.citations as Array<Record<string, unknown>>)[0]).toMatchObject({
      document: "Chapter08.pdf",
      pdfUrl: "/api/uploads/Chapter08.pdf",
      pdfPageUrl: expect.stringMatching(/^\/api\/uploads\/Chapter08\.pdf#page=\d+$/)
    });
    expect(response.answerGeneration).toBe("extractive-field");
    expect(String(response.answer)).toContain("Tender/young coconut water");
    expect(String(response.answer)).toContain("4.4%");
    expect(String(response.answer)).toContain("mature coconut water");
    expect(String(response.answer)).toContain("0.2%");
    expect(String(response.answer)).not.toContain("HS Code");
  });

  it("answers mixed-language Chapter03 activeness field questions without leaking weight and size", async () => {
    const response = await answerFromCachedTrees("Breeding fish co yeu cau activeness the nao?", {
      cachedTreeDocuments: ["Chapter03.pdf"],
      geminiApiKeys: [],
      enableLlmQa: false,
      debug: true,
      queryExpansionConfig: { enabled: false }
    });

    expect(response.selectedPrimary).toMatchObject({ document: "Chapter03.pdf" });
    expect(response.answerGeneration).toBe("extractive-field");
    expect(String(response.answer)).toContain("Fish should be active, swift, swimming under the water in groups");
    expect(String(response.answer)).not.toContain("Weight and size");
    expect(String(response.answer)).not.toContain("Depends on each species");
    expect(String(response.answer)).not.toContain("HS Code");
  });

  it("accepts an injected LLM rerank only when it selects a listed candidate with confidence", async () => {
    const response = await answerFromCachedTrees("premium fragrant rice HS Code?", {
      cachedTreeDocuments: ["Chapter10.pdf"],
      geminiApiKeys: [],
      enableLlmQa: true,
      debug: true,
      queryExpansionConfig: { enabled: false },
      candidateReranker: {
        async planQuery() {
          return JSON.stringify({
            selectedHsCode: "1006.30.60",
            confidence: "high",
            reason: "mock selected listed candidate"
          });
        }
      }
    });

    expect(response.selectedPrimary).toMatchObject({ hsCode: "1006.30.60", title: "MALYS RICE" });
    expect((response.debug as { llmRerankCalled?: boolean; llmRerankAccepted?: boolean; llmRerankSelectedHsCode?: string }).llmRerankCalled).toBe(true);
    expect((response.debug as { llmRerankAccepted?: boolean }).llmRerankAccepted).toBe(true);
    expect((response.debug as { llmRerankSelectedHsCode?: string }).llmRerankSelectedHsCode).toBe("1006.30.60");
  });

  it("ignores an injected LLM rerank that selects an HS code outside the candidate list", async () => {
    const response = await answerFromCachedTrees("premium fragrant rice HS Code?", {
      cachedTreeDocuments: ["Chapter10.pdf"],
      geminiApiKeys: [],
      enableLlmQa: true,
      debug: true,
      queryExpansionConfig: { enabled: false },
      candidateReranker: {
        async planQuery() {
          return JSON.stringify({
            selectedHsCode: "9999.99.99",
            confidence: "high",
            reason: "mock unsupported code"
          });
        }
      }
    });

    expect(response.selectedPrimary).toMatchObject({ hsCode: "1006.30.70", title: "OTHER FRAGRANT RICE" });
    expect((response.debug as { llmRerankCalled?: boolean; llmRerankAccepted?: boolean; llmRerankSelectedHsCode?: string }).llmRerankCalled).toBe(true);
    expect((response.debug as { llmRerankAccepted?: boolean }).llmRerankAccepted).toBe(false);
    expect((response.debug as { llmRerankSelectedHsCode?: string }).llmRerankSelectedHsCode).toBe("9999.99.99");
  });

  it("treats a single broad Hevea token as broad lookup", async () => {
    const response = await answerQuestionForEval("hevea", {
      localSectionDocuments: ["Chapter06.pdf"],
      debug: true
    });

    expect(response.answerMode).toBe("broad_lookup");
    expect(response.answerGeneration).toBe("broad-lookup");
    expect(response.selectedPrimary).toBeNull();
    expect(String(response.answer)).toContain("Found multiple items related to 'hevea':");
    expect(String(response.answer)).toContain("Budded stumps of the genus Hevea");
    expect(String(response.answer)).toContain("Seedlings of the genus Hevea");
    expect(String(response.answer)).toContain("Budwood of the genus Hevea");
    expect(String(response.answer)).toContain("HS Code: 0602.90.40");
    expect(String(response.answer)).toContain("HS Code: 0602.90.50");
    expect(String(response.answer)).toContain("HS Code: 0602.90.60");
    expect((response.debug as { broadQueryDecision?: { reason?: string }; candidateCount?: number }).broadQueryDecision?.reason).toContain("single broad token");
    expect((response.debug as { candidateCount?: number }).candidateCount).toBeGreaterThanOrEqual(3);
  });

  it("can select Seedlings when Hevea query has a distinctive title token", async () => {
    const response = await answerQuestionForEval("seedlings hevea", {
      localSectionDocuments: ["Chapter06.pdf"],
      debug: true
    });

    expect(response.answerMode).not.toBe("ambiguous_lookup");
    expect(response.selectedPrimary).toMatchObject({
      hsCode: "0602.90.50",
      title: "SEEDLINGS OF THE GENUS HEVEA"
    });
  });

  it("accuracy mode reranks HS classification candidates with the configured LLM client", async () => {
    let rerankCallCount = 0;
    const response = await answerFromCachedTrees("premium fragrant rice HS Code?", {
      cachedTreeDocuments: ["Chapter10.pdf"],
      geminiApiKeys: [],
      qaMode: "accuracy",
      debug: true,
      queryExpansionProvider: mockQueryExpansionProvider(async () => ({
        englishQuery: "premium fragrant rice",
        confidence: "high"
      })),
      candidateReranker: {
        async planQuery() {
          rerankCallCount += 1;
          return JSON.stringify({
            selectedHsCode: "1006.30.60",
            confidence: "high",
            reason: "mock selected listed candidate"
          });
        }
      },
      candidateVerifier: {
        async planQuery() {
          return JSON.stringify({
            decision: "accept",
            selectedHsCode: "1006.30.60",
            confidence: "high",
            reason: "mock verifier accepted selected candidate"
          });
        }
      }
    });

    expect(rerankCallCount).toBe(1);
    expect(response.selectedPrimary).toMatchObject({ hsCode: "1006.30.60", title: "MALYS RICE" });
    expect((response.debug as { llmRerankCalled?: boolean; llmRerankAccepted?: boolean }).llmRerankCalled).toBe(true);
    expect((response.debug as { llmRerankAccepted?: boolean }).llmRerankAccepted).toBe(true);
    expect((response.debug as { qaMode?: string }).qaMode).toBe("accuracy");
  });

  it("accuracy verifier switches only to an HS code from the candidate list", async () => {
    const response = await answerFromCachedTrees("premium fragrant rice HS Code?", {
      cachedTreeDocuments: ["Chapter10.pdf"],
      geminiApiKeys: [],
      qaMode: "accuracy",
      debug: true,
      queryExpansionProvider: mockQueryExpansionProvider(async () => ({
        englishQuery: "premium fragrant rice",
        confidence: "high"
      })),
      candidateReranker: {
        async planQuery() {
          return JSON.stringify({
            selectedHsCode: "1006.30.70",
            confidence: "high",
            reason: "mock keeps deterministic top"
          });
        }
      },
      candidateVerifier: {
        async planQuery() {
          return JSON.stringify({
            decision: "switch",
            selectedHsCode: "1006.30.60",
            confidence: "high",
            reason: "mock verifier selected the better listed code"
          });
        }
      }
    });

    expect(response.selectedPrimary).toMatchObject({ hsCode: "1006.30.60", title: "MALYS RICE" });
    expect((response.debug as { llmVerifierCalled?: boolean; llmVerifierAccepted?: boolean; llmVerifierSelectedHsCode?: string }).llmVerifierCalled).toBe(true);
    expect((response.debug as { llmVerifierAccepted?: boolean }).llmVerifierAccepted).toBe(true);
    expect((response.debug as { llmVerifierSelectedHsCode?: string }).llmVerifierSelectedHsCode).toBe("1006.30.60");
  });

  it("accuracy verifier ignores switch decisions outside the candidate list", async () => {
    const response = await answerFromCachedTrees("premium fragrant rice HS Code?", {
      cachedTreeDocuments: ["Chapter10.pdf"],
      geminiApiKeys: [],
      qaMode: "accuracy",
      debug: true,
      queryExpansionProvider: mockQueryExpansionProvider(async () => ({
        englishQuery: "premium fragrant rice",
        confidence: "high"
      })),
      candidateReranker: {
        async planQuery() {
          return JSON.stringify({
            selectedHsCode: "1006.30.70",
            confidence: "high",
            reason: "mock keeps deterministic top"
          });
        }
      },
      candidateVerifier: {
        async planQuery() {
          return JSON.stringify({
            decision: "switch",
            selectedHsCode: "9999.99.99",
            confidence: "high",
            reason: "mock unsupported switch"
          });
        }
      }
    });

    expect(response.selectedPrimary).toMatchObject({ hsCode: "1006.30.70", title: "OTHER FRAGRANT RICE" });
    expect((response.debug as { llmVerifierCalled?: boolean; llmVerifierAccepted?: boolean; llmVerifierSelectedHsCode?: string }).llmVerifierCalled).toBe(true);
    expect((response.debug as { llmVerifierAccepted?: boolean }).llmVerifierAccepted).toBe(false);
    expect((response.debug as { llmVerifierSelectedHsCode?: string }).llmVerifierSelectedHsCode).toBe("9999.99.99");
  });
});

function mockQueryExpansionProvider(expand: QueryExpansionProvider["expand"]): QueryExpansionProvider {
  return {
    name: "gemini",
    source: "llm",
    model: "mock-expander",
    expand
  };
}
