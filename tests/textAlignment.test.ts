import { describe, expect, it } from "vitest";
import {
  bestMatchParsedUnitToPdfSpan,
  bestMatchPdfSpanToParsedUnit,
  fallbackBlockForPdfSpan,
  normalizeTextForAlignment,
  scoreTextAlignment,
  type MappedBlockForAlignment,
  type ParsedTextUnit,
  type PdfTextSpan
} from "../src/alignment/textAlignment";

describe("text alignment utilities", () => {
  it("normalizes case, punctuation, ranges, markdown, and diacritics without dropping useful words", () => {
    expect(normalizeTextForAlignment("ARABICA COFFEE")).toBe("arabica coffee");
    expect(normalizeTextForAlignment("0.8–1.4%")).toBe("0.8 1.4");
    expect(normalizeTextForAlignment("**AGARWOOD (GAHARU) CHIPS**")).toBe("agarwood gaharu chips");
    expect(normalizeTextForAlignment("Cà phê Đắk Lắk")).toBe("ca phe dak lak");
  });

  it("scores exact and overlapping phrases higher than unrelated text", () => {
    const exact = scoreTextAlignment("AGARWOOD (GAHARU) CHIPS", "Agarwood Gaharu Chips", { samePage: true });
    const unrelated = scoreTextAlignment("AGARWOOD (GAHARU) CHIPS", "live bovine animals");

    expect(exact.score).toBeGreaterThan(90);
    expect(exact.confidence).toBe("high");
    expect(unrelated.score).toBe(0);
  });

  it("matches a clicked PDF span to the best parsed unit on the same page", () => {
    const span: PdfTextSpan = {
      id: "span-1",
      pageNumber: 3,
      text: "AGARWOOD (GAHARU) CHIPS"
    };
    const units: ParsedTextUnit[] = [
      parsedUnit("wrong", "Live animals", 3),
      parsedUnit("right", "1211.90.19 AGARWOOD (GAHARU) CHIPS", 3),
      parsedUnit("other-page", "AGARWOOD (GAHARU) CHIPS", 8)
    ];

    const match = bestMatchPdfSpanToParsedUnit(span, units, { currentPage: 3 });
    expect(match.item?.id).toBe("right");
    expect(match.confidence).toBe("high");
  });

  it("matches a parsed unit back to a PDF text span", () => {
    const unit = parsedUnit("unit-1", "Arabica coffee, not roasted", 2);
    const spans: PdfTextSpan[] = [
      { id: "span-a", pageNumber: 2, text: "Robusta coffee" },
      { id: "span-b", pageNumber: 2, text: "ARABICA COFFEE" }
    ];

    const match = bestMatchParsedUnitToPdfSpan(unit, spans, { currentPage: 2 });
    expect(match.item?.id).toBe("span-b");
    expect(match.score).toBeGreaterThan(40);
  });

  it("falls back to a same-page block when text span matching is below threshold", () => {
    const span: PdfTextSpan = {
      id: "span-1",
      pageNumber: 5,
      text: "encoded table fragment",
      bbox: { x0: 20, y0: 20, x1: 80, y1: 40 }
    };
    const blocks: MappedBlockForAlignment[] = [
      { id: "b1", pageNumber: 5, text: "completely different", bbox: { x0: 10, y0: 10, x1: 100, y1: 80 } },
      { id: "b2", pageNumber: 6, text: "encoded table fragment", bbox: { x0: 10, y0: 10, x1: 100, y1: 80 } }
    ];

    const match = fallbackBlockForPdfSpan(span, blocks);
    expect(match.item?.id).toBe("b1");
    expect(match.confidence).toBe("fallback");
  });

  it("boosts numeric and HS code overlap", () => {
    const score = scoreTextAlignment("0102.29.11 0.8-1.4%", "HS 0102.29.11 rate 0.8 1.4", { samePage: true });
    expect(score.score).toBeGreaterThan(80);
    expect(score.reasons.some((reason) => reason.startsWith("hs:"))).toBe(true);
    expect(score.reasons.some((reason) => reason.startsWith("numeric:"))).toBe(true);
  });

  it("matches diacritic-insensitive text", () => {
    const score = scoreTextAlignment("ca phe arabica", "Cà phê Arabica");
    expect(score.confidence).toBe("high");
  });
});

function parsedUnit(id: string, text: string, pageNumber: number): ParsedTextUnit {
  return {
    id,
    document: "Chapter12.pdf",
    pageNumber,
    text,
    source: "block"
  };
}
