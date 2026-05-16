import { describe, expect, it } from "vitest";
import { ArtifactFilter } from "../src/orchestrator/artifactFilter";
import type { LayoutAnalysis, ParsedBlock } from "../src/types";

describe("ArtifactFilter", () => {
  it("marks full-page background images as decorative before semantic fusion", () => {
    const blocks: ParsedBlock[] = [
      imageBlock("page-bg", 1, { page: 1, x0: 0, y0: 0, x1: 600, y1: 800 }, 1),
      imageBlock("figure", 1, { page: 1, x0: 120, y0: 160, x1: 360, y1: 360 }, 0.1)
    ];

    const filtered = ArtifactFilter.filter(blocks, layout());
    const background = filtered.find((block) => block.id === "page-bg");
    const figure = filtered.find((block) => block.id === "figure");

    expect(background?.metadata?.decorative).toBe(true);
    expect(background?.metadata?.artifactFilter).toEqual(
      expect.objectContaining({ filtered: true, reasons: expect.arrayContaining(["page-background"]) })
    );
    expect(figure?.metadata?.decorative).toBe(false);
  });

  it("marks repeated edge logos without filtering body figures", () => {
    const blocks: ParsedBlock[] = [
      imageBlock("logo-1", 1, { page: 1, x0: 24, y0: 18, x1: 84, y1: 58 }, 0.005),
      imageBlock("logo-2", 2, { page: 2, x0: 25, y0: 19, x1: 85, y1: 59 }, 0.005),
      imageBlock("figure-1", 1, { page: 1, x0: 120, y0: 160, x1: 360, y1: 360 }, 0.1),
      imageBlock("figure-2", 2, { page: 2, x0: 120, y0: 160, x1: 360, y1: 360 }, 0.1)
    ];

    const filtered = ArtifactFilter.filter(blocks, layout(2), { noiseTolerance: 20 });

    expect(filtered.find((block) => block.id === "logo-1")?.metadata?.decorative).toBe(true);
    expect(filtered.find((block) => block.id === "logo-2")?.metadata?.decorative).toBe(true);
    expect(filtered.find((block) => block.id === "figure-1")?.metadata?.decorative).toBe(false);
    expect(filtered.find((block) => block.id === "figure-2")?.metadata?.decorative).toBe(false);
  });

  it("keeps normal alpha images but filters elongated alpha watermarks", () => {
    const blocks: ParsedBlock[] = [
      withAlpha(imageBlock("alpha-figure", 1, { page: 1, x0: 120, y0: 220, x1: 300, y1: 360 }, 0.0525)),
      withAlpha(imageBlock("watermark", 1, { page: 1, x0: 120, y0: 320, x1: 520, y1: 410 }, 0.075))
    ];

    const filtered = ArtifactFilter.filter(blocks, layout());

    expect(filtered.find((block) => block.id === "alpha-figure")?.metadata?.decorative).toBe(false);
    expect(filtered.find((block) => block.id === "watermark")?.metadata?.decorative).toBe(true);
  });
});

function imageBlock(id: string, pageNumber: number, bbox: ParsedBlock["bbox"], areaRatio: number): ParsedBlock {
  return {
    id,
    type: "image",
    source: "layout",
    pageNumber,
    order: pageNumber * 1000,
    bbox,
    captionLinked: false,
    metadata: {
      decorative: false,
      includeInMarkdown: false,
      areaRatio,
      pageWidth: 600,
      pageHeight: 800
    }
  };
}

function withAlpha(block: ParsedBlock): ParsedBlock {
  return {
    ...block,
    metadata: {
      ...(block.metadata ?? {}),
      hasAlpha: true
    }
  };
}

function layout(pageCount = 1): LayoutAnalysis {
  return {
    pdfPath: "sample.pdf",
    pageCount,
    pages: Array.from({ length: pageCount }, (_, index) => ({
      pageNumber: index + 1,
      width: 600,
      height: 800,
      textBlocks: [],
      imageBlocks: [],
      tableCandidates: [],
      drawingBlocks: [],
      textCharacterCount: 0,
      textDensity: 0,
      imageCoverageRatio: 0,
      hasTables: false,
      hasImages: true,
      hasFloatingText: false,
      isScanned: false,
      route: "accurate",
      routeReasons: ["image-anchor"]
    }))
  };
}
