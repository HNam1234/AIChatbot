import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { imageToPdf } from "../src/documents.js";

let tmpDir: string | undefined;

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe("imageToPdf", () => {
  it("converts an image into a PDF", async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "pageindex-chatbot-"));
    const imagePath = path.join(tmpDir, "graph.png");
    await writeFile(imagePath, await sharp({ create: {
      width: 64,
      height: 64,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 0.5 }
    } }).png().toBuffer());

    const pdfPath = await imageToPdf(imagePath, path.join(tmpDir, "converted"));
    const pdf = await readFile(pdfPath);

    expect(pdfPath.endsWith(".pdf")).toBe(true);
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  });
});
