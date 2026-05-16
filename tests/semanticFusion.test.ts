import { describe, expect, it } from "vitest";
import type { ParsedBlock } from "../src/types";
import { SemanticFusion } from "../src/orchestrator/semanticFusion";

describe("SemanticFusion", () => {
  it("links a nearby figure caption to an image anchor", () => {
    const blocks: ParsedBlock[] = [
      {
        id: "img-1",
        type: "image",
        source: "layout",
        pageNumber: 1,
        order: 10,
        bbox: { page: 1, x0: 100, y0: 100, x1: 300, y1: 250 },
        captionLinked: false,
        metadata: { decorative: false, pageWidth: 600, pageHeight: 800 }
      },
      {
        id: "txt-1",
        type: "text",
        source: "layout",
        pageNumber: 1,
        order: 11,
        text: "Hinh 1. Engine overview",
        bbox: { page: 1, x0: 110, y0: 260, x1: 290, y1: 282 },
        metadata: { layoutOnly: true, includeInMarkdown: false, avgFontSize: 9 }
      }
    ];

    const fused = SemanticFusion.fuse(blocks);
    const image = fused.find((block) => block.id === "img-1");
    const caption = fused.find((block) => block.id === "fusion-caption-img-1");

    expect(image?.captionLinked).toBe(true);
    expect(image?.linkedCaptionIds).toContain("txt-1");
    expect(caption?.text).toContain("Engine overview");
  });

  it("removes duplicate image anchors before validation", () => {
    const blocks: ParsedBlock[] = [
      {
        id: "img-1",
        type: "image",
        source: "layout",
        pageNumber: 1,
        order: 10,
        bbox: { page: 1, x0: 100, y0: 100, x1: 300, y1: 250 },
        metadata: { decorative: false }
      },
      {
        id: "img-2",
        type: "image",
        source: "layout",
        pageNumber: 1,
        order: 11,
        bbox: { page: 1, x0: 101, y0: 101, x1: 299, y1: 249 },
        metadata: { decorative: false }
      }
    ];

    const fused = SemanticFusion.fuse(blocks);
    expect(fused.filter((block) => block.type === "image")).toHaveLength(1);
  });

  it("propagates captions to adjacent images in the same visual group", () => {
    const blocks: ParsedBlock[] = [
      {
        id: "img-linked",
        type: "image",
        source: "layout",
        pageNumber: 1,
        order: 10,
        bbox: { page: 1, x0: 120, y0: 180, x1: 280, y1: 320 },
        captionLinked: false,
        metadata: { decorative: false, areaRatio: 0.05, pageWidth: 600, pageHeight: 800 }
      },
      {
        id: "img-sibling",
        type: "image",
        source: "layout",
        pageNumber: 1,
        order: 11,
        bbox: { page: 1, x0: 350, y0: 190, x1: 510, y1: 320 },
        captionLinked: false,
        metadata: { decorative: false, areaRatio: 0.05, pageWidth: 600, pageHeight: 800 }
      },
      {
        id: "caption-1",
        type: "text",
        source: "layout",
        pageNumber: 1,
        order: 12,
        text: "Cabbage varieties",
        bbox: { page: 1, x0: 122, y0: 330, x1: 280, y1: 348 },
        metadata: { layoutOnly: true, includeInMarkdown: false, avgFontSize: 9 }
      }
    ];

    const fused = SemanticFusion.fuse(blocks);
    const sibling = fused.find((block) => block.id === "img-sibling");

    expect(sibling?.captionLinked).toBe(true);
    expect(sibling?.metadata?.captionPropagatedFrom).toBe("img-linked");
  });

  it("keeps source lines and HS code paragraphs out of fused captions", () => {
    const blocks: ParsedBlock[] = [
      {
        id: "img-1",
        type: "image",
        source: "layout",
        pageNumber: 1,
        order: 10,
        bbox: { page: 1, x0: 110, y0: 220, x1: 310, y1: 360 },
        captionLinked: false,
        metadata: { decorative: false, pageWidth: 600, pageHeight: 800 }
      },
      {
        id: "hs-text",
        type: "text",
        source: "layout",
        pageNumber: 1,
        order: 11,
        text: [
          "0704.90.10",
          "ROUND (DRUMHEAD) CABBAGES",
          "Round cabbage or drumhead cabbage is a type of cabbage having a compact round head with white-veined leaves."
        ].join("\n"),
        bbox: { page: 1, x0: 105, y0: 170, x1: 500, y1: 215 },
        metadata: { layoutOnly: true, includeInMarkdown: false, avgFontSize: 10 }
      },
      {
        id: "source-text",
        type: "text",
        source: "layout",
        pageNumber: 1,
        order: 12,
        text: "(Source: Philippines)",
        bbox: { page: 1, x0: 120, y0: 370, x1: 240, y1: 390 },
        metadata: { layoutOnly: true, includeInMarkdown: false, avgFontSize: 9 }
      }
    ];

    const fused = SemanticFusion.fuse(blocks);
    const image = fused.find((block) => block.id === "img-1");

    expect(image?.captionLinked).toBe(true);
    expect(image?.metadata?.captionText).toBe("ROUND (DRUMHEAD) CABBAGES");
  });

  it("does not use a later HS section title as the caption for an earlier image", () => {
    const blocks: ParsedBlock[] = [
      {
        id: "img-1",
        type: "image",
        source: "layout",
        pageNumber: 1,
        order: 10,
        bbox: { page: 1, x0: 120, y0: 80, x1: 340, y1: 220 },
        captionLinked: false,
        metadata: { decorative: false, pageWidth: 600, pageHeight: 800 }
      },
      {
        id: "picture-caption",
        type: "text",
        source: "layout",
        pageNumber: 1,
        order: 11,
        text: "Pictures 1. Round Cabbages, green and purple",
        bbox: { page: 1, x0: 100, y0: 230, x1: 420, y1: 250 },
        metadata: { layoutOnly: true, includeInMarkdown: false, avgFontSize: 9 }
      },
      {
        id: "next-hs",
        type: "text",
        source: "layout",
        pageNumber: 1,
        order: 12,
        text: "0704.90.20\nCHINESE MUSTARD",
        bbox: { page: 1, x0: 100, y0: 260, x1: 420, y1: 300 },
        metadata: { layoutOnly: true, includeInMarkdown: false, avgFontSize: 10 }
      }
    ];

    const fused = SemanticFusion.fuse(blocks);
    const image = fused.find((block) => block.id === "img-1");

    expect(image?.metadata?.captionText).toBe("Pictures 1. Round Cabbages, green and purple");
  });

  it("keeps adjacent picture captions separate when a text block contains multiple caption lines", () => {
    const blocks: ParsedBlock[] = [
      {
        id: "img-left",
        type: "image",
        source: "layout",
        pageNumber: 1,
        order: 10,
        bbox: { page: 1, x0: 100, y0: 100, x1: 260, y1: 240 },
        captionLinked: false,
        metadata: { decorative: false, pageWidth: 600, pageHeight: 800 }
      },
      {
        id: "img-right",
        type: "image",
        source: "layout",
        pageNumber: 1,
        order: 11,
        bbox: { page: 1, x0: 330, y0: 100, x1: 500, y1: 240 },
        captionLinked: false,
        metadata: { decorative: false, pageWidth: 600, pageHeight: 800 }
      },
      {
        id: "captions",
        type: "text",
        source: "layout",
        pageNumber: 1,
        order: 12,
        text: "Picture 1. Palm nuts suitable for sowing\nPicture 2. Palm Nuts",
        bbox: { page: 1, x0: 95, y0: 250, x1: 520, y1: 290 },
        metadata: {
          layoutOnly: true,
          includeInMarkdown: false,
          avgFontSize: 10,
          lines: [
            {
              text: "Picture 1. Palm nuts suitable for sowing",
              bbox: { page: 1, x0: 105, y0: 252, x1: 265, y1: 268 }
            },
            {
              text: "Picture 2. Palm Nuts",
              bbox: { page: 1, x0: 340, y0: 252, x1: 500, y1: 268 }
            }
          ]
        }
      }
    ];

    const fused = SemanticFusion.fuse(blocks);

    expect(fused.find((block) => block.id === "img-left")?.metadata?.captionText).toBe(
      "Picture 1. Palm nuts suitable for sowing"
    );
    expect(fused.find((block) => block.id === "img-right")?.metadata?.captionText).toBe("Picture 2. Palm Nuts");
  });
});
