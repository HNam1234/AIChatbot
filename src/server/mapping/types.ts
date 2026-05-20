export type MappingBlockType =
  | "heading"
  | "hs-code"
  | "title"
  | "paragraph"
  | "image"
  | "caption"
  | "source"
  | "table"
  | "unknown";

export interface MappingBbox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface MappingTextLine {
  text: string;
  bbox: MappingBbox;
  fontSize?: number;
  font?: string;
  flags?: number;
}

export interface MappingBlock {
  id: string;
  document: string;
  pageNumber: number;
  pageWidth?: number;
  pageHeight?: number;
  bbox: MappingBbox;
  type: MappingBlockType;
  text: string;
  markdownText?: string;
  section?: string;
  hsCode?: string;
  title?: string;
  confidence?: number;
  assetUrl?: string;
  captionText?: string;
  lines?: MappingTextLine[];
}

export interface MappingSection {
  document?: string;
  section?: string;
  hsCode?: string;
  title?: string;
  pageStart?: number | null;
  pageEnd?: number | null;
  source?: string | null;
  markdownHeading?: string;
  textPreview?: string;
}

export interface MappingDocumentSummary {
  document: string;
  pdfUrl: string;
  markdownPath?: string;
  blocksPath?: string;
  sectionsPath?: string;
  parseStatus?: string;
  pageIndexStatus?: string;
  mappingStatus: "available";
  hasPdf: boolean;
  hasMarkdown: boolean;
  hasBlocks: boolean;
  hasSections: boolean;
  hsSectionCount?: number;
  imageCount?: number;
}

export interface MappingPayload {
  document: string;
  pdfUrl: string;
  markdownPath?: string;
  blocksPath?: string;
  sectionsPath?: string;
  pageCount: number;
  blocks: MappingBlock[];
  sections: MappingSection[];
  markdown: string;
  cacheStatus: {
    parse: string;
    pageIndex: string;
    mapping: "available" | "missing";
  };
}
