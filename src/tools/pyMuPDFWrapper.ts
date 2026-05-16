import type { BoundingBox, ParsedBlock, ToolRuntimeOptions } from "../types";
import { runProcess } from "../utils/process";
import { resolvePythonCommand } from "../utils/paths";

const JSON_START = "__PDF_PIPELINE_JSON_START__";
const JSON_END = "__PDF_PIPELINE_JSON_END__";

export interface PyMuPDFLayoutPayload {
  pageCount: number;
  pages: PyMuPDFLayoutPage[];
}

export interface PyMuPDFLayoutPage {
  pageNumber: number;
  width: number;
  height: number;
  textBlocks: Array<{
    bbox: BoundingBox;
    text: string;
    lines: Array<{
      text: string;
      bbox: BoundingBox;
      fontSize?: number;
      font?: string;
      flags?: number;
    }>;
    avgFontSize?: number;
    maxFontSize?: number;
    fontNames?: string[];
    flags?: number;
  }>;
  imageBlocks: Array<{
    bbox: BoundingBox;
    width?: number;
    height?: number;
    xref?: number;
    softMaskXref?: number;
    hasAlpha?: boolean;
    extension?: string;
  }>;
  drawingBlocks: Array<{
    bbox: BoundingBox;
  }>;
  tableCandidates: Array<{
    bbox: BoundingBox;
    rowCount?: number;
    columnCount?: number;
  }>;
}

interface PyMuPDFMarkdownChunk {
  pageNumber: number;
  markdown: string;
  pageBoxes?: unknown[];
  metadata?: Record<string, unknown>;
}

export interface PyMuPDFConvertOptions extends ToolRuntimeOptions {
  ocrLanguage?: string;
}

export class PyMuPDFWrapper {
  public static async inspectLayout(
    pdfPath: string,
    options: ToolRuntimeOptions = {}
  ): Promise<PyMuPDFLayoutPayload> {
    return await runPythonJson<PyMuPDFLayoutPayload>(PYMUPDF_LAYOUT_SCRIPT, [pdfPath], options);
  }

  public static async convertPages(
    pdfPath: string,
    pageNumbers: number[],
    options: PyMuPDFConvertOptions = {}
  ): Promise<ParsedBlock[]> {
    if (pageNumbers.length === 0) {
      return [];
    }

    const pagesZeroBased = pageNumbers.map((pageNumber) => pageNumber - 1);
    const chunks = await runPythonJson<PyMuPDFMarkdownChunk[]>(
      PYMUPDF_MARKDOWN_SCRIPT,
      [pdfPath, JSON.stringify(pagesZeroBased), options.ocrLanguage ?? "eng"],
      options
    );

    return chunks.map((chunk, index) => ({
      id: `pymupdf-page-${chunk.pageNumber}-${index}`,
      type: "page",
      source: "pymupdf",
      pageNumber: chunk.pageNumber,
      order: chunk.pageNumber * 100000 + 50000 + index,
      markdown: chunk.markdown,
      metadata: {
        parser: "pymupdf4llm",
        routeMode: "fast",
        pageBoxes: chunk.pageBoxes ?? [],
        pymupdfMetadata: chunk.metadata ?? {}
      }
    }));
  }

  public static async extractPages(
    pdfPath: string,
    pageNumbers: number[],
    outputPath: string,
    options: ToolRuntimeOptions = {}
  ): Promise<void> {
    if (pageNumbers.length === 0) {
      throw new Error("Cannot extract an empty page list.");
    }

    await runPythonJson<{ outputPath: string }>(
      PYMUPDF_EXTRACT_PAGES_SCRIPT,
      [pdfPath, outputPath, JSON.stringify(pageNumbers)],
      options
    );
  }
}

async function runPythonJson<T>(
  script: string,
  args: string[],
  options: ToolRuntimeOptions = {}
): Promise<T> {
  const pythonCommand = resolvePythonCommand(options.pythonCommand);
  const result = await runProcess(pythonCommand, ["-c", script, ...args], {
    timeoutMs: options.timeoutMs ?? 10 * 60 * 1000,
    check: true
  });

  return parseJsonPayload<T>(result.stdout);
}

function parseJsonPayload<T>(stdout: string): T {
  const startIndex = stdout.indexOf(JSON_START);
  const endIndex = stdout.indexOf(JSON_END);

  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    throw new Error(`Python wrapper did not emit a JSON payload. Output: ${stdout.slice(0, 1000)}`);
  }

  const jsonText = stdout.slice(startIndex + JSON_START.length, endIndex).trim();
  return JSON.parse(jsonText) as T;
}

const PYTHON_JSON_HELPER = String.raw`
import json
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

def as_bbox(rect, page_number):
    return {
        "page": page_number,
        "x0": float(rect[0]),
        "y0": float(rect[1]),
        "x1": float(rect[2]),
        "y1": float(rect[3]),
    }
`;

const PYMUPDF_LAYOUT_SCRIPT = `${PYTHON_JSON_HELPER}
fitz = import_fitz()
pdf_path = sys.argv[1]
doc = fitz.open(pdf_path)
pages = []

for page_index, page in enumerate(doc):
    page_number = page_index + 1
    page_rect = page.rect
    raw = page.get_text("dict")
    image_info_by_xref = {}

    try:
        for image_info in page.get_images(full=True):
            xref = int(image_info[0]) if len(image_info) > 0 and image_info[0] else 0
            soft_mask = int(image_info[1]) if len(image_info) > 1 and image_info[1] else 0
            if xref:
                image_info_by_xref[xref] = {
                    "softMaskXref": soft_mask if soft_mask > 0 else None,
                    "hasAlpha": soft_mask > 0,
                }
    except Exception:
        image_info_by_xref = {}

    text_blocks = []
    image_blocks = []
    for block in raw.get("blocks", []):
        block_type = block.get("type")
        bbox = as_bbox(block.get("bbox", [0, 0, 0, 0]), page_number)

        if block_type == 0:
            lines = []
            font_sizes = []
            font_names = set()
            flags = []

            for line in block.get("lines", []):
                spans = line.get("spans", [])
                line_text = "".join(span.get("text", "") for span in spans).strip()
                if not line_text:
                    continue

                span_sizes = [float(span.get("size", 0)) for span in spans if span.get("size")]
                if span_sizes:
                    font_sizes.extend(span_sizes)
                for span in spans:
                    if span.get("font"):
                        font_names.add(str(span.get("font")))
                    if span.get("flags") is not None:
                        flags.append(int(span.get("flags")))

                lines.append({
                    "text": line_text,
                    "bbox": as_bbox(line.get("bbox", block.get("bbox", [0, 0, 0, 0])), page_number),
                    "fontSize": sum(span_sizes) / len(span_sizes) if span_sizes else None,
                    "font": spans[0].get("font") if spans else None,
                    "flags": spans[0].get("flags") if spans else None,
                })

            text = "\\n".join(line["text"] for line in lines).strip()
            if text:
                text_blocks.append({
                    "bbox": bbox,
                    "text": text,
                    "lines": lines,
                    "avgFontSize": sum(font_sizes) / len(font_sizes) if font_sizes else None,
                    "maxFontSize": max(font_sizes) if font_sizes else None,
                    "fontNames": sorted(font_names),
                    "flags": flags[0] if flags else None,
                })

        elif block_type == 1:
            xref = block.get("xref")
            xref_info = image_info_by_xref.get(int(xref), {}) if xref else {}
            image_blocks.append({
                "bbox": bbox,
                "width": block.get("width"),
                "height": block.get("height"),
                "xref": xref,
                "softMaskXref": xref_info.get("softMaskXref"),
                "hasAlpha": bool(xref_info.get("hasAlpha") or block.get("mask")),
                "extension": block.get("ext"),
            })

    drawing_blocks = []
    try:
        clusters = page.cluster_drawings()
        for cluster in clusters[:200]:
            if hasattr(cluster, "x0"):
                drawing_blocks.append({"bbox": as_bbox([cluster.x0, cluster.y0, cluster.x1, cluster.y1], page_number)})
            elif isinstance(cluster, (list, tuple)) and len(cluster) >= 4:
                drawing_blocks.append({"bbox": as_bbox(cluster[:4], page_number)})
    except Exception:
        try:
            for drawing in page.get_drawings()[:200]:
                rect = drawing.get("rect")
                if rect is not None:
                    drawing_blocks.append({"bbox": as_bbox([rect.x0, rect.y0, rect.x1, rect.y1], page_number)})
        except Exception:
            drawing_blocks = []

    table_candidates = []
    try:
        found_tables = page.find_tables()
        for table in getattr(found_tables, "tables", []):
            row_count = getattr(table, "row_count", None)
            col_count = getattr(table, "col_count", None)
            table_candidates.append({
                "bbox": as_bbox(table.bbox, page_number),
                "rowCount": row_count,
                "columnCount": col_count,
            })
    except Exception:
        table_candidates = []

    pages.append({
        "pageNumber": page_number,
        "width": float(page_rect.width),
        "height": float(page_rect.height),
        "textBlocks": text_blocks,
        "imageBlocks": image_blocks,
        "drawingBlocks": drawing_blocks,
        "tableCandidates": table_candidates,
    })

emit({"pageCount": len(doc), "pages": pages})
`;

const PYMUPDF_MARKDOWN_SCRIPT = `${PYTHON_JSON_HELPER}
pdf_path = sys.argv[1]
pages = json.loads(sys.argv[2])
ocr_language = sys.argv[3]

try:
    import pymupdf4llm
except Exception as exc:
    raise RuntimeError("pymupdf4llm is not installed. Install it with: pip install pymupdf4llm") from exc

kwargs = {
    "pages": pages,
    "page_chunks": True,
    "write_images": False,
    "embed_images": False,
    "use_ocr": False,
    "force_ocr": False,
    "ocr_language": ocr_language,
    "page_separators": False,
    "show_progress": False,
}

try:
    chunks = pymupdf4llm.to_markdown(pdf_path, **kwargs)
except TypeError:
    for optional_key in ["use_ocr", "force_ocr", "ocr_language", "page_separators", "show_progress"]:
        kwargs.pop(optional_key, None)
    chunks = pymupdf4llm.to_markdown(pdf_path, **kwargs)

if isinstance(chunks, str):
    chunks = [{"text": chunks, "metadata": {}}]

result = []
for index, chunk in enumerate(chunks):
    metadata = chunk.get("metadata", {}) if isinstance(chunk, dict) else {}
    candidate_page = metadata.get("page_number", metadata.get("page"))
    fallback_page_zero = pages[min(index, len(pages) - 1)] if pages else index

    if isinstance(candidate_page, int) and candidate_page in pages:
        page_number = candidate_page + 1
    elif isinstance(candidate_page, int) and (candidate_page - 1) in pages:
        page_number = candidate_page
    else:
        page_number = fallback_page_zero + 1

    result.append({
        "pageNumber": page_number,
        "markdown": chunk.get("text", "") if isinstance(chunk, dict) else str(chunk),
        "pageBoxes": chunk.get("page_boxes", []) if isinstance(chunk, dict) else [],
        "metadata": metadata,
    })

emit(result)
`;

const PYMUPDF_EXTRACT_PAGES_SCRIPT = `${PYTHON_JSON_HELPER}
fitz = import_fitz()
pdf_path = sys.argv[1]
output_path = sys.argv[2]
page_numbers = json.loads(sys.argv[3])

src = fitz.open(pdf_path)
dst = fitz.open()

for page_number in page_numbers:
    page_index = int(page_number) - 1
    if page_index < 0 or page_index >= len(src):
        raise ValueError(f"Page number out of range: {page_number}")
    dst.insert_pdf(src, from_page=page_index, to_page=page_index)

dst.save(output_path, garbage=4, deflate=True)
dst.close()
src.close()
emit({"outputPath": output_path})
`;
