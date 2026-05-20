export interface SourceCitationSection {
  document?: string;
  chapter?: string;
  hsCode?: string | null;
  groupedHsCodes?: string[];
  title?: string | null;
  section?: string | null;
  pageStart?: number | null;
  pageEnd?: number | null;
  source?: string | null;
  captions?: string[];
  score?: number;
  metadataWarnings?: unknown;
  text?: string;
  textPreview?: string;
}

export interface SourceTextView {
  document: string;
  pdfUrl: string;
  page?: number;
  hsCode?: string;
  section?: string;
  title?: string;
  sourceText: string;
  query: string;
  matchFound: boolean;
}
