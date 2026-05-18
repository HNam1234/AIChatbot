import { describe, expect, it } from "vitest";
import {
  detectContrastTerms,
  enrichRetrievedHit,
  evaluateCandidateRelevance,
  extractQuerySignals,
  formatCitation,
  propagateGroupedSectionPageRanges,
  rankSectionsForQuestion,
  renderHsCodeAnswer,
  selectAlternativeSections,
  selectRelevantSections,
  type EnrichedRetrievedSection,
  type SectionMetadata
} from "../src/agent/qaAnswerFormatter";

describe("qaAnswerFormatter", () => {
  it("forces HS Code and full citation for Hevea seedlings", () => {
    const section = sectionFixture({
      document: "Chapter06.pdf",
      hsCode: "0602.90.50",
      title: "SEEDLINGS OF THE GENUS HEVEA",
      section: "0602.90.50 - SEEDLINGS OF THE GENUS HEVEA",
      pageStart: 22,
      pageEnd: 22,
      source: "Malaysia",
      text: "Seedlings of the genus Hevea are germinated rubber tree seeds with a root length of about 1 to 2 cm."
    });

    const result = renderHsCodeAnswer(
      "Seedlings of the genus Hevea are germinated rubber tree seeds with a root length of about 1-2 cm.",
      section,
      [],
      { answerStyle: "verbose" }
    );

    expect(result.answer).toContain("HS Code: 0602.90.50");
    expect(result.answer).toContain("Chapter06.pdf");
    expect(result.answer).toContain("page 22");
    expect(result.answer).toContain("0602.90.50 - SEEDLINGS OF THE GENUS HEVEA");
  });

  it("forces HS Code and citation for Oxen", () => {
    const section = sectionFixture({
      document: "Chapter01.pdf",
      hsCode: "0102.29.11",
      title: "OXEN",
      section: "0102.29.11 - OXEN",
      pageStart: 1,
      pageEnd: 2,
      source: "Indonesia",
      text: "Oxen are castrated adult male bovine animals."
    });

    const result = renderHsCodeAnswer("Oxen are castrated adult male bovine animals.", section, [], {
      answerStyle: "verbose"
    });

    expect(result.answer).toContain("HS Code: 0102.29.11");
    expect(result.answer).toContain("Chapter01.pdf");
    expect(result.answer).toContain('section "0102.29.11 - OXEN"');
  });

  it("forces HS Code and citation for agarwood chips", () => {
    const section = sectionFixture({
      document: "Chapter12.pdf",
      hsCode: "1211.90.95",
      title: "AGARWOOD (GAHARU) CHIPS",
      section: "1211.90.95 - AGARWOOD (GAHARU) CHIPS",
      pageStart: 56,
      pageEnd: 57,
      source: "Indonesia",
      text: "Agarwood chips are also known as gaharu chips."
    });

    const result = renderHsCodeAnswer("Agarwood chips are also known as gaharu chips.", section, [], {
      answerStyle: "verbose"
    });

    expect(result.answer).toContain("HS Code: 1211.90.95");
    expect(result.answer).toContain("Chapter12.pdf");
    expect(result.answer).toContain("pages 56");
    expect(result.answer).toContain('section "1211.90.95 - AGARWOOD (GAHARU) CHIPS"');
  });

  it("includes related HS codes for comparison questions", () => {
    const robusta = sectionFixture({
      document: "Chapter09.pdf",
      hsCode: "0901.11.30",
      title: "ROBUSTA COFFEE",
      section: "0901.11.30 - ROBUSTA COFFEE",
      text: "Robusta coffee has a stronger taste."
    });
    const arabica = sectionFixture({
      document: "Chapter09.pdf",
      hsCode: "0901.21.12",
      title: "ARABICA COFFEE",
      section: "0901.21.12 - ARABICA COFFEE",
      text: "Arabica coffee has a milder taste."
    });

    const alternatives = selectAlternativeSections([robusta, arabica], "Compare Robusta coffee with Arabica coffee.");
    const result = renderHsCodeAnswer("Robusta and Arabica differ by their section descriptions.", robusta, alternatives, {
      answerStyle: "verbose"
    });

    expect(result.answer).toContain("HS Code: 0901.11.30");
    expect(result.answer).toContain("0901.21.12");
  });

  it("selects attribute-matching product instead of contrast baseline", () => {
    const robusta = sectionFixture({
      document: "Chapter09.pdf",
      hsCode: "0901.11.30",
      title: "ROBUSTA COFFEE",
      section: "0901.11.30 - ROBUSTA COFFEE",
      text: "Robusta coffee has a stronger bitter taste and higher caffeine than Arabica coffee.",
      score: 3
    });
    const arabica = sectionFixture({
      document: "Chapter09.pdf",
      hsCode: "0901.21.12",
      title: "ARABICA COFFEE",
      section: "0901.21.12 - ARABICA COFFEE",
      text: "Arabica coffee has a milder taste and lower caffeine.",
      score: 8
    });

    const ranked = rankSectionsForQuestion(
      [arabica, robusta],
      "Which coffee is more bitter than Arabica and has higher caffeine?"
    );
    const answer = renderHsCodeAnswer("The matching product is Robusta coffee.", ranked[0], [], {
      answerStyle: "verbose"
    });

    expect(detectContrastTerms("bitter hon Arabica").baselineTokens).toContain("arabica");
    expect(ranked[0].title).toContain("ROBUSTA");
    expect(answer.answer).toContain("HS Code: 0901.11.30");
    expect(answer.answer).not.toContain("HS Code: 0901.21.12");
    expect(answer.answer).toContain("Chapter09.pdf");
    expect(answer.answer).toContain("0901.11.30 - ROBUSTA COFFEE");
  });

  it("still selects the baseline product when directly asked", () => {
    const robusta = sectionFixture({
      document: "Chapter09.pdf",
      hsCode: "0901.11.30",
      title: "ROBUSTA COFFEE",
      section: "0901.11.30 - ROBUSTA COFFEE",
      text: "Robusta coffee has a stronger bitter taste.",
      score: 3
    });
    const arabica = sectionFixture({
      document: "Chapter09.pdf",
      hsCode: "0901.21.12",
      title: "ARABICA COFFEE",
      section: "0901.21.12 - ARABICA COFFEE",
      text: "Arabica coffee has a milder taste.",
      score: 3
    });

    const ranked = rankSectionsForQuestion([robusta, arabica], "What is Arabica coffee?");

    expect(ranked[0].title).toContain("ARABICA");
    expect(renderHsCodeAnswer("Arabica coffee is coffee.", ranked[0]).answer).toContain("HS Code: 0901.21.12");
  });

  it("returns all grouped HS codes when product state is unspecified", () => {
    const section = sectionFixture({
      document: "Chapter02.pdf",
      hsCode: "0207.14.10",
      groupedHsCodes: ["0207.14.10", "0207.27.10"],
      title: "MECHANICALLY DEBONED MEAT",
      section: "0207.14.10 - MECHANICALLY DEBONED MEAT",
      text: "Mechanically deboned meat is meat paste separated by mechanical process."
    });

    const result = renderHsCodeAnswer("Mechanically deboned meat is meat separated by machine.", section, [], {
      question: "What is mechanically deboned meat?",
      answerStyle: "verbose"
    });

    expect(result.answer).toContain("HS Code:");
    expect(result.answer).toContain("0207.14.10");
    expect(result.answer).toContain("0207.27.10");
    expect(result.answer).toMatch(/tr.{0,8}ng th.{0,8}i/i);
    expect(result.answer).toContain("Chapter02.pdf");
    expect(result.answer).toContain("0207.14.10 - MECHANICALLY DEBONED MEAT");
  });

  it("repairs LLM answers that omit retrieved HS Code", () => {
    const section = sectionFixture({
      document: "Chapter06.pdf",
      hsCode: "0602.90.50",
      title: "SEEDLINGS OF THE GENUS HEVEA",
      section: "0602.90.50 - SEEDLINGS OF THE GENUS HEVEA",
      text: "Seedlings of the genus Hevea are germinated rubber tree seeds."
    });

    const result = renderHsCodeAnswer("Seedlings of the genus Hevea are germinated rubber tree seeds.", section, [], {
      answerStyle: "verbose"
    });

    expect(result.answer).toContain("0602.90.50");
    expect(result.answer).toContain("Chapter06.pdf");
  });

  it("standardizes citation instead of keeping LLM citation text", () => {
    const section = sectionFixture({
      document: "Chapter06.pdf",
      hsCode: "0602.90.50",
      title: "SEEDLINGS OF THE GENUS HEVEA",
      section: "0602.90.50 - SEEDLINGS OF THE GENUS HEVEA",
      pageStart: 22,
      pageEnd: 22,
      text: "Seedlings of the genus Hevea are germinated rubber tree seeds."
    });

    const result = renderHsCodeAnswer(
      "Seedlings are germinated rubber tree seeds. Citation: Chapter06.pdf, page 22.",
      section,
      [],
      { answerStyle: "verbose" }
    );

    expect(result.answer).not.toContain("Citation:");
    expect(result.answer).toContain("Chapter06.pdf");
    expect(result.answer).toContain("page 22");
  });

  it("joins tree hit with local section metadata by hsCode", () => {
    const metadata: SectionMetadata[] = [
      {
        document: "Chapter06.pdf",
        hsCode: "0602.90.50",
        title: "SEEDLINGS OF THE GENUS HEVEA",
        section: "0602.90.50 - SEEDLINGS OF THE GENUS HEVEA",
        pageStart: 22,
        pageEnd: 22,
        source: "Malaysia"
      }
    ];

    const enriched = enrichRetrievedHit(
      {
        document: "Chapter06.pdf",
        title: "0602.90.50 - SEEDLINGS OF THE GENUS HEVEA",
        text: "## 0602.90.50 - SEEDLINGS OF THE GENUS HEVEA\n\nSeedlings are germinated rubber tree seeds.",
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
      section: "0602.90.50 - SEEDLINGS OF THE GENUS HEVEA"
    }))).toContain("Chapter06.pdf");
  });

  it("renders class-eval single-code product answer without inline citation", () => {
    const section = sectionFixture({
      document: "Chapter10.pdf",
      hsCode: "1001.99.10",
      title: "WHEAT (NOT FIT FOR HUMAN CONSUMPTION)",
      section: "1001.99.10 - WHEAT (NOT FIT FOR HUMAN CONSUMPTION)",
      text: "Wheat not fit for human consumption is grain used outside food channels."
    });

    const result = renderHsCodeAnswer("Wrong extra text. HS Code: 9999.99.99.", section);

    expect(result.answer).toContain("Wheat not fit for human consumption");
    expect(result.answer).toContain("HS Code:");
    expect(result.answer).toContain("1001.99.10");
    expect(result.answer).not.toContain("NguÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œn:");
    expect(result.answer).not.toContain("9999.99.99");
  });

  it("renders Vietnamese product query with Vietnamese wrapper", () => {
    const section = sectionFixture({
      document: "Chapter09.pdf",
      hsCode: "0901.21.12",
      title: "ARABICA COFFEE",
      section: "0901.21.12 - ARABICA COFFEE",
      text: "Arabica coffee has a milder taste."
    });

    const result = renderHsCodeAnswer(undefined, section, [], { question: "Arabica coffee thuÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢c mÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â£ HS nÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â o?" });

    expect(result.answer).toBe("Sản phẩm là Arabica coffee, HS Code: 0901.21.12.");
  });

  it("renders mixed Vietnamese-English product query with official English title", () => {
    const section = sectionFixture({
      document: "Chapter12.pdf",
      hsCode: "1211.90.95",
      title: "AGARWOOD (GAHARU) CHIPS",
      section: "1211.90.95 - AGARWOOD (GAHARU) CHIPS",
      text: "Agarwood chips are resinous fragrant wood pieces used for incense and perfume."
    });

    const result = renderHsCodeAnswer(undefined, section, [], { question: "Agarwood chips lÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â  mÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â£ nÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â o?" });

    expect(result.answer).toBe("Sản phẩm là Agarwood (Gaharu) chips, HS Code: 1211.90.95.");
  });

  it("renders Agarwood descriptive query with normalized title and HS Code", () => {
    const section = sectionFixture({
      document: "Chapter12.pdf",
      hsCode: "1211.90.95",
      title: "AGARWOOD (GAHARU) CHIPS",
      section: "1211.90.95 - AGARWOOD (GAHARU) CHIPS",
      text: "Agarwood chips are resinous fragrant wood pieces used for incense and perfume."
    });

    const result = renderHsCodeAnswer(undefined, section, [], {
      question: "Resinous fragrant agarwood chips dÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¹ng lÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â m incense thuÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢c mÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â£ nÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â o?"
    });

    expect(result.answer).toBe("Sản phẩm là Agarwood (Gaharu) chips, HS Code: 1211.90.95.");
  });

  it("renders class-eval grouped-code product answer with all grouped codes", () => {
    const section = sectionFixture({
      document: "Chapter02.pdf",
      hsCode: "0207.14.10",
      groupedHsCodes: ["0207.14.10", "0207.27.10", "0207.45.10"],
      title: "MECHANICALLY DEBONED MEAT",
      section: "0207.14.10 - MECHANICALLY DEBONED MEAT",
      text: "Grouped HS code set: 0207.14.10, 0207.27.10, 0207.45.10."
    });

    const result = renderHsCodeAnswer(undefined, section);

    expect(result.answer).toContain("0207.14.10");
    expect(result.answer).toContain("0207.27.10");
    expect(result.answer).toContain("0207.45.10");
    expect(result.answer).toContain("hoặc");
    expect(result.answer).toContain("tùy trạng thái hàng hóa");
    expect(result.answer).not.toContain("Nguồn:");
  });

  it("renders definition answers from selected text with a concise HS Code attachment", () => {
    const section = sectionFixture({
      document: "Chapter01.pdf",
      hsCode: "0102.29.11",
      title: "OXEN",
      section: "0102.29.11 - OXEN",
      text: "Oxen are castrated adult male bovine animals. They are commonly used as draught animals."
    });

    const result = renderHsCodeAnswer(undefined, section, [], { question: "What is Oxen?" });

    expect(result.answer).toBe("Oxen are castrated adult male bovine animals. HS Code: 0102.29.11.");
    expect(result.answer).not.toContain("NguÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œn:");
  });

  it("uses Vietnamese definition wrapper for mixed-language definition questions", () => {
    const section = sectionFixture({
      document: "Chapter01.pdf",
      hsCode: "0102.29.11",
      title: "OXEN",
      section: "0102.29.11 - OXEN",
      text: "Oxen are castrated adult male bovine animals. They are commonly used as draught animals."
    });

    const result = renderHsCodeAnswer(undefined, section, [], { question: "Oxen lÃƒÆ’Ã‚Â  gÃƒÆ’Ã‚Â¬?" });

    expect(result.answer).toBe("Oxen là castrated adult male bovine animals. HS Code: 0102.29.11.");
  });

  it("keeps metadata template when definition-like wording explicitly asks for HS code", () => {
    const section = sectionFixture({
      document: "Chapter01.pdf",
      hsCode: "0102.29.11",
      title: "OXEN",
      section: "0102.29.11 - OXEN",
      text: "Oxen are castrated adult male bovine animals. They are commonly used as draught animals."
    });

    const result = renderHsCodeAnswer(undefined, section, [], { question: "Oxen HS Code lÃƒÆ’Ã‚Â  gÃƒÆ’Ã‚Â¬?" });

    expect(result.answer).toBe("Sản phẩm là Oxen, HS Code: 0102.29.11.");
  });

  it("includes short classification note when source text has a caveat", () => {
    const section = sectionFixture({
      document: "Chapter99.pdf",
      hsCode: "9999.10.10",
      title: "SAMPLE PRODUCT",
      section: "9999.10.10 - SAMPLE PRODUCT",
      text: "Sample product is a demonstrative item. However, goods presented with retail packaging should be classified under this code."
    });

    const result = renderHsCodeAnswer(undefined, section);

    expect(result.answer).toContain("HS Code: 9999.10.10");
    expect(result.answer).toContain("Lưu ý:");
    expect(result.answer.length).toBeLessThan(260);
  });

  it("does not include related candidate codes in class-eval answer", () => {
    const selected = sectionFixture({
      document: "Chapter09.pdf",
      hsCode: "0901.11.30",
      title: "ROBUSTA COFFEE",
      section: "0901.11.30 - ROBUSTA COFFEE",
      text: "Robusta coffee has a strong taste."
    });
    const related = sectionFixture({
      document: "Chapter09.pdf",
      hsCode: "0901.21.12",
      title: "ARABICA COFFEE",
      section: "0901.21.12 - ARABICA COFFEE",
      text: "Arabica coffee has a mild taste."
    });

    const result = renderHsCodeAnswer("Use HS Code: 0901.21.12.", selected, [related]);

    expect(result.answer).toContain("HS Code: 0901.11.30");
    expect(result.answer).not.toContain("0901.21.12");
    expect(result.answer).not.toContain("MÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â£ liÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Âªn quan");
  });

  it("extracts distinctive signals and selects an attribute-heavy candidate by properties", () => {
    const relevant = sectionFixture({
      document: "Chapter09.pdf",
      hsCode: "0901.11.30",
      title: "ROBUSTA COFFEE",
      section: "0901.11.30 - ROBUSTA COFFEE",
      text: "Robusta coffee beans have bitter taste, high caffeine content above 2%, and are traded as raw beans.",
      score: 2
    });
    const unrelated = sectionFixture({
      document: "Chapter44.pdf",
      hsCode: "4401.22.00",
      title: "WOOD CHIPS",
      section: "4401.22.00 - WOOD CHIPS",
      text: "Wood chips are small pieces of timber for fuel.",
      score: 9
    });

    const query = "Beverage beans with bitter taste, caffeine more than 2% and raw beans form belong to which HS code?";
    const signals = extractQuerySignals(query);
    const selection = selectRelevantSections([unrelated, relevant], query, { requireHsMetadata: true });
    const selectedRelevance = evaluateCandidateRelevance(selection.ranked[0], query, signals);
    const answer = renderHsCodeAnswer(undefined, selection.ranked[0], [], { question: query });

    expect(signals.numericRanges.length).toBeGreaterThan(0);
    expect(selectedRelevance.matchedNumericRanges.length).toBeGreaterThan(0);
    expect(selectedRelevance.matchedAttributes.length).toBeGreaterThan(0);
    expect(selection.ranked[0].document).not.toBe("Chapter44.pdf");
    expect(answer.finalHsCodes).toContain(selection.ranked[0].hsCode);
    expect(answer.answer).not.toContain("Chapter09.pdf");
  });

  it("penalizes contrast-only candidates and promotes positive attribute evidence", () => {
    const baselineOnly = sectionFixture({
      document: "Chapter09.pdf",
      hsCode: "0901.21.12",
      title: "ARABICA COFFEE",
      section: "0901.21.12 - ARABICA COFFEE",
      text: "Arabica coffee has mild aroma.",
      score: 10
    });
    const target = sectionFixture({
      document: "Chapter09.pdf",
      hsCode: "0901.11.30",
      title: "ROBUSTA COFFEE",
      section: "0901.11.30 - ROBUSTA COFFEE",
      text: "Robusta coffee is more bitter than Arabica and has higher caffeine.",
      score: 2
    });

    const query = "Which coffee is more bitter than Arabica and has higher caffeine?";
    const selection = selectRelevantSections([baselineOnly, target], query, { requireHsMetadata: true });
    const baselineRelevance = evaluateCandidateRelevance(baselineOnly, query);
    const targetRelevance = evaluateCandidateRelevance(target, query);

    expect(selection.ranked[0].hsCode).toBe(target.hsCode);
    expect(baselineRelevance.rejected || baselineRelevance.relevanceScore < targetRelevance.relevanceScore).toBe(true);
  });

  it("keeps grouped codes for unspecified subtype/state", () => {
    const section = sectionFixture({
      document: "Chapter12.pdf",
      groupedHsCodes: ["1211.90.11", "1211.90.19"],
      title: "MEDICINAL ROOTS",
      section: "1211.90.11 - MEDICINAL ROOTS",
      text: "Grouped HS code set: 1211.90.11, 1211.90.19. Medicinal roots may be fresh or dried."
    });

    const result = renderHsCodeAnswer(undefined, section, [], { question: "What HS Code are medicinal roots?" });

    expect(result.finalHsCodes).toEqual(["1211.90.11", "1211.90.19"]);
    expect(result.answer).toContain("1211.90.11");
    expect(result.answer).toContain("1211.90.19");
    expect(result.answer).toMatch(/tr.{0,8}ng th.{0,8}i/i);
  });

  it("direct product and definition queries still favor matching title metadata", () => {
    const oxen = sectionFixture({
      document: "Chapter01.pdf",
      hsCode: "0102.29.11",
      title: "OXEN",
      section: "0102.29.11 - OXEN",
      text: "Oxen are castrated adult male bovine animals.",
      score: 1
    });
    const cattle = sectionFixture({
      document: "Chapter01.pdf",
      hsCode: "0102.29.90",
      title: "OTHER CATTLE",
      section: "0102.29.90 - OTHER CATTLE",
      text: "Other cattle.",
      score: 5
    });

    const selection = selectRelevantSections([cattle, oxen], "What is Oxen?", { requireHsMetadata: true });
    const result = renderHsCodeAnswer(undefined, selection.ranked[0], [], { question: "What is Oxen?" });

    expect(selection.ranked[0].title).toBe("OXEN");
    expect(result.answer).toContain("HS Code: 0102.29.11");
    expect(result.answer).not.toContain("Chapter01.pdf");
  });

  it("rejects an irrelevant primary result and promotes a relevant secondary result", () => {
    const primary = sectionFixture({
      document: "Chapter03.pdf",
      hsCode: "0302.89.00",
      title: "FRESH FISH",
      section: "0302.89.00 - FRESH FISH",
      text: "Fresh fish for human consumption.",
      score: 20
    });
    const secondary = sectionFixture({
      document: "Chapter12.pdf",
      hsCode: "1211.90.95",
      title: "AGARWOOD CHIPS",
      section: "1211.90.95 - AGARWOOD CHIPS",
      text: "Agarwood chips are resinous fragrant wood pieces used for incense and perfume.",
      score: 2
    });
    const query = "Resinous fragrant wood chips used for incense belong to which code?";

    const selection = selectRelevantSections([primary, secondary], query, { requireHsMetadata: true });
    const primaryRelevance = evaluateCandidateRelevance(primary, query);

    expect(primaryRelevance.rejected).toBe(true);
    expect(selection.ranked[0].hsCode).toBe("1211.90.95");
  });

  it("repairs metadata consistency when LLM emits an unsupported HS code", () => {
    const section = sectionFixture({
      document: "Chapter12.pdf",
      hsCode: "1211.90.95",
      title: "AGARWOOD CHIPS",
      section: "1211.90.95 - AGARWOOD CHIPS",
      text: "Agarwood chips are resinous fragrant wood pieces."
    });

    const result = renderHsCodeAnswer("The product matches. HS Code: 9999.99.99.", section);

    expect(result.answer).toContain("HS Code: 1211.90.95");
    expect(result.answer).not.toContain("9999.99.99");
    expect(result.answerRepairApplied).toBe(true);
  });

  it("rejects candidates that only match generic chapter summary tokens", () => {
    const candidate = sectionFixture({
      document: "Chapter10.pdf",
      hsCode: "1001.99.11",
      title: "WHEAT",
      section: "1001.99.11 - WHEAT",
      text: "Chapter 10 content summary."
    });

    const relevance = evaluateCandidateRelevance(candidate, "chapter 10 nÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢i dung");

    expect(relevance.rejected).toBe(true);
    expect(relevance.rejectedReason).toContain("weak generic");
  });

  it("keeps exact HS code evidence strong even when token overlap is otherwise weak", () => {
    const candidate = sectionFixture({
      document: "Chapter10.pdf",
      hsCode: "1001.99.11",
      title: "WHEAT",
      section: "1001.99.11 - WHEAT",
      text: "Wheat and meslin."
    });

    const relevance = evaluateCandidateRelevance(candidate, "1001.99.11");

    expect(relevance.rejected).toBe(false);
    expect(relevance.matchedTerms).toContain("1001.99.11");
  });

  it("propagates page range across grouped section metadata", () => {
    const grouped: SectionMetadata[] = [
      {
        document: "Chapter02.pdf",
        hsCode: "0207.14.91",
        groupedHsCodes: ["0207.14.91", "0207.27.91"],
        title: "MECHANICALLY DEBONED OR SEPARATED MEAT",
        section: "0207.14.91 - MECHANICALLY DEBONED OR SEPARATED MEAT",
        pageStart: 4,
        pageEnd: 5
      },
      {
        document: "Chapter02.pdf",
        hsCode: "0207.27.91",
        groupedHsCodes: ["0207.14.91", "0207.27.91"],
        title: "MECHANICALLY DEBONED OR SEPARATED MEAT",
        section: "0207.27.91 - MECHANICALLY DEBONED OR SEPARATED MEAT"
      }
    ];

    const propagated = propagateGroupedSectionPageRanges(grouped);

    expect(propagated[1]?.pageStart).toBe(4);
    expect(propagated[1]?.pageEnd).toBe(5);
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
