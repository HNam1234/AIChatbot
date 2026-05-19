import { describe, expect, it } from "vitest";
import { selectRelevantSections, type EnrichedRetrievedSection, type SectionMetadata } from "../src/agent/qaAnswerFormatter";
import { hydrateSectionsForSearch } from "../src/server/routes";
import type { QaDocumentMetadata } from "../src/agent/qaIntentRouter";

describe("QA search hydration", () => {
  it("hydrates full Markdown section bodies before relevance ranking", () => {
    const metadata: SectionMetadata[] = [
      {
        document: "Hydration.pdf",
        hsCode: "1111.11.11",
        title: "TARGET MATERIAL",
        section: "1111.11.11 - TARGET MATERIAL",
        markdownHeading: "## 1111.11.11 - TARGET MATERIAL",
        textPreview: "Short preview without the rare hydrated evidence."
      },
      {
        document: "Hydration.pdf",
        hsCode: "2222.22.22",
        title: "DECOY MATERIAL",
        section: "2222.22.22 - DECOY MATERIAL",
        markdownHeading: "## 2222.22.22 - DECOY MATERIAL",
        textPreview: "Decoy material has generic catalog wording."
      }
    ];
    const documents: QaDocumentMetadata[] = [{
      document: "Hydration.pdf",
      markdownText: [
        "# CHAPTER X",
        "## 1111.11.11 - TARGET MATERIAL",
        "Target material contains rarehydrated fiber and moisture 12% after processing.",
        "## 2222.22.22 - DECOY MATERIAL",
        "Decoy material has generic catalog wording."
      ].join("\n")
    }];
    const sections = metadata.map((section, index) => retrievedFixture(section, index === 0 ? 1 : 60));

    const hydrated = hydrateSectionsForSearch(sections, metadata, documents);
    const selection = selectRelevantSections(hydrated, "rarehydrated fiber moisture 12%", {
      requireHsMetadata: true
    });

    expect(hydrated[0].hydrationSource).toBe("markdown");
    expect(hydrated[0].text).toContain("rarehydrated fiber");
    expect(selection.ranked[0]?.hsCode).toBe("1111.11.11");
  });
});

function retrievedFixture(section: SectionMetadata, score: number): EnrichedRetrievedSection {
  return {
    document: section.document,
    hsCode: section.hsCode,
    groupedHsCodes: section.groupedHsCodes ?? [],
    title: section.title,
    section: section.section,
    text: section.textPreview ?? "",
    captions: [],
    score,
    metadataWarnings: []
  };
}
