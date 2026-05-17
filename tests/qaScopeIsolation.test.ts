import { describe, expect, it } from "vitest";
import { answerQuestionForEval } from "../src/server/routes";

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
});
