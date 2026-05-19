import { describe, expect, it } from "vitest";
import {
  applyCandidateDocumentScope,
  detectBroadQuery,
  groupDistinctBroadLookupCandidates,
  handleProductClassification,
  sanitizeFinalAnswer
} from "../src/agent/qaIntentRouter";
import {
  evaluateCandidateRelevance,
  extractQuerySignals,
  type CandidateRelevance,
  type EnrichedRetrievedSection,
  type ValidatedCandidate
} from "../src/agent/qaAnswerFormatter";

describe("broad query handling", () => {
  it("returns broad_lookup for a single-token query with multiple valid distinct candidates", () => {
    const first = sectionFixture({ document: "A.pdf", hsCode: "1111.11.11", title: "ALPHA MATERIAL", section: "1111.11.11 - ALPHA MATERIAL" });
    const second = sectionFixture({ document: "B.pdf", hsCode: "2222.22.22", title: "BETA MATERIAL", section: "2222.22.22 - BETA MATERIAL" });
    const candidates = [
      candidateFor(first, "material", { finalScore: 42, matchedTerms: ["material"], candidateMatchedTokens: ["material"] }),
      candidateFor(second, "material", { finalScore: 40, matchedTerms: ["material"], candidateMatchedTokens: ["material"] })
    ];

    const result = handleProductClassification("material", first, [], undefined, candidates);

    expect(result.answerMode).toBe("broad_lookup");
    expect(result.selectedPrimary).toBeNull();
    expect(result.answer).toContain("Tìm thấy nhiều mục liên quan đến 'material':");
    expect(result.answer).toContain("Alpha material");
    expect(result.answer).toContain("Beta material");
    expect(result.answer).not.toContain("Sản phẩm là");
    expect(result.debug.broadQueryDecision).toMatchObject({ isBroad: true, suggestedMode: "broad_lookup" });
  });

  it("does not return confident classification for numeric-only query", () => {
    const section = sectionFixture({
      hsCode: "1111.11.11",
      title: "ALPHA MATERIAL",
      section: "1111.11.11 - ALPHA MATERIAL",
      text: "Moisture: 12%."
    });
    const candidates = [candidateFor(section, "12%", { finalScore: 50, numericMatches: ["12%"], matchedTerms: ["12%"] })];

    const result = handleProductClassification("12%", section, [], undefined, candidates);

    expect(result.answerMode).toBe("clarification");
    expect(result.answerConfidence).toBe("low");
    expect(result.answer).not.toContain("Sản phẩm là");
    expect(result.debug.broadQueryDecision).toMatchObject({ isBroad: true, suggestedMode: "clarification" });
  });

  it("collapses duplicate grouped candidates in broad lookup", () => {
    const section = sectionFixture({
      document: "A.pdf",
      hsCode: "1111.11.11",
      groupedHsCodes: ["1111.11.11", "1111.22.22"],
      title: "GROUPED MATERIAL",
      section: "1111.11.11 - GROUPED MATERIAL"
    });
    const duplicate = { ...section, pageStart: 2 };
    const distinct = sectionFixture({ document: "A.pdf", hsCode: "3333.33.33", title: "OTHER MATERIAL", section: "3333.33.33 - OTHER MATERIAL" });
    const grouped = groupDistinctBroadLookupCandidates([
      candidateFor(section, "material", { finalScore: 50 }),
      candidateFor(duplicate, "material", { finalScore: 45 }),
      candidateFor(distinct, "material", { finalScore: 44 })
    ]);

    expect(grouped).toHaveLength(2);
    expect(grouped.map((candidate) => candidate.title)).toContain("GROUPED MATERIAL");
    expect(grouped.map((candidate) => candidate.title)).toContain("OTHER MATERIAL");
  });

  it("bypasses broad lookup for exact HS code", () => {
    const section = sectionFixture({ hsCode: "1111.11.11", title: "ALPHA MATERIAL", section: "1111.11.11 - ALPHA MATERIAL" });
    const decision = detectBroadQuery({
      originalQuery: "lookup 1111.11.11",
      querySignals: extractQuerySignals("lookup 1111.11.11"),
      validatedCandidates: [validated(section, "lookup 1111.11.11", { strongSignals: ["exact_hscode_match"], confidence: "high" })]
    });

    expect(decision).toMatchObject({ isBroad: false, suggestedMode: "normal" });
  });

  it("bypasses broad lookup for strong phrase match", () => {
    const section = sectionFixture({ hsCode: "1111.11.11", title: "CARBON FIBER SHEETS", section: "1111.11.11 - CARBON FIBER SHEETS" });
    const decision = detectBroadQuery({
      originalQuery: "carbon fiber sheets requirements",
      querySignals: extractQuerySignals("carbon fiber sheets requirements"),
      validatedCandidates: [validated(section, "carbon fiber sheets requirements", {
        strongSignals: ["exact_or_near_exact_title_phrase_match"],
        confidence: "high"
      })]
    });

    expect(decision).toMatchObject({ isBroad: false, suggestedMode: "normal" });
  });

  it("applies selected document scope without global leakage", () => {
    const scoped = applyCandidateDocumentScope([
      candidateFor(sectionFixture({ document: "Allowed.pdf", hsCode: "1111.11.11" }), "material"),
      candidateFor(sectionFixture({ document: "Outside.pdf", hsCode: "2222.22.22" }), "material")
    ], ["Allowed.pdf"]);

    expect(scoped).toHaveLength(1);
    expect(scoped[0].document).toBe("Allowed.pdf");
  });

  it("removes debug labels and duplicate HS Code sentence from final answer", () => {
    const cleaned = sanitizeFinalAnswer(
      "Answer. HS Code: 1111.11.11. HS Code: 1111.11.11. Index source: cached. final score: 99"
    );

    expect(cleaned).toBe("Answer. HS Code: 1111.11.11.");
    expect(cleaned).not.toMatch(/Index source|final score/i);
  });
});

function sectionFixture(overrides: Partial<EnrichedRetrievedSection>): EnrichedRetrievedSection {
  return {
    document: "Chapter.pdf",
    hsCode: "1111.11.11",
    groupedHsCodes: [],
    title: "MATERIAL",
    section: "1111.11.11 - MATERIAL",
    text: "",
    captions: [],
    score: 10,
    metadataWarnings: [],
    ...overrides
  };
}

function candidateFor(section: EnrichedRetrievedSection, query: string, overrides: Partial<CandidateRelevance> = {}): CandidateRelevance {
  return {
    ...evaluateCandidateRelevance(section, query),
    rejected: false,
    rejectedReason: null,
    validation: {
      accepted: true,
      confidence: "low",
      reason: "broad query candidate kept only for broad lookup",
      strongSignals: [],
      weakSignals: ["very_short_query"],
      missingEvidence: []
    },
    ...overrides
  };
}

function validated(
  section: EnrichedRetrievedSection,
  query: string,
  overrides: Partial<ValidatedCandidate["validation"]>
): ValidatedCandidate {
  const relevance = candidateFor(section, query);
  return {
    ...section,
    relevance,
    validation: {
      accepted: true,
      confidence: "medium",
      reason: "candidate accepted",
      strongSignals: [],
      weakSignals: [],
      missingEvidence: [],
      ...overrides
    }
  };
}
