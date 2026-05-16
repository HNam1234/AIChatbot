import { describe, expect, it } from "vitest";
import { buildToolArguments, extractRelevantSnippet, extractToolText, selectTool } from "../src/agent/mcpClient";

describe("PageIndex MCP helpers", () => {
  it("selects the preferred tree search tool when available", () => {
    const tool = selectTool([
      toolInfo("pageindex_get_document_structure", ["docName"]),
      toolInfo("pageindex_tree_search", ["doc_id", "query"])
    ]);

    expect(tool?.name).toBe("pageindex_tree_search");
  });

  it("builds arguments from MCP input schema properties", () => {
    const args = buildToolArguments(toolInfo("pageindex_tree_search", ["doc_id", "query"]), {
      docId: "doc-1",
      query: "round cabbage"
    });

    expect(args).toEqual({
      doc_id: "doc-1",
      query: "round cabbage"
    });
  });

  it("extracts text content from MCP tool results", () => {
    const text = extractToolText({
      content: [
        { type: "text", text: "first" },
        { type: "resource", resource: { uri: "file://x", text: "second" } }
      ]
    });

    expect(text).toBe("first\nsecond");
  });

  it("keeps relevant snippets within the requested budget", () => {
    const source = `${"a".repeat(200)} round cabbage ${"b".repeat(200)}`;
    const snippet = extractRelevantSnippet(source, "round cabbage", 80);

    expect(snippet.length).toBeLessThanOrEqual(80);
    expect(snippet).toContain("round cabbage");
  });
});

function toolInfo(name: string, properties: string[], required = properties) {
  return {
    name,
    inputSchema: {
      type: "object" as const,
      properties: Object.fromEntries(properties.map((property) => [property, {}])),
      required
    }
  };
}
