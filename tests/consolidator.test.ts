import { describe, expect, it } from "vitest";
import { Consolidator } from "../src/orchestrator/consolidator";
import { MarkdownValidator } from "../src/validators/markdownValidator";

describe("Consolidator", () => {
  it("normalizes simple broken markdown tables before marker validation", () => {
    const markdown = Consolidator.merge(
      [
        {
          id: "page-1",
          type: "page",
          source: "pymupdf",
          pageNumber: 1,
          order: 1,
          markdown: ["# Doc", "", "| A | B |", "| --- | --- |", "| 1 |"].join("\n"),
          metadata: {}
        }
      ],
      { ensureDocumentHeader: true }
    );

    expect(markdown).toContain("| 1 |  |");
    expect(MarkdownValidator.validatePhase1Detailed(markdown, []).passed).toBe(true);
  });
});
