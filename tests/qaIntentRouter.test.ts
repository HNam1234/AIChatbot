import { describe, expect, it } from "vitest";
import {
  detectIntent,
  handleChapterSummary,
  handleDefinition,
  handleDocumentSummary,
  handleExactHsCodeLookup,
  handleProductClassification,
  type QaDocumentMetadata
} from "../src/agent/qaIntentRouter";
import {
  evaluateCandidateRelevance,
  type EnrichedRetrievedSection,
  type SectionMetadata
} from "../src/agent/qaAnswerFormatter";

describe("qaIntentRouter", () => {
  const sections: SectionMetadata[] = [
    {
      document: "Chapter01.pdf",
      chapter: "CHAPTER 1",
      hsCode: "0102.29.11",
      title: "OXEN",
      section: "0102.29.11 - OXEN",
      textPreview: "Oxen are castrated adult male bovine animals."
    },
    {
      document: "Chapter02.pdf",
      chapter: "CHAPTER 2",
      hsCode: "0207.14.10",
      groupedHsCodes: ["0207.14.10", "0207.27.10"],
      title: "MECHANICALLY DEBONED MEAT",
      section: "0207.14.10 - MECHANICALLY DEBONED MEAT",
      textPreview: "Grouped HS code set: 0207.14.10, 0207.27.10."
    },
    {
      document: "Tariff_chapter-10.pdf",
      chapter: "CHAPTER 10",
      hsCode: "1001.99.10",
      title: "WHEAT",
      section: "1001.99.10 - WHEAT",
      textPreview: "Wheat and meslin."
    }
  ];

  const documents: QaDocumentMetadata[] = [
    { document: "Chapter01.pdf", input: "data/uploads/Chapter01.pdf" },
    { document: "Chapter02.pdf", input: "data/uploads/Chapter02.pdf" },
    { document: "Tariff_chapter-10.pdf", input: "data/uploads/Tariff_chapter-10.pdf" },
    {
      document: "Introduction.pdf",
      input: "data/uploads/Introduction.pdf",
      rootText: "# Introduction\nThis reference document explains how to read the tariff schedule."
    }
  ];

  it("detects exact HS code lookup and returns the matching section", () => {
    const detection = detectIntent("Tra HS Code 0102.29.11");
    const result = handleExactHsCodeLookup("Tra HS Code 0102.29.11", sections, detection);

    expect(detection.intent).toBe("exact_hscode_lookup");
    expect(result.selectedPrimary?.hsCode).toBe("0102.29.11");
    expect(result.answer).toContain("Oxen");
    expect(result.answer).toContain("0102.29.11");
  });

  it("uses product_classification as the default for attribute-heavy product queries", () => {
    const query = "Meat paste separated by mechanical process belongs to which HS code?";
    const selected = retrievedFixture({
      document: "Chapter02.pdf",
      hsCode: "0207.14.10",
      groupedHsCodes: ["0207.14.10", "0207.27.10"],
      title: "MECHANICALLY DEBONED MEAT",
      section: "0207.14.10 - MECHANICALLY DEBONED MEAT",
      text: "Mechanically deboned meat is meat paste separated by mechanical process."
    });
    const result = handleProductClassification(query, selected, [], undefined, [], detectIntent(query));

    expect(result.intent).toBe("product_classification");
    expect(result.answer).toContain("0207.14.10");
    expect(result.answer).toContain("0207.27.10");
  });

  it("returns definition text with HS code metadata", () => {
    const query = "What is Oxen?";
    const selected = retrievedFixture({
      document: "Chapter01.pdf",
      hsCode: "0102.29.11",
      title: "OXEN",
      section: "0102.29.11 - OXEN",
      text: "Oxen are castrated adult male bovine animals. They are used as draft animals."
    });
    const result = handleDefinition(query, selected, [], detectIntent(query));

    expect(result.intent).toBe("definition");
    expect(result.selectedPrimary?.hsCode).toBe("0102.29.11");
    expect(result.answer).toContain("Oxen are castrated adult male bovine animals.");
    expect(result.answer).toContain("HS Code: 0102.29.11");
  });

  it("summarizes chapter 2 dynamically without selecting a product section", () => {
    const query = "tóm tắt chương 2";
    const result = handleChapterSummary(query, sections, documents, detectIntent(query));

    expect(result.intent).toBe("chapter_summary");
    expect(result.documentSummary?.document).toBe("Chapter02.pdf");
    expect(result.selectedPrimary).toBeNull();
    expect(result.citations).toEqual([]);
    expect(result.answer).toContain("Chapter 2 nói về các nội dung chính:");
    expect(result.answer).toContain("0207.14.10");
  });

  it("routes natural Vietnamese chapter-about phrasing to chapter_summary", () => {
    const queries = [
      "chapter 10 nói về cái j",
      "chương 10 nói về gì",
      "chapter 10 có nội dung gì",
      "chapter 10 gồm những gì",
      "chapter 10 về gì"
    ];

    for (const query of queries) {
      const detection = detectIntent(query);
      const result = handleChapterSummary(query, sections, documents, detection);

      expect(detection.intent).toBe("chapter_summary");
      expect(detection.chapterNumber).toBe(10);
      expect(result.intent).toBe("chapter_summary");
      expect(result.selectedPrimary).toBeNull();
      expect(result.documentSummary?.document).toBe("Tariff_chapter-10.pdf");
      expect(result.answer).toContain("Chapter 10 nói về các nội dung chính:");
      expect(result.answer).not.toContain("Sản phẩm là");
    }
  });

  it("routes English chapter-about phrasing to chapter_summary", () => {
    for (const query of ["what is chapter 10 about", "what does chapter 10 cover"]) {
      const detection = detectIntent(query);

      expect(detection.intent).toBe("chapter_summary");
      expect(detection.chapterNumber).toBe(10);
    }
  });

  it("summarizes reference documents from manifest metadata", () => {
    const query = "document Introduction có gì";
    const result = handleDocumentSummary(query, sections, documents, detectIntent(query));

    expect(result.intent).toBe("document_summary");
    expect(result.documentSummary?.document).toBe("Introduction.pdf");
    expect(result.documentSummary?.isReference).toBe(true);
    expect(result.answer).toContain("tài liệu tham chiếu");
  });

  it("does not carry product selection into a following chapter summary", () => {
    const product = handleProductClassification(
      "What is Oxen?",
      retrievedFixture({
        document: "Chapter01.pdf",
        hsCode: "0102.29.11",
        title: "OXEN",
        section: "0102.29.11 - OXEN",
        text: "Oxen are castrated adult male bovine animals."
      }),
      [],
      undefined,
      [],
      detectIntent("What is Oxen?")
    );
    const summary = handleChapterSummary("tóm tắt chương 2", sections, documents, detectIntent("tóm tắt chương 2"));

    expect(product.selectedPrimary?.hsCode).toBe("0102.29.11");
    expect(summary.selectedPrimary).toBeNull();
    expect(summary.citations).toEqual([]);
  });

  it("rejects product candidates that only match token 2", () => {
    const candidate = retrievedFixture({
      document: "Chapter02.pdf",
      hsCode: "0201.10.00",
      title: "BOVINE MEAT",
      section: "0201.10.00 - BOVINE MEAT",
      text: "Chapter 2 meat products."
    });
    const relevance = evaluateCandidateRelevance(candidate, "2");

    expect(relevance.rejected).toBe(true);
    expect(relevance.rejectedReason).toContain("weak generic");
  });

  it("routes numeric-only product query to numeric lookup instead of classification", () => {
    const query = "0.8";
    const selected = retrievedFixture({
      document: "Chapter09.pdf",
      hsCode: "0901.11.30",
      title: "ROBUSTA COFFEE",
      section: "0901.11.30 - ROBUSTA COFFEE",
      text: "Robusta coffee has acidity 0.8% and strong taste.",
      score: 55
    });
    const result = handleProductClassification(query, selected, [], undefined, [candidateFor(selected, {
      finalScore: 55,
      numericMatches: ["0.8"],
      matchedTerms: ["0.8"]
    })], detectIntent(query));

    expect(result.answerMode).toBe("numeric_lookup");
    expect(result.answerConfidence).toBe("low");
    expect(result.answer).not.toContain("Sáº£n pháº©m lÃ ");
  });

  it("allows rich product queries with score and multiple strong signals to classify", () => {
    const query = "Bitter Robusta coffee beans with caffeine more than 2% and raw beans form";
    const selected = retrievedFixture({
      document: "Chapter09.pdf",
      hsCode: "0901.11.30",
      title: "ROBUSTA COFFEE",
      section: "0901.11.30 - ROBUSTA COFFEE",
      text: "Robusta coffee beans have bitter taste, caffeine more than 2%, and raw beans form.",
      score: 72
    });
    const result = handleProductClassification(query, selected, [], undefined, [candidateFor(selected, {
      finalScore: 72,
      matchedTerms: ["robusta", "coffee", "bitter", "caffeine", "beans"],
      candidateMatchedPhrases: ["robusta coffee", "raw beans"],
      numericMatches: ["more than 2%"]
    })], detectIntent(query));

    expect(result.answerMode).toBe("classification");
    expect(result.answerConfidence).toBe("high");
    expect((result.debug.strongSignals ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("does not classify when final score is below 20", () => {
    const selected = retrievedFixture({
      document: "Chapter12.pdf",
      hsCode: "1211.90.95",
      title: "AGARWOOD CHIPS",
      section: "1211.90.95 - AGARWOOD CHIPS",
      text: "Agarwood chips are resinous wood pieces.",
      score: 19
    });
    const result = handleProductClassification("resinous fragrant product", selected, [], undefined, [candidateFor(selected, {
      finalScore: 19,
      matchedTerms: ["resinous"]
    })], detectIntent("resinous fragrant product"));

    expect(result.answerMode).not.toBe("classification");
    expect(result.answer).not.toContain("Sáº£n pháº©m lÃ ");
  });

  it("does not classify medium score without strong signals", () => {
    const selected = retrievedFixture({
      document: "Chapter10.pdf",
      hsCode: "1001.99.10",
      title: "WHEAT",
      section: "1001.99.10 - WHEAT",
      text: "Wheat and meslin.",
      score: 45
    });
    const result = handleProductClassification("grain goods", selected, [], undefined, [candidateFor(selected, {
      finalScore: 45,
      matchedTerms: ["grain"]
    })], detectIntent("grain goods"));

    expect(["lookup", "clarification"]).toContain(result.answerMode);
    expect(result.answerMode).not.toBe("classification");
  });

  it("allows medium score with strong title and phrase signals", () => {
    const selected = retrievedFixture({
      document: "Chapter02.pdf",
      hsCode: "0207.14.10",
      title: "MECHANICALLY DEBONED MEAT",
      section: "0207.14.10 - MECHANICALLY DEBONED MEAT",
      text: "Mechanically deboned meat is meat paste separated by mechanical process.",
      score: 55
    });
    const result = handleProductClassification("mechanically deboned meat paste", selected, [], undefined, [candidateFor(selected, {
      finalScore: 55,
      matchedTerms: ["mechanically", "deboned", "meat", "paste"],
      candidateMatchedPhrases: ["mechanically deboned", "meat paste"]
    })], detectIntent("mechanically deboned meat paste"));

    expect(result.answerMode).toBe("classification");
    expect(result.answerConfidence).toBe("medium");
  });

  it("does not classify contrast-only candidates", () => {
    const selected = retrievedFixture({
      document: "Chapter09.pdf",
      hsCode: "0901.21.12",
      title: "ARABICA COFFEE",
      section: "0901.21.12 - ARABICA COFFEE",
      text: "Arabica coffee has mild aroma.",
      score: 60
    });
    const result = handleProductClassification("more bitter than Arabica", selected, [], undefined, [candidateFor(selected, {
      finalScore: 60,
      contrastTermOnlyMatch: true,
      contrastTerms: ["arabica"],
      rejected: true,
      rejectedReason: "candidate only matches contrast baseline terms"
    })], detectIntent("more bitter than Arabica"));

    expect(result.answerMode).not.toBe("classification");
    expect(result.debug.contradictions ?? []).toContain("contrast_term_only_match");
  });

  it("keeps exact HS code lookup deterministic even without relevance score", () => {
    const result = handleExactHsCodeLookup("0102.29.11", sections, detectIntent("0102.29.11"));

    expect(result.answerMode).toBe("exact_hscode_lookup");
    expect(result.answerConfidence).toBe("high");
    expect(result.answer).toContain("HS Code 0102.29.11");
  });

  it("keeps chapter summary deterministic without product selectedPrimary", () => {
    const result = handleChapterSummary("chapter 2 noi dung", sections, documents, detectIntent("chapter 2 noi dung"));

    expect(result.answerMode).toBe("chapter_summary");
    expect(result.selectedPrimary).toBeNull();
    expect(result.answer).not.toContain("Sáº£n pháº©m lÃ ");
  });

  it("definition asks clarification when candidate relevance is rejected", () => {
    const selected = retrievedFixture({
      document: "Chapter01.pdf",
      hsCode: "0102.29.11",
      title: "OXEN",
      section: "0102.29.11 - OXEN",
      text: "Oxen are castrated adult male bovine animals.",
      score: 1
    });
    const result = handleDefinition("What is it?", selected, [candidateFor(selected, {
      finalScore: 1,
      rejected: true,
      rejectedReason: "candidate has low generic token, phrase, and numeric overlap with query"
    })], detectIntent("What is it?"));

    expect(result.answerMode).toBe("clarification");
    expect(result.answer).toContain("Chưa đủ thông tin");
  });
});

function retrievedFixture(overrides: Partial<EnrichedRetrievedSection>): EnrichedRetrievedSection {
  return {
    document: "Chapter.pdf",
    text: "",
    captions: [],
    score: 1,
    metadataWarnings: [],
    ...overrides
  };
}

function candidateFor(section: EnrichedRetrievedSection, overrides: Partial<ReturnType<typeof evaluateCandidateRelevance>>): ReturnType<typeof evaluateCandidateRelevance> {
  return {
    document: section.document,
    hsCode: section.hsCode,
    groupedHsCodes: section.groupedHsCodes ?? [],
    title: section.title,
    section: section.section,
    source: section.source,
    pageStart: section.pageStart ?? null,
    pageEnd: section.pageEnd ?? null,
    matchedTerms: [],
    matchedNumericRanges: [],
    matchedAttributes: [],
    missingImportantTerms: [],
    contrastTermOnlyMatch: false,
    relevanceScore: section.score,
    queryTokens: [],
    queryPhrases: [],
    candidateMatchedTokens: [],
    candidateMatchedPhrases: [],
    numericMatches: [],
    contrastTerms: [],
    finalScore: section.score,
    rejected: false,
    rejectedReason: null,
    ...overrides
  };
}
