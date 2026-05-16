import { describe, expect, it } from "vitest";
import type { SectionMapResult } from "../src/types";
import { TreeValidator } from "../src/validators/treeValidator";

describe("TreeValidator", () => {
  it("passes marker 10 when tree nodes reconcile with Markdown H1/H2 headings", () => {
    const markdown = [
      "# CHAPTER 12",
      "",
      "## 1207.10.10 — PALM NUTS SUITABLE FOR SOWING/PLANTING",
      "",
      "## 1211.90.13 — RAUWOLFIA SERPENTINA ROOTS"
    ].join("\n");
    const tree = [
      {
        title: "CHAPTER 12",
        node_id: "0000",
        summary: "Chapter summary",
        nodes: [
          {
            title: "1207.10.10 — PALM NUTS SUITABLE FOR SOWING/PLANTING",
            node_id: "0001",
            summary: "Palm nuts section"
          },
          {
            title: "1211.90.13 — RAUWOLFIA SERPENTINA ROOTS",
            node_id: "0002",
            summary: "Rauwolfia section"
          }
        ]
      }
    ];

    const report = TreeValidator.validate(markdown, tree, {
      docId: "pi-test",
      sectionMap: sectionMap(["1207.10.10", "1211.90.13"])
    });

    expect(report.passed).toBe(true);
    expect(report.markers[0]?.marker).toBe("MARKER 10");
    expect(report.markers[0]?.details?.treeMatchedHSCodeCount).toBe(2);
  });

  it("passes marker 10 for actual PageIndex response shape", () => {
    const markdown = [
      "# CHAPTER 12",
      "",
      "## 1207.10.10 — PALM NUTS SUITABLE FOR SOWING/PLANTING",
      "",
      "## 1211.90.13 — RAUWOLFIA SERPENTINA ROOTS"
    ].join("\n");
    const payload = {
      tree: [
        {
          title: "CHAPTER 12",
          node_id: "0000",
          text: "# CHAPTER 12",
          prefix_summary: "# CHAPTER 12",
          nodes: [
            {
              title: "1207.10.10 — PALM NUTS SUITABLE FOR SOWING/PLANTING",
              node_id: "0001",
              text: "## 1207.10.10 — PALM NUTS SUITABLE FOR SOWING/PLANTING",
              summary: "Palm nuts summary"
            },
            {
              title: "1211.90.13 — RAUWOLFIA SERPENTINA ROOTS",
              node_id: "0002",
              text: "## 1211.90.13 — RAUWOLFIA SERPENTINA ROOTS",
              summary: "Rauwolfia summary"
            }
          ]
        }
      ],
      rawResponse: {
        structure: []
      }
    };

    const report = TreeValidator.validate(markdown, payload, {
      sectionMap: sectionMap(["1207.10.10", "1211.90.13"])
    });
    const details = report.markers[0]?.details;

    expect(report.passed).toBe(true);
    expect(details?.expectedHsCodes).toEqual(["1207.10.10", "1211.90.13"]);
    expect(details?.detectedHsCodesInTree).toEqual(["1207.10.10", "1211.90.13"]);
    expect(details?.missingHsCodesInTree).toEqual([]);
    expect(details?.idFieldNamesDetected).toEqual(["node_id"]);
    expect(details?.summaryFieldNamesDetected).toEqual(["prefix_summary", "summary"]);
    expect(details?.childFieldNamesDetected).toEqual(["nodes"]);
  });

  it("passes marker 10 with warning when a matched HS node has no summary", () => {
    const markdown = ["# CHAPTER 7", "", "## 0701.90.10 — CHIPPING POTATOES"].join("\n");
    const payload = {
      rawResponse: {
        structure: [
          {
            title: "CHAPTER 7",
            uid: "chapter",
            children: [
              {
                title: "0701.90.10 — CHIPPING POTATOES",
                uid: "hs-1",
                text: "## 0701.90.10 — CHIPPING POTATOES"
              }
            ]
          }
        ]
      }
    };

    const report = TreeValidator.validate(markdown, payload, {
      sectionMap: sectionMap(["0701.90.10"])
    });

    expect(report.passed).toBe(true);
    expect(report.warnings?.some((warning) => warning.includes("0701.90.10"))).toBe(true);
    expect(report.markers[0]?.details?.idFieldNamesDetected).toEqual(["uid"]);
    expect(report.markers[0]?.details?.childFieldNamesDetected).toEqual(["children"]);
  });

  it("passes marker 10 for non-HS reference documents without HS section-map entries", () => {
    const markdown = ["# Introduction", "", "This reference document has no HS code sections."].join("\n");
    const tree = [
      {
        title: "Introduction",
        node_id: "intro",
        summary: "Introduction summary"
      }
    ];
    const report = TreeValidator.validate(markdown, tree, {
      sectionMap: {
        document: "Introduction.pdf",
        documentType: "non-hs-reference",
        sections: [],
        warnings: []
      }
    });
    const details = report.markers[0]?.details;

    expect(report.passed).toBe(true);
    expect(details?.documentType).toBe("non-hs-reference");
    expect(details?.sectionMapHSCodeCount).toBe(0);
    expect(details?.nodeWithIdCount).toBe(1);
    expect(details?.nodeWithSummaryCount).toBe(1);
  });

  it("fails marker 10 when an HS heading is missing from the tree", () => {
    const markdown = [
      "# CHAPTER 7",
      "",
      "## 0701.90.10 — CHIPPING POTATOES",
      "",
      "## 0704.90.10 — ROUND (DRUMHEAD) CABBAGES"
    ].join("\n");
    const tree = [
      {
        title: "CHAPTER 7",
        node_id: "0000",
        summary: "Chapter summary",
        nodes: [
          {
            title: "0701.90.10 — CHIPPING POTATOES",
            node_id: "0001"
          }
        ]
      }
    ];

    const report = TreeValidator.validate(markdown, tree, {
      sectionMap: sectionMap(["0701.90.10", "0704.90.10"])
    });

    expect(report.passed).toBe(false);
    expect(report.errors[0]).toContain("Marker 10 Failed");
    expect(report.markers[0]?.details?.treeMatchedHSCodeCount).toBe(1);
  });
});

function sectionMap(hsCodes: string[]): SectionMapResult {
  return {
    document: "test.pdf",
    warnings: [],
    sections: hsCodes.map((hsCode, index) => ({
      document: "test.pdf",
      chapter: "CHAPTER",
      hsCode,
      title: "TITLE",
      section: `${hsCode} — TITLE`,
      pageStart: index + 1,
      pageEnd: index + 1,
      source: null,
      markdownHeading: `## ${hsCode} — TITLE`,
      textPreview: "Preview"
    }))
  };
}
