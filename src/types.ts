export type ParserSource = "layout" | "pymupdf" | "docling" | "fusion";

export type ParsedBlockType =
  | "text"
  | "table"
  | "image"
  | "caption"
  | "page"
  | "unknown";

export type RouteMode = "fast" | "accurate";

export interface BoundingBox {
  page: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface TextLine {
  text: string;
  bbox: BoundingBox;
  fontSize?: number;
  font?: string;
  flags?: number;
}

export interface ParsedBlock {
  id: string;
  type: ParsedBlockType;
  source: ParserSource;
  pageNumber: number;
  order: number;
  text?: string;
  markdown?: string;
  html?: string;
  bbox?: BoundingBox;
  confidence?: number;
  captionLinked?: boolean;
  linkedCaptionIds?: string[];
  anchorImageId?: string;
  metadata?: Record<string, unknown>;
}

export interface LayoutTextBlock {
  id: string;
  pageNumber: number;
  order: number;
  bbox: BoundingBox;
  text: string;
  lines: TextLine[];
  avgFontSize?: number;
  maxFontSize?: number;
  fontNames?: string[];
  flags?: number;
}

export interface LayoutImageBlock {
  id: string;
  pageNumber: number;
  order: number;
  bbox: BoundingBox;
  width?: number;
  height?: number;
  xref?: number;
  softMaskXref?: number;
  hasAlpha?: boolean;
  extension?: string;
  areaRatio?: number;
  decorative?: boolean;
}

export interface LayoutTableCandidate {
  id: string;
  pageNumber: number;
  order: number;
  bbox: BoundingBox;
  rowCount?: number;
  columnCount?: number;
  confidence: number;
  reason: string;
}

export interface LayoutDrawingBlock {
  id: string;
  pageNumber: number;
  order: number;
  bbox: BoundingBox;
}

export interface PageLayout {
  pageNumber: number;
  width: number;
  height: number;
  textBlocks: LayoutTextBlock[];
  imageBlocks: LayoutImageBlock[];
  tableCandidates: LayoutTableCandidate[];
  drawingBlocks: LayoutDrawingBlock[];
  textCharacterCount: number;
  textDensity: number;
  imageCoverageRatio: number;
  hasTables: boolean;
  hasImages: boolean;
  hasFloatingText: boolean;
  isScanned: boolean;
  route: RouteMode;
  routeReasons: string[];
}

export interface LayoutAnalysis {
  pdfPath: string;
  pageCount: number;
  pages: PageLayout[];
}

export interface PageRoute {
  pageNumber: number;
  mode: RouteMode;
  reasons: string[];
}

export interface RoutingPlan {
  routes: PageRoute[];
  fastPages: number[];
  accuratePages: number[];
}

export interface ToolRuntimeOptions {
  pythonCommand?: string;
  doclingCommand?: string;
  timeoutMs?: number;
}

export interface PipelineOptions extends ToolRuntimeOptions {
  outputPath?: string;
  blocksPath?: string;
  validationReportPath?: string;
  doclingPageBatchSize?: number;
  doclingThreads?: number;
  ocrLanguage?: string;
  allowPyMuPDFFallback?: boolean;
  ensureDocumentHeader?: boolean;
  includePageMarkers?: boolean;
  noiseTolerance?: number;
}

export interface ValidationMarkerResult {
  marker: string;
  passed: boolean;
  message: string;
  details?: Record<string, unknown>;
}

export interface ValidationReport {
  passed: boolean;
  markers: ValidationMarkerResult[];
  errors: string[];
}

export interface PipelineResult {
  markdown: string;
  parsedBlocks: ParsedBlock[];
  layout: LayoutAnalysis;
  routingPlan: RoutingPlan;
  validation: ValidationReport;
  outputPath?: string;
  blocksPath?: string;
  validationReportPath?: string;
}
