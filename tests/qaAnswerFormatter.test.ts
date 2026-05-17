import { describe, expect, it } from "vitest";
import {
  enrichRetrievedHit,
  formatCitation,
  renderHsCodeAnswer,
  selectAlternativeSections,
  type EnrichedRetrievedSection,
  type SectionMetadata
} from "../src/agent/qaAnswerFormatter";

describe("qaAnswerFormatter", () => {
  it("forces HS Code and full citation for Hevea seedlings", () => {
    const section = sectionFixture({
      document: "Chapter06.pdf",
      hsCode: "0602.90.50",
      title: "SEEDLINGS OF THE GENUS HEVEA",
      section: "0602.90.50 — SEEDLINGS OF THE GENUS HEVEA",
      pageStart: 22,
      pageEnd: 22,
      source: "Malaysia",
      text: "Seedlings of the genus Hevea are germinated rubber tree seeds with a root length of about 1 to 2 cm."
    });

    const result = renderHsCodeAnswer(
      "Seedlings of the genus Hevea là hạt cây cao su đã nảy mầm, có chiều dài rễ khoảng 1–2 cm.",
      section
    );

    expect(result.answer).toContain("HS Code: 0602.90.50");
    expect(result.answer).toContain("Chapter06.pdf");
    expect(result.answer).toContain("page 22");
    expect(result.answer).toContain("0602.90.50 — SEEDLINGS OF THE GENUS HEVEA");
  });

  it("forces HS Code and citation for Oxen", () => {
    const section = sectionFixture({
      document: "Chapter01.pdf",
      hsCode: "0102.29.11",
      title: "OXEN",
      section: "0102.29.11 — OXEN",
      pageStart: 1,
      pageEnd: 2,
      source: "Indonesia",
      text: "Oxen are castrated adult male bovine animals."
    });

    const result = renderHsCodeAnswer("Oxen là bò đực trưởng thành đã thiến.", section);

    expect(result.answer).toContain("HS Code: 0102.29.11");
    expect(result.answer).toContain("Chapter01.pdf");
    expect(result.answer).toContain("section \"0102.29.11 — OXEN\"");
  });

  it("forces HS Code and citation for agarwood chips", () => {
    const section = sectionFixture({
      document: "Chapter12.pdf",
      hsCode: "1211.90.95",
      title: "AGARWOOD (GAHARU) CHIPS",
      section: "1211.90.95 — AGARWOOD (GAHARU) CHIPS",
      pageStart: 56,
      pageEnd: 57,
      source: "Indonesia",
      text: "Agarwood chips are also known as gaharu chips."
    });

    const result = renderHsCodeAnswer("Agarwood chips còn được gọi là gaharu chips.", section);

    expect(result.answer).toContain("HS Code: 1211.90.95");
    expect(result.answer).toContain("Chapter12.pdf");
    expect(result.answer).toContain("pages 56–57");
    expect(result.answer).toContain("section \"1211.90.95 — AGARWOOD (GAHARU) CHIPS\"");
  });

  it("includes related HS codes for comparison questions", () => {
    const robusta = sectionFixture({
      document: "Chapter09.pdf",
      hsCode: "0901.11.30",
      title: "ROBUSTA COFFEE",
      section: "0901.11.30 — ROBUSTA COFFEE",
      text: "Robusta coffee has a stronger taste."
    });
    const arabica = sectionFixture({
      document: "Chapter09.pdf",
      hsCode: "0901.21.12",
      title: "ARABICA COFFEE",
      section: "0901.21.12 — ARABICA COFFEE",
      text: "Arabica coffee has a milder taste."
    });

    const alternatives = selectAlternativeSections([robusta, arabica], "Robusta coffee khác Arabica thế nào?");
    const result = renderHsCodeAnswer("Robusta và Arabica khác nhau theo mô tả trong từng section.", robusta, alternatives);

    expect(result.answer).toContain("HS Code: 0901.11.30");
    expect(result.answer).toContain("HS Code: 0901.21.12");
  });

  it("repairs LLM answers that omit retrieved HS Code", () => {
    const section = sectionFixture({
      document: "Chapter06.pdf",
      hsCode: "0602.90.50",
      title: "SEEDLINGS OF THE GENUS HEVEA",
      section: "0602.90.50 — SEEDLINGS OF THE GENUS HEVEA",
      text: "Seedlings of the genus Hevea are germinated rubber tree seeds."
    });

    const result = renderHsCodeAnswer("Seedlings of the genus Hevea là hạt cây cao su đã nảy mầm.", section);

    expect(result.answer).toContain("0602.90.50");
    expect(result.answer).toContain("Nguồn:");
  });

  it("standardizes citation instead of keeping LLM citation text", () => {
    const section = sectionFixture({
      document: "Chapter06.pdf",
      hsCode: "0602.90.50",
      title: "SEEDLINGS OF THE GENUS HEVEA",
      section: "0602.90.50 — SEEDLINGS OF THE GENUS HEVEA",
      pageStart: 22,
      pageEnd: 22,
      text: "Seedlings of the genus Hevea are germinated rubber tree seeds."
    });

    const result = renderHsCodeAnswer(
      "Seedlings là hạt cây cao su đã nảy mầm. Trích dẫn: Chapter06.pdf, trang 22.",
      section
    );

    expect(result.answer).not.toContain("Trích dẫn:");
    expect(result.answer).toContain('Nguồn: Chapter06.pdf, page 22, section "0602.90.50 — SEEDLINGS OF THE GENUS HEVEA".');
  });

  it("joins tree hit with local section metadata by hsCode", () => {
    const metadata: SectionMetadata[] = [
      {
        document: "Chapter06.pdf",
        hsCode: "0602.90.50",
        title: "SEEDLINGS OF THE GENUS HEVEA",
        section: "0602.90.50 — SEEDLINGS OF THE GENUS HEVEA",
        pageStart: 22,
        pageEnd: 22,
        source: "Malaysia"
      }
    ];

    const enriched = enrichRetrievedHit(
      {
        document: "Chapter06.pdf",
        title: "0602.90.50 — SEEDLINGS OF THE GENUS HEVEA",
        text: "## 0602.90.50 — SEEDLINGS OF THE GENUS HEVEA\n\nSeedlings are germinated rubber tree seeds.",
        score: 4
      },
      metadata
    );

    expect(enriched.hsCode).toBe("0602.90.50");
    expect(enriched.pageStart).toBe(22);
    expect(enriched.source).toBe("Malaysia");
  });

  it("formats citations without a page when page metadata is missing", () => {
    expect(formatCitation(sectionFixture({
      document: "Chapter06.pdf",
      hsCode: "0602.90.50",
      section: "0602.90.50 — SEEDLINGS OF THE GENUS HEVEA"
    }))).toBe('Nguồn: Chapter06.pdf, section "0602.90.50 — SEEDLINGS OF THE GENUS HEVEA".');
  });
});

function sectionFixture(overrides: Partial<EnrichedRetrievedSection>): EnrichedRetrievedSection {
  return {
    document: "Chapter.pdf",
    text: "",
    captions: [],
    score: 1,
    metadataWarnings: [],
    ...overrides
  };
}
