import { describe, expect, it } from "vitest";
import { SectionMapBuilder } from "../src/orchestrator/sectionMapBuilder";
import type { ParsedBlock } from "../src/types";

describe("SectionMapBuilder", () => {
  it("builds citation section map records from Markdown and layout blocks", () => {
    const markdown = [
      "# CHAPTER 12",
      "",
      "## 1211.90.95 — AGARWOOD (GAHARU) CHIPS",
      "",
      "Agarwood, also known as oud, is a dark resinous heartwood.",
      "",
      "(Source: Malaysia)",
      "",
      "## 1212.21.11 — EUCHEUMA SPINOSUM",
      "",
      "Seaweed section text."
    ].join("\n");
    const blocks: ParsedBlock[] = [
      textBlock("hs-1", 56, 10, "1211.90.95\nAGARWOOD (GAHARU) CHIPS"),
      textBlock("body-1", 57, 11, "Agarwood, also known as oud."),
      textBlock("hs-2", 58, 12, "1212.21.11\nEUCHEUMA SPINOSUM")
    ];

    const result = SectionMapBuilder.build(markdown, blocks, "Chapter12.pdf");

    expect(result.sections).toHaveLength(2);
    expect(result.sections[0]).toMatchObject({
      document: "Chapter12.pdf",
      chapter: "CHAPTER 12",
      hsCode: "1211.90.95",
      title: "AGARWOOD (GAHARU) CHIPS",
      pageStart: 56,
      pageEnd: 57,
      source: "Malaysia"
    });
    expect(result.sections[0]?.textPreview).toContain("Agarwood");
  });

  it("classifies documents without HS sections as non-HS references", () => {
    const result = SectionMapBuilder.build(
      ["# Introduction", "", "General reference material."].join("\n"),
      [textBlock("intro", 1, 10, "General reference material.")],
      "Introduction.pdf"
    );

    expect(result.documentType).toBe("non-hs-reference");
    expect(result.sections).toHaveLength(0);
    expect(result.warnings).toEqual([]);
  });
});

function textBlock(id: string, pageNumber: number, order: number, text: string): ParsedBlock {
  return {
    id,
    type: "text",
    source: "layout",
    pageNumber,
    order,
    text,
    bbox: { page: pageNumber, x0: 90, y0: order * 10, x1: 520, y1: order * 10 + 20 }
  };
}
