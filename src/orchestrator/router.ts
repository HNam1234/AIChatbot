import type {
  LayoutAnalysis,
  LayoutImageBlock,
  LayoutTableCandidate,
  LayoutTextBlock,
  ParsedBlock,
  PipelineOptions,
  RoutingPlan
} from "../types";
import { DoclingWrapper } from "../tools/doclingWrapper";
import { PyMuPDFWrapper } from "../tools/pyMuPDFWrapper";

export class SmartRouter {
  public static createPlan(layout: LayoutAnalysis): RoutingPlan {
    const routes = layout.pages.map((page) => ({
      pageNumber: page.pageNumber,
      mode: page.route,
      reasons: page.routeReasons
    }));

    return {
      routes,
      fastPages: routes.filter((route) => route.mode === "fast").map((route) => route.pageNumber),
      accuratePages: routes.filter((route) => route.mode === "accurate").map((route) => route.pageNumber)
    };
  }

  public static async run(
    pdfPath: string,
    layout: LayoutAnalysis,
    options: PipelineOptions = {}
  ): Promise<{ plan: RoutingPlan; blocks: ParsedBlock[] }> {
    const plan = this.createPlan(layout);
    const layoutBlocks = this.createLayoutBlocks(layout);
    const parsedBlocks: ParsedBlock[] = [];

    if (plan.fastPages.length > 0) {
      parsedBlocks.push(
        ...(await PyMuPDFWrapper.convertPages(pdfPath, plan.fastPages, {
          pythonCommand: options.pythonCommand,
          timeoutMs: options.timeoutMs,
          ocrLanguage: options.ocrLanguage
        }))
      );
    }

    if (plan.accuratePages.length > 0) {
      try {
        parsedBlocks.push(
          ...(await DoclingWrapper.convertPages(pdfPath, plan.accuratePages, {
            pythonCommand: options.pythonCommand,
            doclingCommand: options.doclingCommand,
            timeoutMs: options.timeoutMs,
            ocrLanguage: options.ocrLanguage,
            pageBatchSize: options.doclingPageBatchSize,
            threads: options.doclingThreads
          }))
        );
      } catch (error) {
        if (!options.allowPyMuPDFFallback) {
          throw error;
        }

        parsedBlocks.push(
          ...(await PyMuPDFWrapper.convertPages(pdfPath, plan.accuratePages, {
            pythonCommand: options.pythonCommand,
            timeoutMs: options.timeoutMs,
            ocrLanguage: options.ocrLanguage
          })).map((block) => ({
            ...block,
            metadata: {
              ...(block.metadata ?? {}),
              routeMode: "accurate-fallback",
              warning: error instanceof Error ? error.message : String(error)
            }
          }))
        );
      }
    }

    return {
      plan,
      blocks: [...parsedBlocks, ...layoutBlocks].sort((a, b) => a.pageNumber - b.pageNumber || a.order - b.order)
    };
  }

  private static createLayoutBlocks(layout: LayoutAnalysis): ParsedBlock[] {
    return layout.pages.flatMap((page) => {
      const textBlocks = page.textBlocks.map((block) => textLayoutBlockToParsedBlock(block));
      const imageBlocks = page.imageBlocks.map((block) => imageLayoutBlockToParsedBlock(block, page.width, page.height));
      const tableBlocks = page.tableCandidates.map((block) => tableCandidateToParsedBlock(block));
      return [...textBlocks, ...imageBlocks, ...tableBlocks];
    });
  }
}

function textLayoutBlockToParsedBlock(block: LayoutTextBlock): ParsedBlock {
  return {
    id: block.id,
    type: "text",
    source: "layout",
    pageNumber: block.pageNumber,
    order: block.pageNumber * 100000 + block.order,
    text: block.text,
    bbox: block.bbox,
    metadata: {
      includeInMarkdown: false,
      layoutOnly: true,
      avgFontSize: block.avgFontSize,
      maxFontSize: block.maxFontSize,
      fontNames: block.fontNames ?? [],
      flags: block.flags,
      lines: block.lines,
      lineCount: block.lines.length
    }
  };
}

function imageLayoutBlockToParsedBlock(block: LayoutImageBlock, pageWidth: number, pageHeight: number): ParsedBlock {
  return {
    id: block.id,
    type: "image",
    source: "layout",
    pageNumber: block.pageNumber,
    order: block.pageNumber * 100000 + 30000 + block.order,
    bbox: block.bbox,
    captionLinked: false,
    metadata: {
      includeInMarkdown: false,
      layoutOnly: true,
      width: block.width,
      height: block.height,
      xref: block.xref,
      softMaskXref: block.softMaskXref,
      hasAlpha: block.hasAlpha,
      extension: block.extension,
      areaRatio: block.areaRatio,
      decorative: block.decorative ?? false,
      pageWidth,
      pageHeight
    }
  };
}

function tableCandidateToParsedBlock(block: LayoutTableCandidate): ParsedBlock {
  return {
    id: block.id,
    type: "table",
    source: "layout",
    pageNumber: block.pageNumber,
    order: block.pageNumber * 100000 + 20000 + block.order,
    bbox: block.bbox,
    confidence: block.confidence,
    metadata: {
      includeInMarkdown: false,
      layoutOnly: true,
      rowCount: block.rowCount,
      columnCount: block.columnCount,
      reason: block.reason
    }
  };
}
