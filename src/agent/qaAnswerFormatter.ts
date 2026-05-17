export const HS_CODE_PATTERN = /\b\d{4}\.\d{2}\.\d{2}\b/;

export interface SectionMetadata {
  document: string;
  chapter?: string;
  hsCode?: string;
  title?: string;
  section?: string;
  pageStart?: number;
  pageEnd?: number;
  source?: string;
  text?: string;
  textPreview?: string;
  captions?: string[];
  markdownHeading?: string;
}

export interface RetrievedTreeHit {
  document: string;
  title: string;
  text: string;
  score: number;
}

export interface EnrichedRetrievedSection {
  document: string;
  chapter?: string;
  hsCode?: string;
  title?: string;
  section?: string;
  pageStart?: number;
  pageEnd?: number;
  source?: string;
  text: string;
  captions: string[];
  score: number;
  metadataWarnings: string[];
}

export interface RenderedHsCodeAnswer {
  answer: string;
  citations: EnrichedRetrievedSection[];
  metadataWarnings: string[];
}

export function normalizeSectionMetadata(raw: Record<string, unknown>, fallbackDocument?: string): SectionMetadata {
  const document = stringValue(raw.document) ?? fallbackDocument ?? "";
  const hsCode = stringValue(raw.hsCode) ?? extractHsCode(stringValue(raw.section) ?? stringValue(raw.markdownHeading) ?? "");
  const title = stringValue(raw.title) ?? titleFromHeading(stringValue(raw.section) ?? stringValue(raw.markdownHeading) ?? "");
  const composedSection = [hsCode, title].filter(Boolean).join(" — ");
  const section = normalizeDisplayText(stringValue(raw.section) ?? (composedSection || stringValue(raw.markdownHeading) || title || ""));

  return {
    document,
    chapter: stringValue(raw.chapter),
    hsCode,
    title: normalizeDisplayText(title),
    section,
    pageStart: numberValue(raw.pageStart),
    pageEnd: numberValue(raw.pageEnd),
    source: stringValue(raw.source),
    text: stringValue(raw.text),
    textPreview: stringValue(raw.textPreview),
    captions: Array.isArray(raw.captions) ? raw.captions.map((caption) => String(caption)) : undefined,
    markdownHeading: normalizeDisplayText(stringValue(raw.markdownHeading))
  };
}

export function enrichRetrievedHit(
  hit: RetrievedTreeHit,
  sectionMetadata: SectionMetadata[]
): EnrichedRetrievedSection {
  const normalizedHit = {
    ...hit,
    title: normalizeDisplayText(hit.title),
    text: normalizeDisplayText(hit.text)
  };
  const metadata = findBestSectionMetadata(normalizedHit, sectionMetadata);
  const parsedHsCode = extractHsCode(`${normalizedHit.title}\n${normalizedHit.text}`);
  const hsCode = metadata?.hsCode ?? parsedHsCode;
  const title = metadata?.title ?? titleFromHeading(normalizedHit.title);
  const parsedSection = normalizeDisplayText([hsCode, title].filter(Boolean).join(" — "));
  const section = metadata?.section ?? (parsedSection || normalizedHit.title);
  const text = cleanRetrievedText(normalizedHit.text) || metadata?.textPreview || metadata?.text || "";
  const captions = uniqueStrings([...(metadata?.captions ?? []), ...extractCaptions(normalizedHit.text)]);
  const metadataWarnings = metadata || hsCode ? [] : ["Không tìm thấy HS Code trong metadata của section được retrieve."];

  return {
    document: metadata?.document || normalizedHit.document,
    chapter: metadata?.chapter,
    hsCode,
    title,
    section,
    pageStart: metadata?.pageStart,
    pageEnd: metadata?.pageEnd,
    source: metadata?.source,
    text,
    captions,
    score: hit.score,
    metadataWarnings
  };
}

export function buildStructuredRetrievedContext(sections: EnrichedRetrievedSection[]): string {
  return sections.map((section, index) => {
    const fields = [
      `Retrieved section ${index + 1}:`,
      `- document: ${section.document}`,
      `- chapter: ${section.chapter ?? ""}`,
      `- pageStart: ${section.pageStart ?? ""}`,
      `- pageEnd: ${section.pageEnd ?? ""}`,
      `- hsCode: ${section.hsCode ?? ""}`,
      `- title: ${section.title ?? ""}`,
      `- section: ${section.section ?? ""}`,
      `- source: ${section.source ?? ""}`,
      `- captions: ${section.captions.join("; ")}`,
      `- text: ${section.text}`
    ];
    return fields.join("\n");
  }).join("\n\n---\n\n");
}

export function renderHsCodeAnswer(
  llmAnswer: string | undefined,
  topSection: EnrichedRetrievedSection,
  alternatives: EnrichedRetrievedSection[] = []
): RenderedHsCodeAnswer {
  const directAnswer = cleanDirectAnswer(llmAnswer) || fallbackDirectAnswer(topSection);
  const metadataWarnings = [...topSection.metadataWarnings];
  const body = topSection.hsCode
    ? `${ensureSentenceEnd(directAnswer)} HS Code: ${topSection.hsCode}.`
    : `${ensureSentenceEnd(directAnswer)} Không tìm thấy HS Code trong metadata của section được retrieve.`;
  const alternativeLine = formatAlternativeSections(topSection, alternatives);
  const citation = formatCitation(topSection);
  const answer = [body, alternativeLine, citation].filter(Boolean).join("\n\n");

  return {
    answer,
    citations: [topSection, ...alternatives],
    metadataWarnings
  };
}

export function formatCitation(section: Pick<EnrichedRetrievedSection, "document" | "pageStart" | "pageEnd" | "section">): string {
  const source = section.document || "unknown document";
  const pageRange = formatPageRange(section.pageStart, section.pageEnd);
  const sectionText = section.section ? `section "${section.section}"` : "section unknown";

  if (pageRange) {
    return `Nguồn: ${source}, ${pageRange}, ${sectionText}.`;
  }

  return `Nguồn: ${source}, ${sectionText}.`;
}

export function formatPageRange(pageStart?: number, pageEnd?: number): string {
  if (pageStart && pageEnd && pageStart !== pageEnd) {
    return `pages ${pageStart}–${pageEnd}`;
  }
  if (pageStart || pageEnd) {
    return `page ${pageStart ?? pageEnd}`;
  }
  return "";
}

export function selectAlternativeSections(
  sections: EnrichedRetrievedSection[],
  question: string,
  limit = 2
): EnrichedRetrievedSection[] {
  if (!isComparisonQuestion(question)) {
    return [];
  }

  const top = sections[0];
  const seen = new Set([top?.hsCode, top?.section].filter(Boolean));
  const alternatives: EnrichedRetrievedSection[] = [];
  for (const section of sections.slice(1)) {
    const key = section.hsCode ?? section.section;
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    alternatives.push(section);
    if (alternatives.length >= limit) {
      break;
    }
  }
  return alternatives;
}

function findBestSectionMetadata(hit: RetrievedTreeHit, sections: SectionMetadata[]): SectionMetadata | undefined {
  const documentSections = sections.filter((section) => section.document === hit.document);
  const candidates = documentSections.length > 0 ? documentSections : sections;
  const hitHsCode = extractHsCode(`${hit.title}\n${hit.text}`);
  if (hitHsCode) {
    const exact = candidates.find((section) => section.hsCode === hitHsCode);
    if (exact) {
      return exact;
    }
  }

  const hitHeading = normalizeComparable(hit.title || firstMarkdownHeading(hit.text));
  const hitTitle = normalizeComparable(titleFromHeading(hit.title));

  return candidates.find((section) => {
    const headings = [
      section.section,
      section.markdownHeading,
      section.title,
      [section.hsCode, section.title].filter(Boolean).join(" — ")
    ].map((value) => normalizeComparable(value));

    return headings.some((heading) => heading && (heading === hitHeading || heading === hitTitle || hitHeading.includes(heading)));
  });
}

function formatAlternativeSections(topSection: EnrichedRetrievedSection, alternatives: EnrichedRetrievedSection[]): string {
  const relevant = alternatives.filter((section) => section.hsCode && section.hsCode !== topSection.hsCode);
  if (relevant.length === 0) {
    return "";
  }

  return `Mã liên quan: ${relevant
    .map((section) => `HS Code: ${section.hsCode}, section "${section.section ?? section.title ?? "unknown"}"`)
    .join("; ")}.`;
}

function cleanDirectAnswer(answer: string | undefined): string {
  const cleaned = normalizeDisplayText(answer)
    .replace(/<doc=[^>]+>/gi, "")
    .replace(/\s*(Trích dẫn|Citation|Nguồn):[\s\S]*$/i, "")
    .replace(/^\s*Nguồn:.*$/gim, "")
    .replace(/HS Code:\s*\d{4}\.\d{2}\.\d{2}\.?/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  if (/document context is insufficient/i.test(cleaned) || /không đủ ngữ cảnh/i.test(cleaned)) {
    return "";
  }

  return cleaned;
}

function fallbackDirectAnswer(section: EnrichedRetrievedSection): string {
  const firstSentence = section.text.match(/^[^.!?]+[.!?]/)?.[0] ?? section.text;
  return firstSentence.trim() || `${section.title ?? section.section ?? "Section"} được tìm thấy trong metadata.`;
}

function cleanRetrievedText(text: string): string {
  return text
    .replace(/^#{1,6}\s+.*$/gm, "")
    .replace(/!\[[^\]]*]\([^)]+\)/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^\*Caption:\s*[^*]+\*$/gim, "")
    .replace(/^\(Source:[^)]+\)$/gim, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractCaptions(text: string): string[] {
  const captions: string[] = [];
  for (const match of text.matchAll(/\*Caption:\s*([^*]+)\*/gi)) {
    captions.push(match[1].trim());
  }
  return captions;
}

function extractHsCode(value: string): string | undefined {
  return normalizeDisplayText(value).match(HS_CODE_PATTERN)?.[0];
}

function titleFromHeading(value: string | undefined): string | undefined {
  const normalized = normalizeDisplayText(value).replace(/^#{1,6}\s+/, "").trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.replace(HS_CODE_PATTERN, "").replace(/^[\s—–-]+/, "").trim() || normalized;
}

function firstMarkdownHeading(text: string): string {
  return text.match(/^#{1,6}\s+(.+)$/m)?.[1] ?? "";
}

function normalizeComparable(value: string | undefined): string {
  return normalizeDisplayText(value)
    .replace(/^#{1,6}\s+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeDisplayText(value: string | undefined): string {
  return (value ?? "")
    .replace(/â€”/g, "—")
    .replace(/â€“/g, "–")
    .replace(/\s+—\s+/g, " — ")
    .trim();
}

function isComparisonQuestion(question: string): boolean {
  const normalized = question.toLowerCase();
  return /\b(vs|versus|compare|comparison|difference|different)\b/.test(normalized) || /khác|so sánh|phân biệt/.test(normalized);
}

function ensureSentenceEnd(value: string): string {
  const trimmed = value.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
