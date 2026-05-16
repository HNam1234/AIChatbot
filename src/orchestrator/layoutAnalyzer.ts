import type {
  BoundingBox,
  LayoutAnalysis,
  LayoutDrawingBlock,
  LayoutImageBlock,
  LayoutTableCandidate,
  LayoutTextBlock,
  PageLayout,
  ToolRuntimeOptions
} from "../types";
import { bboxArea, bboxCenter, distanceBetweenBoxes, expandBox, intersects, unionBox } from "../utils/geometry";
import { PyMuPDFWrapper, type PyMuPDFLayoutPage } from "../tools/pyMuPDFWrapper";

export interface LayoutAnalyzerOptions extends ToolRuntimeOptions {
  scanTextCharacterThreshold?: number;
  scanImageCoverageThreshold?: number;
  minTableRows?: number;
  minTableColumns?: number;
}

export class LayoutAnalyzer {
  public static async analyze(pdfPath: string, options: LayoutAnalyzerOptions = {}): Promise<LayoutAnalysis> {
    const payload = await PyMuPDFWrapper.inspectLayout(pdfPath, options);
    const pages = payload.pages.map((page) => this.enrichPageLayout(page, options));

    return {
      pdfPath,
      pageCount: payload.pageCount,
      pages
    };
  }

  private static enrichPageLayout(page: PyMuPDFLayoutPage, options: LayoutAnalyzerOptions): PageLayout {
    const pageArea = Math.max(1, page.width * page.height);
    const textBlocks = page.textBlocks.map<LayoutTextBlock>((block, index) => ({
      id: `layout-text-p${page.pageNumber}-${index}`,
      pageNumber: page.pageNumber,
      order: index,
      bbox: block.bbox,
      text: block.text,
      lines: block.lines,
      avgFontSize: block.avgFontSize,
      maxFontSize: block.maxFontSize,
      fontNames: block.fontNames,
      flags: block.flags
    }));

    const imageBlocks = page.imageBlocks.map<LayoutImageBlock>((block, index) => {
      const areaRatio = bboxArea(block.bbox) / pageArea;
      return {
        id: `layout-image-p${page.pageNumber}-${index}`,
        pageNumber: page.pageNumber,
        order: index,
        bbox: block.bbox,
        width: block.width,
        height: block.height,
        xref: block.xref,
        softMaskXref: block.softMaskXref,
        hasAlpha: block.hasAlpha,
        extension: block.extension,
        areaRatio,
        decorative: isDecorativeImage(block.bbox, areaRatio, page.height)
      };
    });

    const drawingBlocks = page.drawingBlocks.map<LayoutDrawingBlock>((block, index) => ({
      id: `layout-drawing-p${page.pageNumber}-${index}`,
      pageNumber: page.pageNumber,
      order: index,
      bbox: block.bbox
    }));

    const explicitTables = page.tableCandidates.map<LayoutTableCandidate>((candidate, index) => ({
      id: `layout-table-p${page.pageNumber}-explicit-${index}`,
      pageNumber: page.pageNumber,
      order: index,
      bbox: candidate.bbox,
      rowCount: candidate.rowCount,
      columnCount: candidate.columnCount,
      confidence: 0.95,
      reason: "pymupdf-find-tables"
    }));

    const inferredTables = inferTableCandidates(page.pageNumber, textBlocks, drawingBlocks, options);
    const tableCandidates = mergeTableCandidates([...explicitTables, ...inferredTables]);

    const textCharacterCount = textBlocks.reduce((total, block) => total + block.text.replace(/\s+/g, "").length, 0);
    const textDensity = textCharacterCount / pageArea;
    const imageCoverageRatio = Math.min(
      1,
      imageBlocks.reduce((total, image) => total + (image.areaRatio ?? 0), 0)
    );

    const hasTables = tableCandidates.length > 0;
    const hasImages = imageBlocks.some((image) => !image.decorative);
    const hasFloatingText = detectFloatingTextAroundImages(textBlocks, imageBlocks, page.width, page.height);
    const isScanned =
      (textCharacterCount < (options.scanTextCharacterThreshold ?? 120) &&
        imageCoverageRatio >= (options.scanImageCoverageThreshold ?? 0.35)) ||
      (textCharacterCount === 0 && imageBlocks.length > 0);

    const routeReasons: string[] = [];
    if (hasTables) {
      routeReasons.push("table-structure");
    }
    if (hasImages) {
      routeReasons.push("image-anchor");
    }
    if (isScanned) {
      routeReasons.push("scan-or-low-text-layer");
    }
    if (hasFloatingText) {
      routeReasons.push("floating-spatial-annotation");
    }

    return {
      pageNumber: page.pageNumber,
      width: page.width,
      height: page.height,
      textBlocks,
      imageBlocks,
      tableCandidates,
      drawingBlocks,
      textCharacterCount,
      textDensity,
      imageCoverageRatio,
      hasTables,
      hasImages,
      hasFloatingText,
      isScanned,
      route: routeReasons.length > 0 ? "accurate" : "fast",
      routeReasons: routeReasons.length > 0 ? routeReasons : ["text-only"]
    };
  }
}

function inferTableCandidates(
  pageNumber: number,
  textBlocks: LayoutTextBlock[],
  drawingBlocks: LayoutDrawingBlock[],
  options: LayoutAnalyzerOptions
): LayoutTableCandidate[] {
  const candidates: LayoutTableCandidate[] = [];
  const minRows = options.minTableRows ?? 4;
  const minColumns = options.minTableColumns ?? 3;

  if (drawingBlocks.length >= 12 && textBlocks.length >= minRows) {
    const drawingUnion = safeUnion(drawingBlocks.map((block) => block.bbox));
    if (drawingUnion) {
      candidates.push({
        id: `layout-table-p${pageNumber}-ruled-0`,
        pageNumber,
        order: 0,
        bbox: drawingUnion,
        confidence: 0.62,
        reason: "dense-ruled-layout"
      });
    }
  }

  const lineBoxes = textBlocks.flatMap((block) => block.lines.map((line) => line.bbox));
  const rowBands = groupCoordinates(
    lineBoxes.map((box) => bboxCenter(box).y),
    8
  );
  const columnBands = groupCoordinates(
    lineBoxes.map((box) => box.x0),
    18
  );

  if (rowBands.length >= minRows && columnBands.length >= minColumns) {
    const textUnion = safeUnion(lineBoxes);
    if (textUnion) {
      candidates.push({
        id: `layout-table-p${pageNumber}-aligned-text-0`,
        pageNumber,
        order: 1,
        bbox: textUnion,
        rowCount: rowBands.length,
        columnCount: columnBands.length,
        confidence: 0.54,
        reason: "aligned-text-grid"
      });
    }
  }

  return candidates;
}

function detectFloatingTextAroundImages(
  textBlocks: LayoutTextBlock[],
  imageBlocks: LayoutImageBlock[],
  pageWidth: number,
  pageHeight: number
): boolean {
  const anchorImages = imageBlocks.filter((image) => !image.decorative);
  if (anchorImages.length === 0) {
    return false;
  }

  return anchorImages.some((image) => {
    const context = expandBox(image.bbox, Math.max(80, pageWidth * 0.12), Math.max(80, pageHeight * 0.08), pageWidth, pageHeight);
    return textBlocks.some((block) => {
      const text = block.text.trim();
      if (!text || text.length > 240) {
        return false;
      }

      const nearAnchor = intersects(context, block.bbox) || distanceBetweenBoxes(image.bbox, block.bbox) <= 96;
      const compact = block.lines.length <= 4 || text.length <= 80;
      return nearAnchor && compact;
    });
  });
}

function mergeTableCandidates(candidates: LayoutTableCandidate[]): LayoutTableCandidate[] {
  const merged: LayoutTableCandidate[] = [];

  for (const candidate of candidates.sort((a, b) => b.confidence - a.confidence)) {
    const duplicate = merged.some((existing) => distanceBetweenBoxes(existing.bbox, candidate.bbox) < 12);
    if (!duplicate) {
      merged.push(candidate);
    }
  }

  return merged.sort((a, b) => a.order - b.order);
}

function isDecorativeImage(box: BoundingBox, areaRatio: number, pageHeight: number): boolean {
  const height = Math.max(0, box.y1 - box.y0);
  const inHeaderOrFooter = box.y1 < pageHeight * 0.12 || box.y0 > pageHeight * 0.88;
  return areaRatio < 0.005 || (areaRatio < 0.02 && inHeaderOrFooter && height < 80);
}

function groupCoordinates(values: number[], tolerance: number): number[][] {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  const groups: number[][] = [];

  for (const value of sorted) {
    const current = groups[groups.length - 1];
    if (!current || Math.abs(avg(current) - value) > tolerance) {
      groups.push([value]);
    } else {
      current.push(value);
    }
  }

  return groups;
}

function avg(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / Math.max(1, values.length);
}

function safeUnion(boxes: BoundingBox[]): BoundingBox | undefined {
  return boxes.length > 0 ? unionBox(boxes) : undefined;
}
