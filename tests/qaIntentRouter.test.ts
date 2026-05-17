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
    }
  ];

  const documents: QaDocumentMetadata[] = [
    { document: "Chapter01.pdf", input: "data/uploads/Chapter01.pdf" },
    { document: "Chapter02.pdf", input: "data/uploads/Chapter02.pdf" },
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
    expect(result.answer).toContain("Chapter 2 gồm các nội dung chính:");
    expect(result.answer).toContain("0207.14.10");
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
