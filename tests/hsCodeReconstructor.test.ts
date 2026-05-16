import { describe, expect, it } from "vitest";
import { HSCodeReconstructor } from "../src/orchestrator/hsCodeReconstructor";
import type { ParsedBlock } from "../src/types";

describe("HSCodeReconstructor", () => {
  it("reconstructs HS Code sections from layout blocks instead of parser markdown", () => {
    const blocks: ParsedBlock[] = [
      {
        id: "parser-page",
        type: "page",
        source: "docling",
        pageNumber: 1,
        order: 1,
        markdown: "## 0701.90.10\n\n## CHAPTER 7\n\nbroken parser markdown"
      },
      textBlock("chapter-hs", 1, 10, 80, "CHAPTER 7\n0701.90.10\nCHIPPING POTATOES"),
      textBlock("body", 1, 11, 130, "Chipping potatoes are tubers\nwhich are grown for chips."),
      {
        id: "img-1",
        type: "image",
        source: "layout",
        pageNumber: 1,
        order: 12,
        bbox: { page: 1, x0: 100, y0: 220, x1: 320, y1: 360 },
        captionLinked: true,
        metadata: {
          decorative: false,
          captionText: "CHIPPING POTATOES"
        }
      },
      textBlock("source", 1, 13, 370, "(Source: Philippines)")
    ];

    const markdown = HSCodeReconstructor.buildMarkdown(blocks);

    expect(markdown).toContain("# CHAPTER 7");
    expect(markdown).toContain("## 0701.90.10 — CHIPPING POTATOES");
    expect(markdown).toContain("Chipping potatoes are tubers which are grown for chips.");
    expect(markdown).toContain("<!-- image: img-1 -->");
    expect(markdown).toContain("*Caption: CHIPPING POTATOES*");
    expect(markdown).toContain("(Source: Philippines)");
    expect(markdown).not.toContain("broken parser markdown");
  });

  it("keeps source lines out of rendered captions", () => {
    const blocks: ParsedBlock[] = [
      textBlock("chapter-hs", 1, 10, 80, "CHAPTER 7\n0704.90.10\nROUND CABBAGES"),
      {
        id: "img-1",
        type: "image",
        source: "layout",
        pageNumber: 1,
        order: 11,
        bbox: { page: 1, x0: 100, y0: 220, x1: 320, y1: 360 },
        captionLinked: true,
        metadata: {
          decorative: false,
          captionText: "Pictures 1. Round Cabbages\n(Source: Malaysia)"
        }
      }
    ];

    const markdown = HSCodeReconstructor.buildMarkdown(blocks);

    expect(markdown).toContain("*Caption: Pictures 1. Round Cabbages*");
    expect(markdown).not.toContain("*Caption: Pictures 1. Round Cabbages (Source: Malaysia)*");
  });

  it("renders grouped Chapter 1 HS codes as separate shared-title headings", () => {
    const blocks: ParsedBlock[] = [
      textBlock("direct", 1, 10, 80, "CHAPTER 1\n0102.29.11\nOXEN\nOxen body."),
      textBlock(
        "grouped",
        2,
        20,
        120,
        [
          "0105.11.10 0105.12.10 0105.13.10 0105.14.10 0105.15.10",
          "0105.94.10 0105.99.10 0105.99.30",
          "BREEDING",
          "Breeding body.",
          "(Source: Test)"
        ].join("\n")
      )
    ];

    const markdown = HSCodeReconstructor.buildMarkdown(blocks, { ensureDocumentHeader: false });
    const expectedPairs = [
      ["0102.29.11", "OXEN"],
      ["0105.11.10", "BREEDING"],
      ["0105.12.10", "BREEDING"],
      ["0105.13.10", "BREEDING"],
      ["0105.14.10", "BREEDING"],
      ["0105.15.10", "BREEDING"],
      ["0105.94.10", "BREEDING"],
      ["0105.99.10", "BREEDING"],
      ["0105.99.30", "BREEDING"]
    ];

    for (const [code, title] of expectedPairs) {
      expect(markdown).toContain(`## ${code} \u2014 ${title}`);
    }
    for (const [code] of expectedPairs.slice(1)) {
      const section = markdownSection(markdown, code);
      expect(section).toContain("Grouped HS code set:");
      expect(section).toContain("Shared description:");
      expect(section).toContain("Breeding body.");
      expect(section).toContain("(Source: Test)");
    }
    expect(markdownSection(markdown, "0102.29.11")).not.toContain("Shared description:");
  });

  it("does not group distant HS code lines or steal the next section title", () => {
    const blocks: ParsedBlock[] = [
      textBlock("missing-title", 1, 10, 80, "0101.10.00"),
      textBlock("next-section", 1, 11, 320, "0102.29.11\nOXEN")
    ];

    const markdown = HSCodeReconstructor.buildMarkdown(blocks, { ensureDocumentHeader: false });

    expect(markdown).toContain("## 0101.10.00");
    expect(markdown).toContain("## 0102.29.11 \u2014 OXEN");
    expect(markdown).not.toContain("## 0101.10.00 \u2014 OXEN");
  });

  it("renders exported image assets as Markdown image links", () => {
    const blocks: ParsedBlock[] = [
      {
        id: "img-asset",
        type: "image",
        source: "layout",
        pageNumber: 1,
        order: 10,
        bbox: { page: 1, x0: 100, y0: 220, x1: 320, y1: 360 },
        captionLinked: true,
        metadata: {
          decorative: false,
          captionText: "Picture 1. Palm Nuts",
          assetPath: "assets/Chapter12/img-asset.png"
        }
      }
    ];

    const markdown = HSCodeReconstructor.buildMarkdown(blocks, { ensureDocumentHeader: false });

    expect(markdown).toContain("![Picture 1. Palm Nuts](assets/Chapter12/img-asset.png)");
    expect(markdown).toContain("<!-- image-id: img-asset -->");
    expect(markdown).toContain("*Caption: Picture 1. Palm Nuts*");
  });

  it("uses title and body from the block after an HS code instead of a later table header", () => {
    const blocks: ParsedBlock[] = [
      textBlock("code", 1, 10, 260, "1211.90.95"),
      textBlock(
        "title-body",
        1,
        11,
        320,
        "AGARWOOD (GAHARU) CHIPS\nAgarwood, also known as oud, is a dark resinous heartwood."
      ),
      tableBlock("table", 1, 12, 510, 690),
      textBlock("table-header", 1, 13, 515, "Gaharu tree species")
    ];

    const markdown = HSCodeReconstructor.buildMarkdown(blocks, { ensureDocumentHeader: false });

    expect(markdown).toContain("## 1211.90.95 — AGARWOOD (GAHARU) CHIPS");
    expect(markdown).toContain("Agarwood, also known as oud, is a dark resinous heartwood.");
    expect(markdown).not.toContain("## 1211.90.95 — Gaharu tree species");
  });

  it("combines adjacent uppercase title lines without stealing from earlier HS sections", () => {
    const blocks: ParsedBlock[] = [
      textBlock("code-1", 1, 10, 250, "1212.21.12"),
      textBlock("title-1", 1, 11, 266, "EUCHEUMA COTTONII\nScientific name/Genus"),
      textBlock("code-2", 1, 12, 620, "1212.99.10"),
      textBlock("title-2a", 1, 13, 636, "STONES AND KERNELS OF APRICOT, PEACH (INCLUDING NECTARINE) OR"),
      textBlock("title-2b-body", 1, 14, 652, "PLUM\nA stone fruit has a large stone inside.")
    ];

    const markdown = HSCodeReconstructor.buildMarkdown(blocks, { ensureDocumentHeader: false });

    expect(markdown).toContain("## 1212.21.12 — EUCHEUMA COTTONII");
    expect(markdown).toContain("## 1212.99.10 — STONES AND KERNELS OF APRICOT, PEACH (INCLUDING NECTARINE) OR PLUM");
    expect(markdown).toContain("A stone fruit has a large stone inside.");
    expect(markdown).not.toContain("## 1212.21.12 — STONES AND KERNELS");
  });
});

function textBlock(id: string, pageNumber: number, order: number, y0: number, text: string): ParsedBlock {
  return {
    id,
    type: "text",
    source: "layout",
    pageNumber,
    order,
    text,
    bbox: { page: pageNumber, x0: 90, y0, x1: 500, y1: y0 + 24 },
    metadata: { layoutOnly: true, includeInMarkdown: false }
  };
}

function tableBlock(id: string, pageNumber: number, order: number, y0: number, y1: number): ParsedBlock {
  return {
    id,
    type: "table",
    source: "layout",
    pageNumber,
    order,
    bbox: { page: pageNumber, x0: 90, y0, x1: 520, y1 },
    metadata: { includeInMarkdown: false, reason: "pymupdf-find-tables" }
  };
}

function markdownSection(markdown: string, hsCode: string): string {
  const start = markdown.indexOf(`## ${hsCode}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = markdown.slice(start + 1).search(/\n## \d{4}\.\d{2}\.\d{2}\b/);
  return next === -1 ? markdown.slice(start) : markdown.slice(start, start + 1 + next);
}
