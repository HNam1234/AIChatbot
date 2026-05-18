import { describe, expect, it } from "vitest";
import { answerFromCachedTrees, answerQuestionForEval } from "../src/server/routes";

describe("Q&A scope isolation", () => {
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

  it("uses selected-section LLM generation for non-HS appearance questions", async () => {
    let capturedTextLength = 0;
    const response = await answerFromCachedTrees("Breeding fish appearance requirements?", {
      localSectionDocuments: ["Chapter03.pdf"],
      geminiApiKeys: [],
      debug: true,
      selectedSectionAnswerer: {
        async synthesizeSectionAnswer(section) {
          capturedTextLength = section.text.length;
          return "Yêu cầu ngoại quan: thân cân đối, không dị tật, vây đầy đủ và bình thường.";
        }
      }
    });

    expect(response.intent).toBe("selected_section_qa");
    expect(response.answerGeneration).toBe("llm-selected-section");
    expect((response.debug as { answerGeneration?: string; llmCalled?: boolean; sectionTextChars?: number }).answerGeneration).toBe("llm-selected-section");
    expect((response.debug as { llmCalled?: boolean }).llmCalled).toBe(true);
    expect((response.debug as { sectionTextChars?: number }).sectionTextChars ?? 0).toBeGreaterThan(0);
    expect(capturedTextLength).toBeGreaterThan(0);
    expect(String(response.answer)).toContain("Yêu cầu ngoại quan");
    expect(String(response.answer)).not.toContain("Sản phẩm là");
    expect(String(response.answer)).not.toContain("HS Code");
  });

  it("uses safe fallback for non-HS selected-section questions when LLM is unavailable", async () => {
    const response = await answerQuestionForEval("Breeding fish appearance requirements?", {
      localSectionDocuments: ["Chapter03.pdf"],
      debug: true
    });

    expect(response.intent).toBe("selected_section_qa");
    expect(response.answerGeneration).toBe("safe-fallback");
    expect((response.debug as { answerGeneration?: string; llmCalled?: boolean; fallbackReason?: string | null }).answerGeneration).toBe("safe-fallback");
    expect((response.debug as { llmCalled?: boolean }).llmCalled).toBe(false);
    expect((response.debug as { fallbackReason?: string | null }).fallbackReason).toBe("llm_unavailable");
    expect(String(response.answer)).toBe("Tôi đã tìm thấy section liên quan, nhưng chưa thể trích xuất câu trả lời từ nội dung section. Vui lòng thử lại hoặc bật API key.");
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
    expect(String(response.answer)).toContain("Sản phẩm là Agarwood (Gaharu) chips, HS Code: 1211.90.95.");
    expect(String(response.answer)).not.toMatch(/Index source|PageIndex|cache freshness|candidate debug/i);
  });

  it("treats a single broad Hevea token as ambiguous lookup", async () => {
    const response = await answerQuestionForEval("hevea", {
      localSectionDocuments: ["Chapter06.pdf"],
      debug: true
    });

    expect(response.answerMode).toBe("ambiguous_lookup");
    expect(response.answerGeneration).toBe("ambiguous-lookup");
    expect(response.selectedPrimary).toBeNull();
    expect(String(response.answer)).toContain("Tìm thấy nhiều mục liên quan đến 'hevea':");
    expect(String(response.answer)).toContain("Budded stumps of the genus Hevea");
    expect(String(response.answer)).toContain("Seedlings of the genus Hevea");
    expect(String(response.answer)).toContain("Budwood of the genus Hevea");
    expect(String(response.answer)).toContain("HS Code: 0602.90.40");
    expect(String(response.answer)).toContain("HS Code: 0602.90.50");
    expect(String(response.answer)).toContain("HS Code: 0602.90.60");
    expect((response.debug as { ambiguityReason?: string; candidateCount?: number }).ambiguityReason).toBe("single broad token matched multiple sections");
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
});
