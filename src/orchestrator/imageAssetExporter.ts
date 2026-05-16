import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { ParsedBlock, ToolRuntimeOptions } from "../types";
import { resolvePythonCommand } from "../utils/paths";
import { runProcess } from "../utils/process";

const JSON_START = "__PDF_PIPELINE_JSON_START__";
const JSON_END = "__PDF_PIPELINE_JSON_END__";

export interface ImageAssetExporterOptions extends ToolRuntimeOptions {
  assetsDir: string;
  markdownDir: string;
}

interface ExportRequest {
  id: string;
  pageNumber: number;
  bbox: {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  };
  outputPath: string;
}

interface ExportResult {
  id: string;
  outputPath: string;
  width: number;
  height: number;
}

export class ImageAssetExporter {
  public static async exportAssets(
    pdfPath: string,
    blocks: ParsedBlock[],
    options: ImageAssetExporterOptions
  ): Promise<ParsedBlock[]> {
    const imageBlocks = blocks.filter(isExportableImageBlock);
    if (imageBlocks.length === 0) {
      return blocks;
    }

    const pdfName = path.basename(pdfPath, path.extname(pdfPath));
    const imageOutputDir = path.resolve(options.assetsDir, pdfName);
    await mkdir(imageOutputDir, { recursive: true });

    const requests = imageBlocks.map<ExportRequest>((block) => ({
      id: block.id,
      pageNumber: block.pageNumber,
      bbox: {
        x0: block.bbox!.x0,
        y0: block.bbox!.y0,
        x1: block.bbox!.x1,
        y1: block.bbox!.y1
      },
      outputPath: path.join(imageOutputDir, `${safeFileName(block.id)}.png`)
    }));

    const results = await runCropExport(pdfPath, requests, options);
    const byId = new Map(results.map((result) => [result.id, result]));

    return blocks.map((block) => {
      const result = byId.get(block.id);
      if (!result) {
        return block;
      }

      const absolutePath = path.resolve(result.outputPath);
      const relativePath = normalizeMarkdownPath(path.relative(options.markdownDir, absolutePath));
      return {
        ...block,
        metadata: {
          ...(block.metadata ?? {}),
          assetPath: relativePath,
          assetAbsolutePath: absolutePath,
          assetWidth: result.width,
          assetHeight: result.height,
          assetExporter: "pymupdf-crop"
        }
      };
    });
  }
}

function isExportableImageBlock(block: ParsedBlock): boolean {
  return (
    block.type === "image" &&
    Boolean(block.bbox) &&
    block.metadata?.decorative !== true &&
    block.metadata?.duplicateOf === undefined
  );
}

async function runCropExport(
  pdfPath: string,
  requests: ExportRequest[],
  options: ToolRuntimeOptions
): Promise<ExportResult[]> {
  const pythonCommand = resolvePythonCommand(options.pythonCommand);
  const result = await runProcess(
    pythonCommand,
    ["-c", PYMUPDF_CROP_EXPORT_SCRIPT, pdfPath, JSON.stringify(requests)],
    {
      timeoutMs: options.timeoutMs ?? 10 * 60 * 1000,
      check: true,
      maxBufferBytes: 64 * 1024 * 1024
    }
  );

  return parseJsonPayload<ExportResult[]>(result.stdout);
}

function parseJsonPayload<T>(stdout: string): T {
  const startIndex = stdout.indexOf(JSON_START);
  const endIndex = stdout.indexOf(JSON_END);

  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    throw new Error(`Image asset exporter did not emit JSON. Output: ${stdout.slice(0, 1000)}`);
  }

  return JSON.parse(stdout.slice(startIndex + JSON_START.length, endIndex).trim()) as T;
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "image";
}

function normalizeMarkdownPath(value: string): string {
  return value.split(path.sep).join("/");
}

const PYMUPDF_CROP_EXPORT_SCRIPT = String.raw`
import json
import os
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

JSON_START = "__PDF_PIPELINE_JSON_START__"
JSON_END = "__PDF_PIPELINE_JSON_END__"

def emit(payload):
    print(JSON_START)
    print(json.dumps(payload, ensure_ascii=False))
    print(JSON_END)

def import_fitz():
    try:
        import fitz
        return fitz
    except Exception:
        import pymupdf
        return pymupdf

fitz = import_fitz()
pdf_path = sys.argv[1]
requests = json.loads(sys.argv[2])
doc = fitz.open(pdf_path)
results = []

for request in requests:
    page_index = int(request["pageNumber"]) - 1
    if page_index < 0 or page_index >= len(doc):
        continue

    page = doc[page_index]
    box = request["bbox"]
    rect = fitz.Rect(float(box["x0"]), float(box["y0"]), float(box["x1"]), float(box["y1"]))
    rect = rect & page.rect
    if rect.is_empty or rect.width <= 1 or rect.height <= 1:
        continue

    output_path = request["outputPath"]
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    pix = page.get_pixmap(matrix=fitz.Matrix(2, 2), clip=rect, alpha=False)
    pix.save(output_path)
    results.append({
        "id": request["id"],
        "outputPath": output_path,
        "width": int(pix.width),
        "height": int(pix.height),
    })

doc.close()
emit(results)
`;
