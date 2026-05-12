import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import { PDFDocument } from "pdf-lib";
import sharp from "sharp";

export const PDF_EXTENSIONS = new Set([".pdf"]);
export const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"]);
export const SUPPORTED_EXTENSIONS = new Set([...PDF_EXTENSIONS, ...IMAGE_EXTENSIONS]);

export class UnsupportedDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedDocumentError";
  }
}

export function assertSupported(filePath: string): void {
  const extension = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    throw new UnsupportedDocumentError(
      `Unsupported input type '${extension}'. Use one of: ${Array.from(SUPPORTED_EXTENSIONS).sort().join(", ")}`
    );
  }
}

export async function stableFileName(filePath: string, originalName?: string): Promise<string> {
  const sourceName = originalName ?? path.basename(filePath);
  const parsed = path.parse(sourceName);
  const file = await readFile(filePath);
  const digest = createHash("sha256").update(file).digest("hex").slice(0, 12);
  const safeStem = parsed.name.replace(/[^a-z0-9_-]/gi, "_");
  return `${safeStem}-${digest}${parsed.ext.toLowerCase()}`;
}

export async function copyToUploads(
  filePath: string,
  uploadDir: string,
  originalName?: string
): Promise<string> {
  assertSupported(originalName ?? filePath);
  await mkdir(uploadDir, { recursive: true });
  const target = path.join(uploadDir, await stableFileName(filePath, originalName));
  if (path.resolve(filePath) !== path.resolve(target)) {
    await copyFile(filePath, target);
  }
  return target;
}

export async function prepareForPageIndex(filePath: string, convertedDir: string): Promise<string> {
  assertSupported(filePath);
  if (PDF_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    return filePath;
  }
  return imageToPdf(filePath, convertedDir);
}

export async function imageToPdf(filePath: string, convertedDir: string): Promise<string> {
  await mkdir(convertedDir, { recursive: true });
  const file = await readFile(filePath);
  const digest = createHash("sha256").update(file).digest("hex").slice(0, 12);
  const pdfPath = path.join(convertedDir, `${path.parse(filePath).name}-${digest}.pdf`);

  const image = sharp(file, { animated: false }).rotate().flatten({ background: "#ffffff" });
  const metadata = await image.metadata();
  const png = await image.png().toBuffer();
  const width = metadata.width ?? 1;
  const height = metadata.height ?? 1;

  const pdf = await PDFDocument.create();
  const page = pdf.addPage([width, height]);
  const embeddedImage = await pdf.embedPng(png);
  page.drawImage(embeddedImage, { x: 0, y: 0, width, height });
  const pdfBytes = await pdf.save();
  await writeFile(pdfPath, pdfBytes);
  return pdfPath;
}
