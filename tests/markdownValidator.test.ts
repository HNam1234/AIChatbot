import { describe, expect, it } from "vitest";
import type { ParsedBlock } from "../src/types";
import { MarkdownValidator } from "../src/validators/markdownValidator";

describe("MarkdownValidator", () => {
  it("passes all milestone markers for structured markdown with linked images", () => {
    const markdown = [
      "# HS Code Document",
      "",
      "| Code | Description |",
      "| --- | --- |",
      "| 0101 | Horses |"
    ].join("\n");
    const blocks: ParsedBlock[] = [
      {
        id: "image-1",
        type: "image",
        source: "layout",
        pageNumber: 1,
        order: 1,
        captionLinked: true,
        metadata: {}
      }
    ];

    expect(MarkdownValidator.validatePhase1Detailed(markdown, blocks).passed).toBe(true);
  });

  it("fails marker 1 when headers are missing", () => {
    const report = MarkdownValidator.validatePhase1Detailed("plain text only", []);

    expect(report.passed).toBe(false);
    expect(report.errors[0]).toContain("Marker 1 Failed");
  });

  it("fails marker 2 on inconsistent markdown table columns", () => {
    const markdown = ["# Doc", "", "| A | B |", "| --- | --- |", "| 1 |"].join("\n");
    const report = MarkdownValidator.validatePhase1Detailed(markdown, []);

    expect(report.passed).toBe(false);
    expect(report.errors[0]).toContain("Marker 2 Failed");
  });

  it("fails marker 3 when a non-decorative image is orphaned", () => {
    const blocks: ParsedBlock[] = [
      {
        id: "image-1",
        type: "image",
        source: "layout",
        pageNumber: 1,
        order: 1,
        captionLinked: false,
        metadata: { decorative: false }
      }
    ];
    const report = MarkdownValidator.validatePhase1Detailed("# Doc", blocks);

    expect(report.passed).toBe(false);
    expect(report.errors[0]).toContain("Marker 3 Failed");
  });

  it("fails marker 4 when markdown HS Code order diverges from layout order", () => {
    const markdown = [
      "# CHAPTER 7",
      "",
      "## 0704.90.10 — ROUND CABBAGES",
      "",
      "## 0701.90.10 — CHIPPING POTATOES"
    ].join("\n");
    const report = MarkdownValidator.validatePhase1Detailed(markdown, [
      textBlock("hs-1", 1, 10, "0701.90.10\nCHIPPING POTATOES"),
      textBlock("hs-2", 1, 20, "0704.90.10\nROUND CABBAGES")
    ]);

    expect(report.passed).toBe(false);
    expect(report.errors).toContain("[Marker 4 Failed] HS Code order in Markdown diverges from the layout source.");
  });

  it("fails marker 5 when an HS Code heading has the wrong title", () => {
    const markdown = ["# CHAPTER 7", "", "## 0701.90.10 — WRONG TITLE"].join("\n");
    const report = MarkdownValidator.validatePhase1Detailed(markdown, [
      textBlock("hs-1", 1, 10, "0701.90.10\nCHIPPING POTATOES")
    ]);

    expect(report.passed).toBe(false);
    expect(report.errors.some((error) => error.includes("Marker 5 Failed"))).toBe(true);
  });

  it("fails marker 5 when confirmed HS title pairs are fewer than layout HS codes", () => {
    const markdown = [
      "# CHAPTER 12",
      "",
      "## 1207.10.10 — PALM NUTS SUITABLE FOR SOWING/PLANTING",
      "",
      "## 1211.90.95 — Gaharu tree species"
    ].join("\n");
    const report = MarkdownValidator.validatePhase1Detailed(markdown, [
      textBlock("hs-1", 1, 10, "1207.10.10\nPALM NUTS SUITABLE FOR SOWING/PLANTING"),
      textBlock("hs-2", 1, 20, "1211.90.95"),
      textBlock("title-2", 1, 30, "AGARWOOD (GAHARU) CHIPS\nAgarwood body text.")
    ]);
    const marker5 = report.markers.find((marker) => marker.marker === "MARKER 5");

    expect(marker5?.passed).toBe(false);
    expect(marker5?.details?.pairCount).toBe(1);
    expect(marker5?.details?.layoutHSCodeCount).toBe(2);
  });

  it("passes marker 5 for Chapter 12 regression HS title pairs", () => {
    const markdown = [
      "# CHAPTER 12",
      "",
      "## 1207.10.10 — PALM NUTS SUITABLE FOR SOWING/PLANTING",
      "## 1211.90.13 — RAUWOLFIA SERPENTINA ROOTS",
      "## 1211.90.95 — AGARWOOD (GAHARU) CHIPS",
      "## 1211.90.97 — BARK OF PERSEA (PERSEA KURZII KOSTERM)",
      "## 1212.21.11 — EUCHEUMA SPINOSUM",
      "## 1212.21.12 — EUCHEUMA COTTONII",
      "## 1212.99.10 — STONES AND KERNELS OF APRICOT, PEACH (INCLUDING NECTARINE) OR PLUM"
    ].join("\n");
    const report = MarkdownValidator.validatePhase1Detailed(markdown, [
      textBlock("hs-1", 1, 10, "1207.10.10\nPALM NUTS SUITABLE FOR SOWING/PLANTING"),
      textBlock("hs-2", 1, 20, "1211.90.13\nRAUWOLFIA SERPENTINA ROOTS"),
      textBlock("hs-3", 1, 30, "1211.90.95\nAGARWOOD (GAHARU) CHIPS"),
      textBlock("hs-4", 1, 40, "1211.90.97\nBARK OF PERSEA (PERSEA KURZII KOSTERM)"),
      textBlock("hs-5", 1, 50, "1212.21.11\nEUCHEUMA SPINOSUM"),
      textBlock("hs-6", 1, 60, "1212.21.12\nEUCHEUMA COTTONII"),
      textBlock(
        "hs-7",
        1,
        70,
        "1212.99.10\nSTONES AND KERNELS OF APRICOT, PEACH (INCLUDING NECTARINE) OR\nPLUM"
      )
    ]);
    const marker5 = report.markers.find((marker) => marker.marker === "MARKER 5");

    expect(marker5?.passed).toBe(true);
    expect(marker5?.details?.pairCount).toBe(7);
  });

  it("fails markers 7 and 8 when captions leak source text or over-fuse content", () => {
    const markdown = [
      "# CHAPTER 7",
      "",
      "## 0701.90.10 — CHIPPING POTATOES",
      "",
      "*Caption: 0701.90.10 CHIPPING POTATOES (Source: Philippines) this caption is too long because it fused a paragraph into the image caption*"
    ].join("\n");
    const report = MarkdownValidator.validatePhase1Detailed(markdown, [
      textBlock("hs-1", 1, 10, "0701.90.10\nCHIPPING POTATOES")
    ]);

    expect(report.errors.some((error) => error.includes("Marker 7 Failed"))).toBe(true);
    expect(report.errors.some((error) => error.includes("Marker 8 Failed"))).toBe(true);
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
    bbox: { page: pageNumber, x0: 90, y0: order, x1: 520, y1: order + 20 },
    metadata: { layoutOnly: true, includeInMarkdown: false }
  };
}
