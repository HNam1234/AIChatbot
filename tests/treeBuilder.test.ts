import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TreeBuilder } from "../src/orchestrator/treeBuilder";

describe("TreeBuilder cache", () => {
  it("loads cached PageIndex tree data with doc id", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tree-cache-"));
    try {
      const markdownPath = path.join(dir, "Chapter01.milestone1.md");
      const treePath = path.join(dir, "Chapter01.tree.json");
      writeFileSync(markdownPath, "# CHAPTER 1\n", "utf8");
      writeFileSync(
        treePath,
        JSON.stringify({
          docId: "doc-cached",
          tree: [{ title: "CHAPTER 1", node_id: "0001" }],
          rawResponse: { status: "completed" }
        }),
        "utf8"
      );

      const cached = await TreeBuilder.loadCached(markdownPath, treePath);

      expect(cached?.fromCache).toBe(true);
      expect(cached?.docId).toBe("doc-cached");
      expect(cached?.treeData).toEqual([{ title: "CHAPTER 1", node_id: "0001" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still reuses cached tree when stored markdown hash does not match", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tree-cache-"));
    try {
      const markdownPath = path.join(dir, "Chapter01.milestone1.md");
      const treePath = path.join(dir, "Chapter01.tree.json");
      writeFileSync(markdownPath, "# New content\n", "utf8");
      writeFileSync(
        treePath,
        JSON.stringify({
          docId: "doc-stale",
          tree: [{ title: "CHAPTER 1", node_id: "0001" }],
          cache: {
            sourceMarkdownSha256: sha256("# Old content\n")
          }
        }),
        "utf8"
      );

      const cached = await TreeBuilder.loadCached(markdownPath, treePath);

      expect(cached?.fromCache).toBe(true);
      expect(cached?.docId).toBe("doc-stale");
      expect(cached?.cacheWarnings).toContain("cached-tree-markdown-hash-differs");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
