import { describe, expect, it } from "vitest";
import {
  detectIntent,
  handleChapterSummary,
  handleDefinition,
  handleDocumentSummary,
  handleExactHsCodeLookup,
  handleProductClassification,
  handleSelectedSectionQa,
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

  it("uses metadata template when the query explicitly asks for HS Code", () => {
    const query = "Dried sample chips HS Code lÃ  gÃ¬?";
    const selected = retrievedFixture({
      document: "Chapter12.pdf",
      hsCode: "1211.90.95",
      title: "DRIED SAMPLE CHIPS",
      section: "1211.90.95 - DRIED SAMPLE CHIPS",
      text: "Dried sample chips are resinous pieces."
    });
    const result = handleSelectedSectionQa(query, selected, undefined, [candidateFor(selected, {
      finalScore: 80,
      matchedTerms: ["dried", "sample", "chips"],
      candidateMatchedPhrases: ["dried sample"]
    })], detectIntent(query));

    expect(result.answerMode).toBe("classification");
    expect(result.answer).toBe("Sản phẩm là Dried sample chips, HS Code: 1211.90.95.");
  });

  it("lists HS Codes for broad multi-result lookups instead of forcing one classification", () => {
    const robusta = retrievedFixture({
      document: "Chapter09.pdf",
      hsCode: "0901.11.30",
      title: "ROBUSTA COFFEE",
      section: "0901.11.30 - ROBUSTA COFFEE",
      text: "Robusta coffee beans."
    });
    const arabica = retrievedFixture({
      document: "Chapter09.pdf",
      hsCode: "0901.21.12",
      title: "ARABICA COFFEE",
      section: "0901.21.12 - ARABICA COFFEE",
      text: "Arabica coffee beans."
    });
    const result = handleProductClassification("coffee", robusta, [], undefined, [
      candidateFor(robusta, { finalScore: 70, matchedTerms: ["coffee"], candidateMatchedTokens: ["coffee"] }),
      candidateFor(arabica, { finalScore: 68, matchedTerms: ["coffee"], candidateMatchedTokens: ["coffee"] })
    ], detectIntent("coffee"));

    expect(result.answerMode).toBe("broad_lookup");
    expect(result.answer).toContain("Robusta coffee");
    expect(result.answer).toContain("HS Code: 0901.11.30");
    expect(result.answer).toContain("Arabica coffee");
    expect(result.answer).toContain("HS Code: 0901.21.12");
    expect(result.answer).not.toContain("Sản phẩm là");
  });

  it("answers non-HS field questions without appending a related code", () => {
    const selected = retrievedFixture({
      document: "Chapter03.pdf",
      hsCode: "0301.99.10",
      title: "BREEDING SAMPLE",
      section: "0301.99.10 - BREEDING SAMPLE",
      text: "Appearance: the body is balanced and fins are normal.",
      score: 80
    });
    const result = handleSelectedSectionQa(
      "Breeding sample appearance requirements?",
      selected,
      "Breeding sample requires a balanced body and normal fins.",
      [candidateFor(selected, { finalScore: 80, matchedTerms: ["breeding", "sample"] })],
      detectIntent("Breeding sample appearance requirements?")
    );

    expect(result.answerMode).toBe("selected_section_qa");
    expect(result.answer).toContain("balanced body");
    expect(result.answer).not.toContain("liên quan");
    expect(result.answer).not.toContain("0301.99.10");
    expect(result.answer).not.toContain("HS Code");
    expect(result.answer).not.toContain("Sản phẩm là");
  });

  it("strips HS Code from non-HS selected-section answers when text already mentioned it", () => {
    const selected = retrievedFixture({
      document: "Chapter03.pdf",
      hsCode: "0301.99.10",
      title: "BREEDING SAMPLE",
      section: "0301.99.10 - BREEDING SAMPLE",
      text: "Appearance: the body is balanced and fins are normal.",
      score: 80
    });
    const result = handleSelectedSectionQa(
      "Breeding sample appearance requirements?",
      selected,
      "Breeding sample requires a balanced body and normal fins. HS Code: 0301.99.10.",
      [candidateFor(selected, { finalScore: 80, matchedTerms: ["breeding", "sample"] })],
      detectIntent("Breeding sample appearance requirements?")
    );

    const codeMentions = result.answer.match(/0301\.99\.10/g) ?? [];
    expect(result.answer).toContain("balanced body");
    expect(result.answer).not.toContain("liên quan");
    expect(result.answer).not.toContain("HS Code:");
    expect(codeMentions).toHaveLength(0);
  });

  it("keeps selected-section answers free of debug metadata", () => {
    const selected = retrievedFixture({
      document: "Chapter77.pdf",
      hsCode: "7701.00.00",
      title: "SAMPLE MATERIAL",
      section: "7701.00.00 - SAMPLE MATERIAL",
      text: "Usage: used for demonstration.",
      score: 80
    });
    const result = handleSelectedSectionQa(
      "Sample material dÃ¹ng Ä‘á»ƒ lÃ m gÃ¬?",
      selected,
      "Sample material Ä‘Æ°á»£c dÃ¹ng Ä‘á»ƒ demonstration. Index source: cached tree. PageIndex logs: ok.",
      [candidateFor(selected, { finalScore: 80, matchedTerms: ["sample", "material"] })],
      detectIntent("Sample material dÃ¹ng Ä‘á»ƒ lÃ m gÃ¬?")
    );

    expect(result.answer).toContain("demonstration");
    expect(result.answer).not.toMatch(/Index source|PageIndex|cache freshness|final score|candidate debug/i);
  });

  it("answers definition questions with the definition first and HS Code attached", () => {
    const query = "What is Oxen?";
    const selected = retrievedFixture({
      document: "Chapter01.pdf",
      hsCode: "0102.29.11",
      title: "OXEN",
      section: "0102.29.11 - OXEN",
      text: "Oxen are castrated adult male bovine animals. They are used as draft animals."
    });
    const detection = detectIntent(query);
    const result = handleDefinition(query, selected, [
      candidateFor(selected, { finalScore: 80, matchedTerms: ["oxen"], candidateMatchedPhrases: ["what oxen"] })
    ], detection);

    expect(detection.intent).toBe("definition");
    expect(result.intent).toBe("definition");
    expect(result.selectedPrimary?.hsCode).toBe("0102.29.11");
    expect(result.answer).toBe("Oxen are castrated adult male bovine animals. HS Code: 0102.29.11.");
    expect(result.answer).not.toMatch(/Index source|PageIndex|cache freshness|final score|candidate debug/i);
  });

  it("uses local field extraction for selected-section QA when LLM answer is unavailable", () => {
    const selected = retrievedFixture({
      document: "Chapter03.pdf",
      hsCode: "0301.99.10",
      title: "BREEDING SAMPLE",
      section: "0301.99.10 - BREEDING SAMPLE",
      text: "Appearance: the body is balanced and fins are normal.",
      score: 80
    });
    const result = handleSelectedSectionQa(
      "Breeding sample appearance requirements?",
      selected,
      undefined,
      [candidateFor(selected, { finalScore: 80, matchedTerms: ["breeding", "sample"] })],
      detectIntent("Breeding sample appearance requirements?")
    );

    expect(result.answer).toContain("Appearance: the body is balanced and fins are normal.");
    expect(result.debug.answerGeneration).toBe("extractive-field");
    expect(result.answer).not.toContain("Sản phẩm là");
    expect(result.answer).not.toContain("HS Code");
  });

  it("summarizes chapter 2 dynamically without selecting a product section", () => {
    const query = "chapter 2 summary";
    const result = handleChapterSummary(query, sections, documents, detectIntent(query));

    expect(result.intent).toBe("chapter_summary");
    expect(result.documentSummary?.document).toBe("Chapter02.pdf");
    expect(result.selectedPrimary).toBeNull();
    expect(result.citations).toEqual([]);
    expect(result.answer).toContain("Chapter 2 gồm các nội dung chính:");
    expect(result.answer).toContain("0207.14.10");
  });

  it("routes structurally clear chapter summary phrasing to chapter_summary", () => {
    const queries = [
      "chapter 10 contents",
      "chapter 10 summary",
      "chapter 10 about"
    ];

    for (const query of queries) {
      const detection = detectIntent(query);
      const result = handleChapterSummary(query, sections, documents, detection);

      expect(detection.intent).toBe("chapter_summary");
      expect(detection.chapterNumber).toBe(10);
      expect(result.intent).toBe("chapter_summary");
      expect(result.selectedPrimary).toBeNull();
      expect(result.documentSummary?.document).toBe("Tariff_chapter-10.pdf");
      expect(result.answer).toContain("Chapter 10 gồm các nội dung chính:");
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
    const query = "document Introduction summary";
    const result = handleDocumentSummary(query, sections, documents, detectIntent(query));

    expect(result.intent).toBe("document_summary");
    expect(result.documentSummary?.document).toBe("Introduction.pdf");
    expect(result.documentSummary?.isReference).toBe(true);
    expect(result.answer).toContain("tài liệu tham chiếu");
  });

  it("does not carry product selection into a following chapter summary", () => {
    const product = handleProductClassification(
      "Oxen HS Code classification",
      retrievedFixture({
        document: "Chapter01.pdf",
        hsCode: "0102.29.11",
        title: "OXEN",
        section: "0102.29.11 - OXEN",
        text: "Oxen are castrated adult male bovine animals."
      }),
      [],
      undefined,
      [candidateFor(retrievedFixture({ hsCode: "0102.29.11", title: "OXEN", section: "0102.29.11 - OXEN", text: "Oxen are castrated adult male bovine animals.", document: "Chapter01.pdf", score: 80 }), { finalScore: 80, matchedTerms: ["oxen"], candidateMatchedPhrases: ["oxen"] })],
      detectIntent("Oxen HS Code?")
    );
    const summary = handleChapterSummary("chapter 2 summary", sections, documents, detectIntent("chapter 2 summary"));

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
    expect(result.answer).not.toContain("Sản phẩm là");
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
    expect(result.answer).not.toContain("Sản phẩm là");
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

  it("does not classify candidates that only match weak expansion terms", () => {
    const query = "phan loai hang hoa nhap khau dac biet";
    const selected = retrievedFixture({
      document: "Chapter03.pdf",
      hsCode: "0301.99.10",
      title: "FISH",
      section: "0301.99.10 - FISH",
      text: "Fish.",
      score: 90
    });
    const result = handleProductClassification(query, selected, [], undefined, [candidateFor(selected, {
      finalScore: 90,
      relevanceScore: 90,
      matchedTerms: ["fish"],
      matchedOriginalTerms: [],
      matchedExpansionTerms: ["fish"],
      candidateMatchedTokens: ["fish"],
      candidateMatchedPhrases: [],
      matchedPhrases: [],
      expansionConfidence: "low"
    })], detectIntent(query));

    expect(result.answerMode).not.toBe("classification");
    expect(result.answerConfidence).toBe("low");
    expect(result.debug.confidenceReason).toContain("weak query expansion");
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
    expect(result.answer).toContain("HS Code: 0102.29.11");
  });

  it("keeps chapter summary deterministic without product selectedPrimary", () => {
    const result = handleChapterSummary("chapter 2 noi dung", sections, documents, detectIntent("chapter 2 noi dung"));

    expect(result.answerMode).toBe("chapter_summary");
    expect(result.selectedPrimary).toBeNull();
    expect(result.answer).not.toContain("Sản phẩm là");
  });

  it("selected section QA asks clarification when candidate relevance is rejected", () => {
    const selected = retrievedFixture({
      document: "Chapter01.pdf",
      hsCode: "0102.29.11",
      title: "OXEN",
      section: "0102.29.11 - OXEN",
      text: "Oxen are castrated adult male bovine animals.",
      score: 1
    });
    const result = handleSelectedSectionQa("What is it?", selected, undefined, [candidateFor(selected, {
      finalScore: 1,
      rejected: true,
      rejectedReason: "candidate has low generic token, phrase, and numeric overlap with query"
    })], detectIntent("What is it?"));

    expect(result.answerMode).toBe("clarification");
    expect(result.answer).toContain("There is not enough information");
  });

  it("answers Vietnamese section attribute questions from LLM text without forcing HS Code", () => {
    const selected = retrievedFixture({
      document: "Chapter03.pdf",
      hsCode: "0301.99.10",
      title: "BREEDING FISH",
      section: "0301.99.10 - BREEDING FISH",
      text: [
        "General requirements on appearance:",
        "The fish body is balanced, without deformities, fins are complete and normal, and there are no visible wounds.",
        "Uniform size, no signs of disease, and certified as suitable for breeding."
      ].join("\n"),
      score: 60
    });
    const result = handleSelectedSectionQa(
      "Breeding fish cáº§n Ä‘Ã¡p á»©ng yÃªu cáº§u ngoáº¡i quan nÃ o?",
      selected,
      "Breeding fish cáº§n cÃ³ thÃ¢n cÃ¢n Ä‘á»‘i, khÃ´ng dá»‹ táº­t, vÃ¢y Ä‘áº§y Ä‘á»§ vÃ  bÃ¬nh thÆ°á»ng, khÃ´ng cÃ³ váº¿t thÆ°Æ¡ng nhÃ¬n tháº¥y, kÃ­ch thÆ°á»›c Ä‘á»“ng Ä‘á»u vÃ  khÃ´ng cÃ³ dáº¥u hiá»‡u bá»‡nh.",
      [candidateFor(selected, { finalScore: 80, matchedTerms: ["breeding", "fish"], candidateMatchedPhrases: ["breeding fish"] })],
      detectIntent("Breeding fish cáº§n Ä‘Ã¡p á»©ng yÃªu cáº§u ngoáº¡i quan nÃ o?")
    );

    expect(result.intent).toBe("selected_section_qa");
    expect(result.answerMode).toBe("selected_section_qa");
    expect(result.answer).toContain("Breeding fish cáº§n cÃ³ thÃ¢n cÃ¢n Ä‘á»‘i");
    expect(result.answer).toContain("khÃ´ng dá»‹ táº­t");
    expect(result.answer).toContain("vÃ¢y");
    expect(result.answer).toContain("dáº¥u hiá»‡u");
    expect(result.answer).not.toContain("HS Code");
    expect(result.answer).not.toContain("Sản phẩm là");
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
