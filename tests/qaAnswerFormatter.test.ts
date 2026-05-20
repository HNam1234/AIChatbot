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
    expect(result.answer).toContain("depending on the product state");
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

  it("expands Cambodia fragrant rice queries to curated Malys aliases only inside the rice scope", () => {
    const query = "Một loại gạo thơm của Cambodia, có hạt dài, mùi thơm tự nhiên và thường được gọi là premium fragrant rice. HS Code đúng là gì?";
    const signals = extractQuerySignals(query);
    const unrelatedSignals = extractQuerySignals("Cambodia agarwood chips");

    expect(signals.originTerms).toContain("cambodia");
    expect(signals.domainAliasTerms).toContain("malys rice");
    expect(signals.domainAliasTerms).toContain("malys angkor");
    expect(unrelatedSignals.domainAliasTerms).not.toContain("malys rice");
    expect(unrelatedSignals.domainAliasTerms).toEqual([]);
  });

  it("promotes Malys rice over generic other fragrant rice when Cambodia rice aliases match", () => {
    const query = "Một loại gạo thơm của Cambodia, có hạt dài, mùi thơm tự nhiên và thường được gọi là premium fragrant rice. HS Code đúng là gì?";
    const malys = sectionFixture({
      document: "Chapter10.pdf",
      hsCode: "1006.30.60",
      title: "MALYS RICE",
      section: "1006.30.60 - MALYS RICE",
      text: "Malys rice, also known as Malys Angkor rice, refers to premium aromatic rice varieties. The kernel is extra-long and has a strong natural unique scent. Varieties include Phka Rumduol, Phka Rumdeng, Phka Romeat and Somaly.",
      score: 2
    });
    const otherFragrant = sectionFixture({
      document: "Chapter10.pdf",
      hsCode: "1006.30.70",
      title: "OTHER FRAGRANT RICE",
      section: "1006.30.70 - OTHER FRAGRANT RICE",
      text: "Fragrant rice, also known as aromatic rice, is a type of premium rice which has a natural fragrance and a medium to long grain shape.",
      score: 30
    });
    const basmati = sectionFixture({
      document: "Chapter10.pdf",
      hsCode: "1006.30.50",
      title: "BASMATI RICE",
      section: "1006.30.50 - BASMATI RICE",
      text: "Basmati rice is a long slender-grained fragrant rice with distinctive fragrance.",
      score: 12
    });

    const selection = selectRelevantSections([otherFragrant, basmati, malys], query, { requireHsMetadata: true });
    const selectedRelevance = evaluateCandidateRelevance(selection.ranked[0], query, selection.signals);
    const selectedCandidate = selection.candidates.find((candidate) => candidate.hsCode === "1006.30.60");
    const answer = renderHsCodeAnswer(undefined, selection.ranked[0], [], { question: query });

    expect(selection.ranked[0].title).toBe("MALYS RICE");
    expect(selectedRelevance.candidateAliasSignals).toContain("malys rice");
    expect(selectedCandidate?.validation?.strongSignals).toContain("country_product_alias_match");
    expect(answer.finalHsCodes).toEqual(["1006.30.60"]);
    expect(answer.answer).toContain("HS Code: 1006.30.60");
  });

  it("keeps generic and Thailand fragrant rice queries out of the Cambodia Malys alias path", () => {
    const malys = sectionFixture({
      document: "Chapter10.pdf",
      hsCode: "1006.30.60",
      title: "MALYS RICE",
      section: "1006.30.60 - MALYS RICE",
      text: "Malys rice, also known as Malys Angkor rice, is premium aromatic rice with extra-long kernels.",
      score: 2
    });
    const otherFragrant = sectionFixture({
      document: "Chapter10.pdf",
      hsCode: "1006.30.70",
      title: "OTHER FRAGRANT RICE",
      section: "1006.30.70 - OTHER FRAGRANT RICE",
      text: "Fragrant rice, also known as aromatic rice, is a type of premium fragrant rice with a natural fragrance.",
      score: 2
    });
    const homMali = sectionFixture({
      document: "Chapter10.pdf",
      hsCode: "1006.30.40",
      title: "HOM MALI RICE",
      section: "1006.30.40 - HOM MALI RICE",
      text: "Hom Mali rice, also known as Thai Hom Mali rice, means non-glutinous fragrant rice varieties with long grain kernels.",
      source: "Thailand",
      score: 2
    });

    const genericSelection = selectRelevantSections([malys, otherFragrant], "premium fragrant rice HS Code?", { requireHsMetadata: true });
    const thaiSelection = selectRelevantSections([malys, homMali], "Thai Hom Mali fragrant rice long grain HS Code?", { requireHsMetadata: true });

    expect(extractQuerySignals("premium fragrant rice HS Code?").domainAliasTerms).toEqual([]);
    expect(genericSelection.ranked[0].title).toBe("OTHER FRAGRANT RICE");
    expect(extractQuerySignals("Thai Hom Mali fragrant rice long grain HS Code?").domainAliasTerms).toEqual([]);
    expect(thaiSelection.ranked[0].title).toBe("HOM MALI RICE");
  });

  it("uses Vietnamese potato description aliases to select chipping potatoes", () => {
    const query = "Mot cong ty san xuat snack nhap khau lo khoai tay co hinh dang tron tria, ham luong duong rat thap khi chien co mau vang nhat. Lo hang nay ap ma HS nao?";
    const chippingPotatoes = sectionFixture({
      document: "Chapter07.pdf",
      hsCode: "0701.90.10",
      title: "CHIPPING POTATOES",
      section: "0701.90.10 - CHIPPING POTATOES",
      text: "Chipping potatoes are tubers grown for potato chip makers. Tubers are round, have low sugar content and fry to a light color.",
      score: 2
    });
    const roundCabbage = sectionFixture({
      document: "Chapter07.pdf",
      hsCode: "0704.90.10",
      title: "ROUND (DRUMHEAD) CABBAGES",
      section: "0704.90.10 - ROUND (DRUMHEAD) CABBAGES",
      text: "Round cabbage has a compact round head.",
      score: 20
    });

    const selection = selectRelevantSections([roundCabbage, chippingPotatoes], query, { requireHsMetadata: true });

    expect(extractQuerySignals(query).domainAliasTerms).toContain("chipping potatoes");
    expect(selection.ranked[0]).toMatchObject({ hsCode: "0701.90.10", title: "CHIPPING POTATOES" });
    expect(selection.candidates.find((candidate) => candidate.hsCode === "0701.90.10")?.validation?.accepted).toBe(true);
  });

  it("uses Vietnamese swim-bladder description aliases to keep fish maws despite numeric evidence", () => {
    const query = "Duoc lieu kho 1 den 3 nam mau nau sam it trong suot la co quan noi tang chua khi cua loai ca giup duy tri suc noi. Co quan nay la gi va ma HS cua no?";
    const fishMaws = sectionFixture({
      document: "Chapter03.pdf",
      hsCode: "0305.72.19",
      groupedHsCodes: ["0305.72.11", "0305.72.19"],
      title: "FISH MAWS",
      section: "0305.72.19 - FISH MAWS",
      text: "Fish maws are swim bladders, an internal gas-filled organ that helps fish maintain buoyancy. Dried fish maws may be stored 1 to 3 years and become dark brown with many wrinkles.",
      score: 2
    });
    const unrelatedNumeric = sectionFixture({
      document: "Chapter06.pdf",
      hsCode: "0602.90.50",
      title: "SEEDLINGS",
      section: "0602.90.50 - SEEDLINGS",
      text: "Seedlings have roots 1 to 3 cm long.",
      score: 40
    });

    const selection = selectRelevantSections([unrelatedNumeric, fishMaws], query, { requireHsMetadata: true });
    const fishMawCandidate = selection.candidates.find((candidate) => candidate.hsCode === "0305.72.19");

    expect(extractQuerySignals(query).domainAliasTerms).toContain("swim bladder");
    expect(selection.ranked[0]).toMatchObject({ hsCode: "0305.72.19", title: "FISH MAWS" });
    expect(fishMawCandidate?.validation?.accepted).toBe(true);
    expect(fishMawCandidate?.validation?.reason).not.toContain("numeric evidence is not supported");
  });

  it("normalizes Vietnamese d-stroke before alias extraction", () => {
    const query = "M\u00e3 HS c\u1ee7a khoai t\u00e2y chi\u00ean c\u00f3 h\u00e0m l\u01b0\u1ee3ng \u0111\u01b0\u1eddng r\u1ea5t th\u1ea5p?";

    expect(extractQuerySignals(query).domainAliasTerms).toEqual(expect.arrayContaining([
      "chipping potatoes",
      "low sugar"
    ]));
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

  it("keeps comparison baselines out of positive query signals", () => {
    const contrast = detectContrastTerms("Which coffee is more bitter than Arabica and has higher caffeine?");
    const signals = extractQuerySignals("Which coffee is more bitter than Arabica and has higher caffeine?");

    expect(contrast.baselineTokens).toEqual(["arabica"]);
    expect(signals.queryTokens).toContain("bitter");
    expect(signals.queryTokens).toContain("high");
    expect(signals.queryTokens).toContain("caffeine");
    expect(signals.queryTokens).not.toContain("arabica");
    expect(signals.scientificNames).toEqual([]);
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
    expect(result.answer).toContain("depending on the product state in the tariff");
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
