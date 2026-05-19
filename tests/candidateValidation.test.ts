import { describe, expect, it } from "vitest";
import {
  evaluateCandidateRelevance,
  extractQuerySignals,
  selectRelevantSections,
  validateCandidateForQuery,
  type CandidateRelevance,
  type EnrichedRetrievedSection
} from "../src/agent/qaAnswerFormatter";

describe("candidate validation", () => {
  it("accepts an exact HS code match inside scope", () => {
    const query = "lookup 9999.88.77";
    const candidate = sectionFixture({
      document: "Allowed.pdf",
      hsCode: "9999.88.77",
      title: "REFERENCE MATERIAL",
      section: "9999.88.77 - REFERENCE MATERIAL"
    });

    const validation = validateCandidateForQuery({
      originalQuery: query,
      candidate,
      querySignals: extractQuerySignals(query),
      scope: { mode: "selected", allowedDocuments: ["Allowed.pdf"] }
    });

    expect(validation.accepted).toBe(true);
    expect(validation.confidence).toBe("high");
    expect(validation.strongSignals).toContain("exact_hscode_match");
  });

  it("rejects candidates outside selected scope", () => {
    const query = "carbon fiber sheet";
    const candidate = sectionFixture({
      document: "Outside.pdf",
      title: "CARBON FIBER SHEETS",
      section: "1111.11.11 - CARBON FIBER SHEETS",
      text: "Carbon fiber sheets."
    });

    const validation = validateCandidateForQuery({
      originalQuery: query,
      candidate,
      querySignals: extractQuerySignals(query),
      scope: { mode: "selected", allowedDocuments: ["Allowed.pdf"] }
    });

    expect(validation.accepted).toBe(false);
    expect(validation.reason).toContain("outside selected scope");
  });

  it("does not confidently accept weak-only broad token matches", () => {
    const query = "content";
    const candidate = sectionFixture({
      title: "GENERAL CONTENT",
      section: "1111.11.11 - GENERAL CONTENT",
      text: "Document content summary."
    });

    const validation = validateCandidateForQuery({
      originalQuery: query,
      candidate: {
        ...candidate,
        relevance: evaluateCandidateRelevance(candidate, query)
      },
      querySignals: extractQuerySignals(query)
    });

    expect(validation.confidence).toBe("low");
    expect(validation.accepted).toBe(false);
    expect(validation.weakSignals.length).toBeGreaterThan(0);
  });

  it("accepts candidates with a title phrase match", () => {
    const query = "carbon fiber sheets requirements";
    const candidate = sectionFixture({
      title: "CARBON FIBER SHEETS",
      section: "1111.11.11 - CARBON FIBER SHEETS",
      text: "Carbon fiber sheets must be layered sheets used as reinforcement."
    });

    const validation = validateCandidateForQuery({
      originalQuery: query,
      candidate: {
        ...candidate,
        relevance: evaluateCandidateRelevance(candidate, query)
      },
      querySignals: extractQuerySignals(query)
    });

    expect(validation.accepted).toBe(true);
    expect(validation.confidence).not.toBe("low");
    expect(validation.strongSignals).toContain("exact_or_near_exact_title_phrase_match");
  });

  it("accepts country/product alias matches as strong evidence", () => {
    const query = "Cambodia premium fragrant rice HS Code?";
    const candidate = sectionFixture({
      document: "Chapter10.pdf",
      hsCode: "1006.30.60",
      title: "MALYS RICE",
      section: "1006.30.60 - MALYS RICE",
      text: "Malys rice, also known as Malys Angkor rice, refers to premium aromatic rice with extra-long kernels."
    });
    const relevance = evaluateCandidateRelevance(candidate, query);

    const validation = validateCandidateForQuery({
      originalQuery: query,
      candidate: {
        ...candidate,
        relevance
      },
      querySignals: extractQuerySignals(query)
    });

    expect(relevance.candidateAliasSignals).toContain("malys rice");
    expect(validation.accepted).toBe(true);
    expect(validation.strongSignals).toContain("country_product_alias_match");
  });

  it("requires product or attribute evidence with numeric matches", () => {
    const numericOnlyQuery = "12%";
    const numericOnlyCandidate = sectionFixture({
      title: "GENERAL MATERIAL",
      section: "1111.11.11 - GENERAL MATERIAL",
      text: "Moisture content: 12%."
    });

    const numericOnlyValidation = validateCandidateForQuery({
      originalQuery: numericOnlyQuery,
      candidate: {
        ...numericOnlyCandidate,
        relevance: evaluateCandidateRelevance(numericOnlyCandidate, numericOnlyQuery)
      },
      querySignals: extractQuerySignals(numericOnlyQuery)
    });

    expect(numericOnlyValidation.accepted).toBe(false);
    expect(numericOnlyValidation.reason).toContain("numeric evidence");

    const supportedQuery = "polymer resin moisture 12%";
    const supportedCandidate = sectionFixture({
      title: "POLYMER RESIN",
      section: "2222.22.22 - POLYMER RESIN",
      text: "Polymer resin has moisture content of 12%."
    });
    const supportedValidation = validateCandidateForQuery({
      originalQuery: supportedQuery,
      candidate: {
        ...supportedCandidate,
        relevance: evaluateCandidateRelevance(supportedCandidate, supportedQuery)
      },
      querySignals: extractQuerySignals(supportedQuery)
    });

    expect(supportedValidation.accepted).toBe(true);
    expect(supportedValidation.strongSignals).toContain("numeric_unit_match_plus_product_or_attribute_evidence");
  });

  it("downgrades expansion-only matches unless supported by candidate text", () => {
    const originalQuery = "vat lieu dac biet";
    const candidate = sectionFixture({
      title: "POLYMER RESIN",
      section: "2222.22.22 - POLYMER RESIN",
      text: "Polymer resin pellets."
    });
    const weakExpansionValidation = validateCandidateForQuery({
      originalQuery,
      expandedQuery: `${originalQuery}\npolymer`,
      candidate: {
        ...candidate,
        relevance: relevanceFixture(candidate, {
          matchedTerms: ["polymer"],
          candidateMatchedTokens: ["polymer"],
          matchedOriginalTerms: [],
          matchedExpansionTerms: ["polymer"],
          expansionConfidence: "low",
          finalScore: 80,
          relevanceScore: 80
        })
      },
      querySignals: extractQuerySignals(originalQuery)
    });

    expect(weakExpansionValidation.accepted).toBe(false);
    expect(weakExpansionValidation.confidence).toBe("low");
    expect(weakExpansionValidation.weakSignals).toContain("expansion_only_match");

    const supportedExpansionValidation = validateCandidateForQuery({
      originalQuery,
      expandedQuery: `${originalQuery}\npolymer resin`,
      candidate: {
        ...candidate,
        relevance: relevanceFixture(candidate, {
          matchedTerms: ["polymer", "resin"],
          candidateMatchedTokens: ["polymer", "resin"],
          candidateMatchedPhrases: ["polymer resin"],
          matchedPhrases: ["polymer resin"],
          matchedOriginalTerms: [],
          matchedExpansionTerms: ["polymer resin"],
          expansionConfidence: "high",
          finalScore: 80,
          relevanceScore: 80
        })
      },
      querySignals: extractQuerySignals(originalQuery)
    });

    expect(supportedExpansionValidation.accepted).toBe(true);
    expect(supportedExpansionValidation.confidence).toBe("medium");
    expect(supportedExpansionValidation.strongSignals).toContain("expansion_phrase_supported_by_candidate_text");
  });

  it("keeps broad single-token matches low confidence for broad lookup instead of selecting one confidently", () => {
    const first = sectionFixture({
      document: "A.pdf",
      title: "ALPHA MATERIAL",
      section: "1111.11.11 - ALPHA MATERIAL",
      text: "Alpha material."
    });
    const second = sectionFixture({
      document: "B.pdf",
      title: "BETA MATERIAL",
      section: "2222.22.22 - BETA MATERIAL",
      text: "Beta material."
    });

    const selection = selectRelevantSections([first, second], "material", { requireHsMetadata: true });
    const accepted = selection.candidates.filter((candidate) => candidate.validation?.accepted);

    expect(accepted).toHaveLength(2);
    expect(accepted.every((candidate) => candidate.validation?.confidence === "low")).toBe(true);
    expect(selection.ranked[0]?.score).toBeDefined();
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

function relevanceFixture(
  section: EnrichedRetrievedSection,
  overrides: Partial<CandidateRelevance>
): CandidateRelevance {
  return {
    ...evaluateCandidateRelevance(section, "placeholder"),
    rejected: false,
    rejectedReason: null,
    ...overrides
  };
}
