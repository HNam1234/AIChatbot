import { describe, expect, it } from "vitest";
import { generateLocalAnswer, type AnswerPolicy } from "../src/agent/localAnswerGenerator";
import {
  extractQuerySignals,
  type EnrichedRetrievedSection,
  type ValidatedCandidate
} from "../src/agent/qaAnswerFormatter";

describe("local answer generator", () => {
  it("answers classification questions from selected candidate metadata", () => {
    const query = "Dried sample chips HS Code là gì?";
    const candidate = validatedFixture({
      document: "Chapter12.pdf",
      hsCode: "1211.90.95",
      title: "DRIED SAMPLE CHIPS",
      section: "1211.90.95 - DRIED SAMPLE CHIPS"
    });

    const result = localAnswer(query, candidate, "Dried sample chips are resinous pieces.", {
      classificationRequested: true
    });

    expect(result.answerGeneration).toBe("template-classification");
    expect(result.answer).toBe("Sản phẩm là Dried sample chips, HS Code: 1211.90.95.");
  });

  it("extracts definition text and appends HS Code when evidence exists", () => {
    const query = "What is Oxen?";
    const candidate = validatedFixture({
      document: "Chapter01.pdf",
      hsCode: "0102.29.11",
      title: "OXEN",
      section: "0102.29.11 - OXEN"
    });

    const result = localAnswer(query, candidate, [
      "0102.29.11 - OXEN",
      "Source: internal index",
      "Oxen are castrated adult male bovine animals."
    ].join("\n"), {
      definitionRequested: true
    });

    expect(result.answerGeneration).toBe("extractive-definition");
    expect(result.answer).toBe("Oxen are castrated adult male bovine animals. HS Code: 0102.29.11.");
  });

  it("extracts field evidence without forcing classification wording", () => {
    const query = "Breeding sample appearance requirements?";
    const candidate = validatedFixture({
      document: "Chapter03.pdf",
      hsCode: "0301.99.10",
      title: "BREEDING SAMPLE",
      section: "0301.99.10 - BREEDING SAMPLE"
    });

    const result = localAnswer(query, candidate, [
      "General notes: keep records available.",
      "Appearance requirements:",
      "- the body is balanced and fins are normal.",
      "Usage: breeding stock."
    ].join("\n"), {
      requestedField: "appearance requirements",
      allowRelatedHsCode: true
    });

    expect(result.answerGeneration).toBe("extractive-field");
    expect(result.answer).toContain("body is balanced");
    expect(result.answer).not.toContain("Sản phẩm là");
    expect(result.answer).not.toContain("HS Code:");
  });

  it("extracts following bullet under matched Activeness heading", () => {
    const query = "Activeness?";
    const candidate = validatedFixture({
      document: "Chapter03.pdf",
      hsCode: "0301.99.10",
      title: "BREEDING SAMPLE",
      section: "0301.99.10 - BREEDING SAMPLE"
    });

    const result = localAnswer(query, candidate, [
      "Activeness",
      "- The fish swim actively and respond normally to movement.",
      "",
      "Weight and size",
      "- Uniform size."
    ].join("\n"), {
      requestedField: "activeness",
      allowRelatedHsCode: false
    });

    expect(result.answerGeneration).toBe("extractive-field");
    expect(result.confidence).not.toBe("low");
    expect(result.answer).toContain("swim actively");
    expect(result.answer).not.toContain("Uniform size");
  });

  it("answers mixed-language activeness questions from the exact requested field", () => {
    const query = "Breeding fish co yeu cau activeness the nao?";
    const candidate = validatedFixture({
      document: "Chapter03.pdf",
      hsCode: "0301.99.10",
      title: "BREEDING FISH",
      section: "0301.99.10 - BREEDING FISH"
    });

    const result = localAnswer(query, candidate, [
      "Breeding fish are accompanied by certification from the competent authorities.",
      "General requirements on appearance: Well-proportioned body, no deformity, normal fins. Activeness: Fish should be active, swift, swimming under the water in groups. Weight and size: Depends on each species and hatchery time.",
      "This partial document outlines the classification and requirements for various breeding fish species."
    ].join("\n"), {
      requestedField: "activeness",
      allowRelatedHsCode: true
    });

    expect(result.answerGeneration).toBe("extractive-field");
    expect(result.answer).toContain("Fish should be active, swift");
    expect(result.answer).not.toContain("Weight and size");
    expect(result.answer).not.toContain("Mã liên quan");
    expect(result.answer).not.toContain("HS Code");
  });

  it("answers flattened table comparisons with numeric evidence", () => {
    const query = "Which coconut water has higher reducing sugars: mature or tender/young?";
    const candidate = validatedFixture({
      document: "Chapter08.pdf",
      hsCode: "0801.19.10",
      title: "YOUNG COCONUT",
      section: "0801.19.10 - YOUNG COCONUT"
    });
    const text = [
      "Mature Coconut Water Tender/young Coconut",
      "Water Total solids% 5.4 6.5 Reducing sugars % 0.2 4.4 Minerals % 0.5 0.6",
      "Table 1. Approximate Analysis of Mature and tender/young Coconut Water"
    ].join("\n");

    const result = localAnswer(query, candidate, text, {
      allowRelatedHsCode: true
    });

    expect(result.answerGeneration).toBe("extractive-field");
    expect(result.confidence).toBe("high");
    expect(result.answer).toContain("Tender/young coconut water");
    expect(result.answer).toContain("4.4%");
    expect(result.answer).toContain("mature coconut water");
    expect(result.answer).toContain("0.2%");
    expect(result.answer).not.toContain("Mã liên quan");
    expect(result.answer).not.toContain("HS Code");
  });

  it("can answer lower-value table comparisons from the same flattened row", () => {
    const query = "Which coconut water has lower reducing sugars: mature or tender/young?";
    const candidate = validatedFixture({
      document: "Chapter08.pdf",
      hsCode: "0801.19.10",
      title: "YOUNG COCONUT",
      section: "0801.19.10 - YOUNG COCONUT"
    });

    const result = localAnswer(query, candidate, [
      "Mature Coconut Water Tender/young Coconut",
      "Water Total solids% 5.4 6.5 Reducing sugars % 0.2 4.4"
    ].join("\n"), {
      allowRelatedHsCode: true
    });

    expect(result.answer).toContain("Mature coconut water");
    expect(result.answer).toContain("0.2%");
    expect(result.answer).toContain("4.4%");
  });

  it("keeps safe-fallback local result low confidence", () => {
    const query = "Sample material warranty handling details?";
    const candidate = validatedFixture({
      document: "Chapter77.pdf",
      hsCode: "7701.00.00",
      title: "SAMPLE MATERIAL",
      section: "7701.00.00 - SAMPLE MATERIAL"
    });

    const result = localAnswer(query, candidate, "Usage: used for laboratory demonstrations.", {
      requestedField: "warranty handling"
    });

    expect(result.answerGeneration).toBe("safe-fallback");
    expect(result.confidence).toBe("low");
    expect(result.answer).toBeNull();
  });

  it("formats grouped HS codes without duplicate code sentences", () => {
    const query = "Mechanically deboned meat HS Code?";
    const candidate = validatedFixture({
      document: "Chapter02.pdf",
      hsCode: "0207.14.10",
      groupedHsCodes: ["0207.14.10", "0207.27.10", "0207.45.10"],
      title: "MECHANICALLY DEBONED MEAT",
      section: "0207.14.10 - MECHANICALLY DEBONED MEAT"
    });

    const result = localAnswer(query, candidate, "Mechanically deboned meat.", {
      classificationRequested: true
    });

    expect(result.answer).toContain("0207.14.10, 0207.27.10 or 0207.45.10");
    expect(result.answer).toContain("depending on the product state in the tariff");
    expect(result.answer?.match(/HS Code:/g)).toHaveLength(1);
  });

  it("returns local answers when LLM is disabled by policy", () => {
    const query = "Sample material usage?";
    const candidate = validatedFixture({
      document: "Chapter77.pdf",
      hsCode: "7701.00.00",
      title: "SAMPLE MATERIAL",
      section: "7701.00.00 - SAMPLE MATERIAL"
    });

    const result = localAnswer(query, candidate, "Usage: used for laboratory demonstrations.", {
      requestedField: "usage",
      allowRelatedHsCode: false
    });

    expect(result.answerGeneration).toBe("extractive-field");
    expect(result.answer).toBe("Usage: used for laboratory demonstrations.");
  });

  it("returns null so optional LLM fallback can handle weak local evidence", () => {
    const query = "Sample material warranty handling details?";
    const candidate = validatedFixture({
      document: "Chapter77.pdf",
      hsCode: "7701.00.00",
      title: "SAMPLE MATERIAL",
      section: "7701.00.00 - SAMPLE MATERIAL"
    });

    const result = localAnswer(query, candidate, "Usage: used for laboratory demonstrations.", {
      requestedField: "warranty handling"
    });

    expect(result.answer).toBeNull();
    expect(result.confidence).toBe("low");
  });

  it("does not leak debug labels into final local answers", () => {
    const query = "Sample material usage?";
    const candidate = validatedFixture({
      document: "Chapter77.pdf",
      hsCode: "7701.00.00",
      title: "SAMPLE MATERIAL",
      section: "7701.00.00 - SAMPLE MATERIAL"
    });

    const result = localAnswer(
      query,
      candidate,
      "Usage: used for demonstration. Index source: cached tree. PageIndex logs: ok.",
      { requestedField: "usage", allowRelatedHsCode: false }
    );

    expect(result.answer).toContain("demonstration");
    expect(result.answer).not.toMatch(/Index source|PageIndex|cache status|candidate debug|raw JSON/i);
  });
});

function localAnswer(
  query: string,
  candidate: ValidatedCandidate,
  selectedSectionText: string,
  answerPolicy: AnswerPolicy
) {
  return generateLocalAnswer({
    originalQuery: query,
    selectedCandidate: candidate,
    selectedSectionText,
    querySignals: extractQuerySignals(query),
    answerPolicy
  });
}

function validatedFixture(overrides: Partial<EnrichedRetrievedSection>): ValidatedCandidate {
  return {
    document: "Chapter99.pdf",
    title: "SAMPLE",
    section: "9999.99.99 - SAMPLE",
    text: "",
    captions: [],
    score: 80,
    metadataWarnings: [],
    ...overrides,
    groupedHsCodes: overrides.groupedHsCodes ?? [],
    validation: {
      accepted: true,
      confidence: "high",
      reason: "mock validation",
      strongSignals: ["mock_strong_signal"],
      weakSignals: [],
      missingEvidence: []
    }
  };
}
