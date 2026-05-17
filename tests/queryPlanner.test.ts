import { describe, expect, it } from "vitest";
import {
  buildQueryPlannerPrompt,
  planQuery,
  planQueryWithFallback,
  planQueryWithRules
} from "../src/agent/queryPlanner";

describe("queryPlanner", () => {
  it("plans flexible section attribute phrasings through the LLM planner", async () => {
    const queries = [
      "Sample seed lot cần đáp ứng yêu cầu ngoại quan nào?",
      "Cho biết phần appearance của sample seed lot"
    ];

    for (const query of queries) {
      const result = await planQuery(query, {
        llmPlanner: {
          async planQuery(prompt) {
            expect(prompt).toContain("Do not answer the question");
            return JSON.stringify({
              intent: "section_attribute_question",
              target: "sample seed lot",
              requestedField: "appearance requirements",
              needsHsCode: false,
              language: "mixed",
              confidence: "high",
              reason: "asks for an appearance field inside a section"
            });
          }
        }
      });

      expect(result.plannerSource).toBe("llm");
      expect(result.queryPlan.intent).toBe("section_attribute_question");
      expect(result.queryPlan.target).toBe("sample seed lot");
      expect(result.queryPlan.requestedField).toBe("appearance requirements");
      expect(result.queryPlan.needsHsCode).toBe(false);
    }
  });

  it("plans descriptive HS code questions as product classification through planner", async () => {
    const result = await planQuery("Dried synthetic sample flakes used in lab calibration belong to which HS code?", {
      llmPlanner: {
        async planQuery() {
          return JSON.stringify({
            intent: "product_classification",
            target: "Dried synthetic sample flakes used in lab calibration",
            requestedField: null,
            needsHsCode: true,
            language: "en",
            confidence: "high",
            reason: "asks for HS code classification of a product description"
          });
        }
      }
    });

    expect(result.plannerSource).toBe("llm");
    expect(result.queryPlan.intent).toBe("product_classification");
    expect(result.queryPlan.needsHsCode).toBe(true);
  });

  it("keeps exact HS code lookup deterministic", () => {
    const plan = planQueryWithRules("Tra HS Code 9999.88.77");

    expect(plan?.intent).toBe("exact_hscode_lookup");
    expect(plan?.target).toBe("9999.88.77");
    expect(plan?.needsHsCode).toBe(true);
  });

  it("keeps chapter summaries deterministic", () => {
    const plan = planQueryWithRules("chapter 37 nói về cái gì?");

    expect(plan?.intent).toBe("chapter_summary");
    expect(plan?.target).toBe("chapter 37");
    expect(plan?.confidence).toBe("high");
  });

  it("does not treat natural definition phrasing as deterministic rule routing", () => {
    const plan = planQueryWithRules("Sample seed lot là gì?");

    expect(plan).toBeNull();
  });

  it("uses LLM output only as planner JSON", async () => {
    let prompt = "";
    const result = await planQuery("Which field applies?", {
      llmPlanner: {
        async planQuery(value) {
          prompt = value;
          return JSON.stringify({
            intent: "section_attribute_question",
            target: "sample product",
            requestedField: "usage",
            needsHsCode: false,
            language: "en",
            confidence: "medium",
            reason: "asks for a section field"
          });
        }
      }
    });

    expect(prompt).toContain("Do not answer the question");
    expect(prompt).toContain("Return only JSON");
    expect(result.plannerSource).toBe("llm");
    expect(result.queryPlan.intent).toBe("section_attribute_question");
    expect(result.queryPlan.requestedField).toBe("usage");
  });

  it("keeps numeric-only fallback out of product classification", () => {
    const plan = planQueryWithFallback("0.8");

    expect(plan.intent).toBe("clarification_needed");
    expect(plan.confidence).toBe("low");
  });

  it("uses selected-section fallback when LLM planner is unavailable", async () => {
    const result = await planQuery("thing", {
      llmPlanner: {
        async planQuery() {
          throw new Error("planner unavailable");
        }
      }
    });

    expect(result.plannerSource).toBe("fallback");
    expect(result.queryPlan.intent).toBe("selected_section_qa");
    expect(result.queryPlan.confidence).toBe("low");
  });

  it("uses selected-section fallback for natural-language field questions", () => {
    const plan = planQueryWithFallback("Breeding fish appearance requirements?");

    expect(plan.intent).toBe("selected_section_qa");
    expect(plan.requestedField).toBeNull();
    expect(plan.needsHsCode).toBe(false);
  });

  it("exposes the planner prompt contract", () => {
    const prompt = buildQueryPlannerPrompt("Sample seed lot HS Code là gì?");

    expect(prompt).toContain("Classify the user's question into a structured JSON plan");
    expect(prompt).toContain("Do not invent HS codes");
    expect(prompt).toContain("Return only JSON");
    expect(prompt).toContain("Return exactly this JSON shape");
    expect(prompt).toContain('"needsHsCode": true');
    expect(prompt).toContain("Do not include any explanation outside JSON");
  });
});
