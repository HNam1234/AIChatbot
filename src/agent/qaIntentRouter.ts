import {
  HS_CODE_PATTERN,
  buildStructuredAnswer,
  hsCodesForSection,
  renderHsCodeAnswer,
  type CandidateRelevance,
  type EnrichedRetrievedSection,
  type RenderedHsCodeAnswer,
  type SectionMetadata
} from "./qaAnswerFormatter";

export type QaIntent =
  | "exact_hscode_lookup"
  | "product_classification"
  | "definition"
  | "chapter_summary"
  | "document_summary";

export interface IntentDetection {
  intent: QaIntent;
  confidence: number;
  reason: string;
  exactHsCode?: string;
  chapterNumber?: number;
  documentName?: string;
  definitionTerm?: string;
}

export interface QaDocumentMetadata {
  document: string;
  title?: string;
  input?: string;
  markdown?: string;
  sections?: string;
  tree?: string;
  documentType?: string;
  markdownText?: string;
  rootText?: string;
}

export interface QaDebugInfo {
  detectedIntent: QaIntent;
  intentConfidence: number;
  intentReason: string;
  resolvedDocument?: QaDocumentMetadata | null;
  selectedPrimary?: Record<string, unknown> | null;
  candidateRejectionReasons: Array<Record<string, unknown>>;
  indexSource?: Record<string, unknown>;
  cacheStatus?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface RoutedQaAnswer {
  intent: QaIntent;
  answer: string;
  selectedPrimary: Record<string, unknown> | null;
  documentSummary: Record<string, unknown> | null;
  citations: Record<string, unknown>[];
  debug: QaDebugInfo;
}

export function detectIntent(query: string): IntentDetection {
  const trimmed = query.trim();
  const normalized = normalizeForIntent(trimmed);
  const exactHsCode = trimmed.match(HS_CODE_PATTERN)?.[0];
  if (exactHsCode) {
    return {
      intent: "exact_hscode_lookup",
      confidence: 1,
      reason: "query contains exact HS code pattern",
      exactHsCode
    };
  }

  const chapterNumber = extractChapterSummaryNumber(normalized);
  if (chapterNumber !== undefined) {
    return {
      intent: "chapter_summary",
      confidence: 0.96,
      reason: "query asks for chapter contents or chapter code listing",
      chapterNumber
    };
  }

  const documentName = extractDocumentSummaryName(trimmed, normalized);
  if (documentName) {
    return {
      intent: "document_summary",
      confidence: 0.94,
      reason: "query asks for a document or file summary",
      documentName
    };
  }

  const definitionTerm = extractDefinitionTerm(trimmed, normalized);
  if (definitionTerm) {
    return {
      intent: "definition",
      confidence: 0.9,
      reason: "query asks for a definition",
      definitionTerm
    };
  }

  return {
    intent: "product_classification",
    confidence: 0.6,
    reason: "default product classification intent"
  };
}

export function handleExactHsCodeLookup(
  query: string,
  sections: SectionMetadata[],
  detection: IntentDetection = detectIntent(query),
  baseDebug: Partial<QaDebugInfo> = {}
): RoutedQaAnswer {
  const exactCode = detection.exactHsCode ?? query.match(HS_CODE_PATTERN)?.[0] ?? "";
  const selected = sections.find((section) => section.hsCode === exactCode) ??
    sections.find((section) => (section.groupedHsCodes ?? []).includes(exactCode));
  const selectedPrimary = selected ? publicSection(selected) : null;
  const title = selected?.title || titleFromSection(selected?.section) || "khong tim thay san pham";
  const answer = selected
    ? `Sản phẩm là ${normalizeProductTitle(title)}, HS Code: ${exactCode}.`
    : `Không tìm thấy HS Code ${exactCode} trong metadata hiện có.`;

  return {
    intent: "exact_hscode_lookup",
    answer,
    selectedPrimary,
    documentSummary: null,
    citations: selectedPrimary ? [selectedPrimary] : [],
    debug: buildDebug(baseDebug, detection, {
      selectedPrimary,
      candidateRejectionReasons: [],
      exactHsCode: exactCode
    })
  };
}

export function handleChapterSummary(
  query: string,
  sections: SectionMetadata[],
  documents: QaDocumentMetadata[],
  detection: IntentDetection = detectIntent(query),
  baseDebug: Partial<QaDebugInfo> = {}
): RoutedQaAnswer {
  const chapterNumber = detection.chapterNumber ?? extractChapterSummaryNumber(normalizeForIntent(query));
  const resolved = chapterNumber === undefined ? null : resolveChapterDocument(chapterNumber, sections, documents);
  const chapterSections = resolved
    ? sections.filter((section) => section.document === resolved.document)
    : [];
  const items = summarizeSectionList(chapterSections);
  const answer = chapterNumber === undefined
    ? "Không xác định được chapter cần tóm tắt."
    : items.length > 0
      ? [`Chapter ${chapterNumber} gồm các nội dung chính:`, ...items.map((item) => `- ${item.title} - HS Code: ${item.codes.join(", ")}.`)].join("\n")
      : `Không tìm thấy section HS Code cho Chapter ${chapterNumber}.`;
  const documentSummary = {
    type: "chapter_summary",
    chapterNumber: chapterNumber ?? null,
    document: resolved?.document ?? null,
    sectionCount: items.length,
    sections: items
  };

  return {
    intent: "chapter_summary",
    answer,
    selectedPrimary: null,
    documentSummary,
    citations: [],
    debug: buildDebug(baseDebug, detection, {
      resolvedDocument: resolved,
      selectedPrimary: null,
      candidateRejectionReasons: []
    })
  };
}

export function handleDocumentSummary(
  query: string,
  sections: SectionMetadata[],
  documents: QaDocumentMetadata[],
  detection: IntentDetection = detectIntent(query),
  baseDebug: Partial<QaDebugInfo> = {}
): RoutedQaAnswer {
  const requestedName = detection.documentName ?? extractDocumentSummaryName(query, normalizeForIntent(query));
  const resolved = requestedName ? resolveDocumentByName(requestedName, documents, sections) : null;
  const documentSections = resolved
    ? sections.filter((section) => section.document === resolved.document)
    : [];
  const items = summarizeSectionList(documentSections);
  const rootText = cleanSummaryText(resolved?.rootText ?? resolved?.markdownText ?? "");
  const isReference = items.length === 0;
  const intro = resolved
    ? `Document ${resolved.document} ${isReference ? "là tài liệu tham chiếu/giới thiệu" : "gồm các nội dung chính"}:`
    : `Không tìm thấy document ${requestedName ?? ""}.`;
  const answer = !resolved
    ? intro
    : items.length > 0
      ? [intro, ...items.map((item) => `- ${item.title} - HS Code: ${item.codes.join(", ")}.`)].join("\n")
      : rootText
        ? `${intro}\n- ${rootText}`
        : `${intro}\n- Không có section HS Code trong metadata hiện có.`;
  const documentSummary = {
    type: "document_summary",
    document: resolved?.document ?? null,
    requestedName: requestedName ?? null,
    isReference,
    sectionCount: items.length,
    sections: items,
    rootText: isReference ? rootText : undefined
  };

  return {
    intent: "document_summary",
    answer,
    selectedPrimary: null,
    documentSummary,
    citations: [],
    debug: buildDebug(baseDebug, detection, {
      resolvedDocument: resolved,
      selectedPrimary: null,
      candidateRejectionReasons: []
    })
  };
}

export function handleDefinition(
  query: string,
  selectedSection: EnrichedRetrievedSection | undefined,
  candidates: CandidateRelevance[] = [],
  detection: IntentDetection = detectIntent(query),
  baseDebug: Partial<QaDebugInfo> = {}
): RoutedQaAnswer {
  if (!selectedSection) {
    return emptyIntentAnswer("definition", "Không tìm thấy định nghĩa phù hợp trong metadata hiện có.", detection, candidates, baseDebug);
  }
  const rendered = renderHsCodeAnswer(undefined, selectedSection, [], { question: query, answerStyle: "class-eval" });
  return renderedIntentAnswer("definition", rendered, selectedSection, candidates, detection, baseDebug);
}

export function handleProductClassification(
  query: string,
  selectedSection: EnrichedRetrievedSection | undefined,
  alternatives: EnrichedRetrievedSection[] = [],
  llmAnswer: string | undefined = undefined,
  candidates: CandidateRelevance[] = [],
  detection: IntentDetection = detectIntent(query),
  baseDebug: Partial<QaDebugInfo> = {}
): RoutedQaAnswer {
  if (!selectedSection) {
    return emptyIntentAnswer("product_classification", "Không tìm thấy ngữ cảnh phù hợp trong metadata hiện có.", detection, candidates, baseDebug);
  }
  const rendered = renderHsCodeAnswer(llmAnswer, selectedSection, alternatives, { question: query, answerStyle: "class-eval" });
  return renderedIntentAnswer("product_classification", rendered, selectedSection, candidates, detection, baseDebug);
}

export function sectionMetadataToRetrieved(section: SectionMetadata, score = 1): EnrichedRetrievedSection {
  return {
    document: section.document,
    chapter: section.chapter,
    hsCode: section.hsCode,
    groupedHsCodes: section.groupedHsCodes,
    title: section.title,
    section: section.section,
    pageStart: section.pageStart,
    pageEnd: section.pageEnd,
    source: section.source,
    text: section.text ?? section.textPreview ?? "",
    captions: section.captions ?? [],
    score,
    metadataWarnings: []
  };
}

function renderedIntentAnswer(
  intent: QaIntent,
  rendered: RenderedHsCodeAnswer,
  selectedSection: EnrichedRetrievedSection,
  candidates: CandidateRelevance[],
  detection: IntentDetection,
  baseDebug: Partial<QaDebugInfo>
): RoutedQaAnswer {
  const selectedPrimary = publicSection(selectedSection);
  return {
    intent,
    answer: rendered.answer,
    selectedPrimary,
    documentSummary: null,
    citations: rendered.citations.map(publicSection),
    debug: buildDebug(baseDebug, detection, {
      selectedPrimary,
      candidateRejectionReasons: candidateRejections(candidates),
      finalHsCodes: rendered.finalHsCodes,
      answerRepairApplied: rendered.answerRepairApplied,
      structuredAnswer: buildStructuredAnswer(selectedSection, undefined)
    })
  };
}

function emptyIntentAnswer(
  intent: QaIntent,
  answer: string,
  detection: IntentDetection,
  candidates: CandidateRelevance[],
  baseDebug: Partial<QaDebugInfo>
): RoutedQaAnswer {
  return {
    intent,
    answer,
    selectedPrimary: null,
    documentSummary: null,
    citations: [],
    debug: buildDebug(baseDebug, detection, {
      selectedPrimary: null,
      candidateRejectionReasons: candidateRejections(candidates)
    })
  };
}

function buildDebug(
  baseDebug: Partial<QaDebugInfo>,
  detection: IntentDetection,
  overrides: Partial<QaDebugInfo>
): QaDebugInfo {
  return {
    detectedIntent: detection.intent,
    intentConfidence: detection.confidence,
    intentReason: detection.reason,
    resolvedDocument: null,
    selectedPrimary: null,
    candidateRejectionReasons: [],
    ...baseDebug,
    ...overrides
  };
}

function extractChapterSummaryNumber(normalized: string): number | undefined {
  const patterns = [
    /\btom\s+tat\s+(?:chuong|chapter)\s+(\d{1,3})\b/,
    /\bnoi\s+dung\s+chinh\s+(?:chuong|chapter)\s+(\d{1,3})\b/,
    /\b(?:chuong|chapter)\s+(\d{1,3})\s+co\s+gi\b/,
    /\bliet\s+ke\s+ma\s+trong\s+(?:chuong|chapter)\s+(\d{1,3})\b/
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) {
      return Number(match[1]);
    }
  }
  return undefined;
}

function extractDocumentSummaryName(query: string, normalized: string): string | undefined {
  const patterns = [
    /\btom\s+tat\s+document\s+(.+)$/,
    /\bdocument\s+(.+?)\s+co\s+gi\b/,
    /\bnoi\s+dung\s+file\s+(.+)$/
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match?.[1]) {
      return query.slice(normalized.indexOf(match[1])).trim().replace(/[?.!]+$/g, "");
    }
  }
  return undefined;
}

function extractDefinitionTerm(query: string, normalized: string): string | undefined {
  const normalizedPatterns = [
    /^(.+?)\s+la\s+gi\??$/,
    /^(.+?)\s+duoc\s+dinh\s+nghia\s+la\s+gi\??$/,
    /^define\s+(.+)$/,
    /^what\s+is\s+(.+?)\??$/
  ];
  for (const pattern of normalizedPatterns) {
    const match = normalized.match(pattern);
    if (match?.[1]) {
      return query.slice(normalized.indexOf(match[1])).trim().replace(/[?.!]+$/g, "");
    }
  }
  return undefined;
}

function resolveChapterDocument(
  chapterNumber: number,
  sections: SectionMetadata[],
  documents: QaDocumentMetadata[]
): QaDocumentMetadata | null {
  const expected = String(chapterNumber);
  const document = documents.find((candidate) => chapterNumberFromDocument(candidate) === expected);
  if (document) {
    return document;
  }
  const section = sections.find((candidate) => chapterNumberFromSection(candidate) === expected);
  return section ? { document: section.document } : null;
}

function resolveDocumentByName(
  requestedName: string,
  documents: QaDocumentMetadata[],
  sections: SectionMetadata[]
): QaDocumentMetadata | null {
  const requested = comparableName(requestedName);
  const document = documents.find((candidate) => {
    const names = [candidate.document, candidate.title, candidate.input, candidate.markdown, candidate.sections, candidate.tree]
      .filter((value): value is string => Boolean(value))
      .map(comparableName);
    return names.some((name) => name === requested || name.includes(requested) || requested.includes(name));
  });
  if (document) {
    return document;
  }
  const section = sections.find((candidate) => comparableName(candidate.document).includes(requested));
  return section ? { document: section.document } : null;
}

function chapterNumberFromDocument(document: QaDocumentMetadata): string | undefined {
  const text = [document.document, document.title, document.input, document.markdown, document.sections, document.tree].filter(Boolean).join(" ");
  return extractGenericChapterNumber(text);
}

function chapterNumberFromSection(section: SectionMetadata): string | undefined {
  const text = [section.document, section.chapter, section.section, section.markdownHeading].filter(Boolean).join(" ");
  return extractGenericChapterNumber(text);
}

function extractGenericChapterNumber(value: string): string | undefined {
  const patterns = [
    /chapter[\s_-]*(\d+)/i,
    /chapter\s+(\d+)/i,
    /chương\s+(\d+)/i
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) {
      return String(Number(match[1]));
    }
  }
  return undefined;
}

function summarizeSectionList(sections: SectionMetadata[]): Array<{ title: string; codes: string[]; document: string; pageStart: number | null; pageEnd: number | null }> {
  const byKey = new Map<string, { title: string; codes: string[]; document: string; pageStart: number | null; pageEnd: number | null }>();
  for (const section of sections) {
    const codes = hsCodesForSection(sectionMetadataToRetrieved(section));
    if (codes.length === 0) {
      continue;
    }
    const title = normalizeProductTitle(section.title || titleFromSection(section.section) || section.section || "Untitled");
    const key = `${title}|${codes.join("|")}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.codes = uniqueStrings([...existing.codes, ...codes]);
      continue;
    }
    byKey.set(key, {
      title,
      codes,
      document: section.document,
      pageStart: section.pageStart ?? null,
      pageEnd: section.pageEnd ?? null
    });
  }
  return [...byKey.values()];
}

function publicSection(section: SectionMetadata | EnrichedRetrievedSection): Record<string, unknown> {
  return {
    document: section.document,
    chapter: section.chapter,
    hsCode: section.hsCode ?? null,
    groupedHsCodes: section.groupedHsCodes ?? [],
    title: section.title ?? null,
    section: section.section ?? null,
    pageStart: section.pageStart ?? null,
    pageEnd: section.pageEnd ?? null,
    source: section.source ?? null,
    captions: "captions" in section ? section.captions ?? [] : [],
    score: "score" in section ? section.score : undefined,
    metadataWarnings: "metadataWarnings" in section ? section.metadataWarnings : []
  };
}

function candidateRejections(candidates: CandidateRelevance[]): Array<Record<string, unknown>> {
  return candidates
    .filter((candidate) => candidate.rejected)
    .map((candidate) => ({
      document: candidate.document,
      hsCode: candidate.hsCode,
      groupedHsCodes: candidate.groupedHsCodes,
      title: candidate.title,
      section: candidate.section,
      reason: candidate.rejectedReason,
      matchedTerms: candidate.matchedTerms,
      matchedPhrases: candidate.candidateMatchedPhrases,
      numericMatches: candidate.numericMatches,
      finalScore: candidate.finalScore
    }));
}

function cleanSummaryText(value: string): string {
  const withoutMarkdown = value
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/!\[[^\]]*]\([^)]+\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!withoutMarkdown) {
    return "";
  }
  return withoutMarkdown.length <= 240 ? ensureSentence(withoutMarkdown) : ensureSentence(withoutMarkdown.slice(0, 240).replace(/\s+\S*$/g, ""));
}

function titleFromSection(value: string | undefined): string | undefined {
  return value?.replace(HS_CODE_PATTERN, "").replace(/^[\s—–-]+/, "").trim() || undefined;
}

function normalizeProductTitle(value: string): string {
  const cleaned = value.replace(HS_CODE_PATTERN, "").replace(/^[\s—–-]+/, "").replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return value;
  }
  return cleaned.toLowerCase().replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function comparableName(value: string): string {
  return normalizeForIntent(value)
    .replace(/\.(pdf|md|json)$/i, "")
    .replace(/\b(milestone1|sections|tree|validation|blocks)\b/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function normalizeForIntent(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function ensureSentence(value: string): string {
  return /[.!?]$/.test(value.trim()) ? value.trim() : `${value.trim()}.`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
