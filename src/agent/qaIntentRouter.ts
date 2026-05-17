import {
  HS_CODE_PATTERN,
  buildStructuredAnswer,
  evaluateCandidateRelevance,
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

export type AnswerMode =
  | "classification"
  | "lookup"
  | "numeric_lookup"
  | "ambiguous_lookup"
  | "clarification"
  | "exact_hscode_lookup"
  | "chapter_summary"
  | "document_summary"
  | "definition";

export type AnswerConfidence = "high" | "medium" | "low";

export interface GateResult {
  answerMode: AnswerMode;
  answerConfidence: AnswerConfidence;
  confidenceReason: string;
  finalScore: number;
  strongSignals: string[];
  contradictions: string[];
  shouldAskClarification: boolean;
}

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
  answerMode?: AnswerMode;
  answerConfidence?: AnswerConfidence;
  confidenceReason?: string;
  finalScore?: number;
  strongSignals?: string[];
  contradictions?: string[];
  rejectedReason?: string | null;
  resolvedDocument?: QaDocumentMetadata | null;
  selectedPrimary?: Record<string, unknown> | null;
  candidateRejectionReasons: Array<Record<string, unknown>>;
  indexSource?: Record<string, unknown>;
  cacheStatus?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface RoutedQaAnswer {
  intent: QaIntent;
  answerMode: AnswerMode;
  answerConfidence: AnswerConfidence;
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

  const chapterNumber = hasChapterMarker(normalized) && hasSummaryVerb(normalized)
    ? extractChapterNumber(normalized)
    : undefined;
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

  const gate = deterministicGate(
    "exact_hscode_lookup",
    selected ? "high" : "low",
    selected ? 100 : 0,
    selected ? ["exact_hscode_match"] : [],
    selected ? "exact HS code exists in selected metadata" : "exact HS code not found in selected metadata"
  );
  const finalAnswer = selected ? `HS Code ${exactCode} là ${normalizeProductTitle(title)}.` : answer;

  return {
    intent: "exact_hscode_lookup",
    answerMode: gate.answerMode,
    answerConfidence: gate.answerConfidence,
    answer: finalAnswer,
    selectedPrimary,
    documentSummary: null,
    citations: selectedPrimary ? [selectedPrimary] : [],
    debug: buildDebug(baseDebug, detection, {
      selectedPrimary,
      candidateRejectionReasons: [],
      exactHsCode: exactCode,
      ...debugGateFields(gate)
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
  const chapterNumber = detection.chapterNumber ?? extractChapterNumber(normalizeForIntent(query));
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
    answerMode: "chapter_summary",
    answerConfidence: items.length > 0 ? "high" : "low",
    answer: formatChapterSummaryAnswer(chapterNumber, items, answer),
    selectedPrimary: null,
    documentSummary,
    citations: [],
    debug: buildDebug(baseDebug, detection, {
      resolvedDocument: resolved,
      selectedPrimary: null,
      candidateRejectionReasons: [],
      ...debugGateFields(deterministicGate(
        "chapter_summary",
        items.length > 0 ? "high" : "low",
        items.length > 0 ? 100 : 0,
        resolved ? ["chapter_match"] : [],
        resolved ? "chapter metadata resolved deterministically" : "chapter metadata not found"
      ))
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
    answerMode: "document_summary",
    answerConfidence: resolved ? "high" : "low",
    answer,
    selectedPrimary: null,
    documentSummary,
    citations: [],
    debug: buildDebug(baseDebug, detection, {
      resolvedDocument: resolved,
      selectedPrimary: null,
      candidateRejectionReasons: [],
      ...debugGateFields(deterministicGate(
        "document_summary",
        resolved ? "high" : "low",
        resolved ? 100 : 0,
        resolved ? ["document_match"] : [],
        resolved ? "document metadata resolved deterministically" : "document metadata not found"
      ))
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
    return emptyIntentAnswer("definition", clarificationAnswer(), detection, candidates, baseDebug, {
      answerMode: "clarification",
      answerConfidence: "low",
      confidenceReason: "no relevant section found for definition",
      finalScore: 0,
      strongSignals: [],
      contradictions: [],
      shouldAskClarification: true
    });
  }
  const gate = definitionGate(query, selectedSection, candidates);
  if (gate.shouldAskClarification) {
    return emptyIntentAnswer("definition", clarificationAnswer(), detection, candidates, baseDebug, gate);
  }
  const rendered = renderHsCodeAnswer(undefined, selectedSection, [], { question: query, answerStyle: "class-eval" });
  return renderedIntentAnswer("definition", rendered, selectedSection, candidates, detection, baseDebug, gate);
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
    const gate = productGate(query, undefined, candidates);
    return emptyIntentAnswer("product_classification", gate.answerMode === "numeric_lookup" ? numericLookupAnswer(query) : clarificationAnswer(), detection, candidates, baseDebug, gate);
  }
  const gate = productGate(query, selectedSection, candidates);
  if (gate.answerMode === "numeric_lookup") {
    return lookupIntentAnswer("product_classification", numericLookupAnswer(query, selectedSection), selectedSection, candidates, detection, baseDebug, gate);
  }
  if (gate.answerMode === "ambiguous_lookup" || gate.answerMode === "lookup") {
    return lookupIntentAnswer("product_classification", ambiguousLookupAnswer(selectedSection), selectedSection, candidates, detection, baseDebug, gate);
  }
  if (gate.shouldAskClarification) {
    return emptyIntentAnswer("product_classification", clarificationAnswer(), detection, candidates, baseDebug, gate);
  }
  const rendered = renderHsCodeAnswer(llmAnswer, selectedSection, alternatives, { question: query, answerStyle: "class-eval" });
  return renderedIntentAnswer("product_classification", rendered, selectedSection, candidates, detection, baseDebug, gate);
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
  baseDebug: Partial<QaDebugInfo>,
  gate: GateResult = deterministicGate(intent === "definition" ? "definition" : "classification", "high", selectedSection.score, [], "legacy deterministic render")
): RoutedQaAnswer {
  const selectedPrimary = publicSection(selectedSection);
  return {
    intent,
    answerMode: gate.answerMode,
    answerConfidence: gate.answerConfidence,
    answer: rendered.answer,
    selectedPrimary,
    documentSummary: null,
    citations: rendered.citations.map(publicSection),
    debug: buildDebug(baseDebug, detection, {
      selectedPrimary,
      selectedPrimaryId: sectionIdentity(selectedSection),
      candidateRejectionReasons: candidateRejections(candidates),
      finalHsCodes: rendered.finalHsCodes,
      answerRepairApplied: rendered.answerRepairApplied,
      structuredAnswer: buildStructuredAnswer(selectedSection, undefined),
      rejectedReason: selectedCandidate(candidates, selectedSection)?.rejectedReason ?? null,
      ...debugGateFields(gate)
    })
  };
}

function lookupIntentAnswer(
  intent: QaIntent,
  answer: string,
  selectedSection: EnrichedRetrievedSection,
  candidates: CandidateRelevance[],
  detection: IntentDetection,
  baseDebug: Partial<QaDebugInfo>,
  gate: GateResult
): RoutedQaAnswer {
  const selectedPrimary = publicSection(selectedSection);
  return {
    intent,
    answerMode: gate.answerMode,
    answerConfidence: gate.answerConfidence,
    answer,
    selectedPrimary,
    documentSummary: null,
    citations: [selectedPrimary],
    debug: buildDebug(baseDebug, detection, {
      selectedPrimary,
      selectedPrimaryId: sectionIdentity(selectedSection),
      candidateRejectionReasons: candidateRejections(candidates),
      finalHsCodes: hsCodesForSection(selectedSection),
      rejectedReason: selectedCandidate(candidates, selectedSection)?.rejectedReason ?? null,
      ...debugGateFields(gate)
    })
  };
}

function emptyIntentAnswer(
  intent: QaIntent,
  answer: string,
  detection: IntentDetection,
  candidates: CandidateRelevance[],
  baseDebug: Partial<QaDebugInfo>,
  gate: GateResult = deterministicGate("clarification", "low", 0, [], "no selected section")
): RoutedQaAnswer {
  return {
    intent,
    answerMode: gate.answerMode,
    answerConfidence: gate.answerConfidence,
    answer,
    selectedPrimary: null,
    documentSummary: null,
    citations: [],
    debug: buildDebug(baseDebug, detection, {
      selectedPrimary: null,
      candidateRejectionReasons: candidateRejections(candidates),
      rejectedReason: topCandidate(candidates)?.rejectedReason ?? null,
      ...debugGateFields(gate)
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

const CLASSIFICATION_MIN_SCORE = 50;
const MIN_STRONG_SIGNALS = 2;

function productGate(
  query: string,
  selectedSection: EnrichedRetrievedSection | undefined,
  candidates: CandidateRelevance[]
): GateResult {
  const effectiveCandidates = selectedSection && candidates.length === 0
    ? [evaluateCandidateRelevance(selectedSection, query)]
    : candidates;
  const selected = selectedSection ? selectedCandidate(effectiveCandidates, selectedSection) : topCandidate(effectiveCandidates);
  const finalScore = selected?.finalScore ?? selectedSection?.score ?? 0;
  const strongSignals = selectedSection && selected ? strongSignalsForCandidate(query, selectedSection, selected) : [];
  const contradictions = selectedSection && selected ? contradictionsForCandidate(query, selectedSection, selected) : [];
  const shortQuery = isAmbiguousProductQuery(query);
  const numericOnly = isNumericOnlyQuery(query);
  const rejectedReason = selected?.rejectedReason ?? null;
  const rejected = Boolean(selected?.rejected);
  const weakOnly = Boolean(rejectedReason && /weak generic|bare numbers|contrast baseline/i.test(rejectedReason));

  if (numericOnly) {
    return {
      answerMode: "numeric_lookup",
      answerConfidence: "low",
      confidenceReason: "numeric-only query is lookup evidence, not product classification",
      finalScore,
      strongSignals,
      contradictions,
      shouldAskClarification: false
    };
  }

  if (shortQuery) {
    return {
      answerMode: selectedSection ? "ambiguous_lookup" : "clarification",
      answerConfidence: "low",
      confidenceReason: "query has fewer than two meaningful non-generic tokens",
      finalScore,
      strongSignals,
      contradictions,
      shouldAskClarification: !selectedSection
    };
  }

  if (!selectedSection) {
    return {
      answerMode: "clarification",
      answerConfidence: "low",
      confidenceReason: "no candidate inside selected scope",
      finalScore,
      strongSignals,
      contradictions,
      shouldAskClarification: true
    };
  }

  if (rejected || weakOnly) {
    return {
      answerMode: "clarification",
      answerConfidence: "low",
      confidenceReason: rejectedReason ?? "candidate was rejected by relevance evaluator",
      finalScore,
      strongSignals,
      contradictions,
      shouldAskClarification: true
    };
  }

  if (contradictions.length > 0) {
    return {
      answerMode: "clarification",
      answerConfidence: "low",
      confidenceReason: "critical contradiction detected",
      finalScore,
      strongSignals,
      contradictions,
      shouldAskClarification: true
    };
  }

  const lowerThresholdAllowed = finalScore >= 40 &&
    (strongSignals.includes("title_phrase_match") || strongSignals.includes("scientific_name_match"));
  const signalMinimum = finalScore >= 70 ? 1 : MIN_STRONG_SIGNALS;
  const enoughScore = finalScore >= CLASSIFICATION_MIN_SCORE || lowerThresholdAllowed;
  const enoughSignals = strongSignals.length >= signalMinimum;

  if (finalScore < 20) {
    return {
      answerMode: "clarification",
      answerConfidence: "low",
      confidenceReason: "final score below 20",
      finalScore,
      strongSignals,
      contradictions,
      shouldAskClarification: true
    };
  }

  if (!enoughScore || !enoughSignals) {
    return {
      answerMode: finalScore >= 20 ? "lookup" : "clarification",
      answerConfidence: "low",
      confidenceReason: !enoughSignals ? "insufficient strong signals" : "classification score below threshold",
      finalScore,
      strongSignals,
      contradictions,
      shouldAskClarification: finalScore < 20
    };
  }

  return {
    answerMode: "classification",
    answerConfidence: finalScore >= 70 ? "high" : "medium",
    confidenceReason: "score and strong evidence satisfy classification gate",
    finalScore,
    strongSignals,
    contradictions,
    shouldAskClarification: false
  };
}

function definitionGate(
  query: string,
  selectedSection: EnrichedRetrievedSection,
  candidates: CandidateRelevance[]
): GateResult {
  const effectiveCandidates = candidates.length === 0 ? [evaluateCandidateRelevance(selectedSection, query)] : candidates;
  const selected = selectedCandidate(effectiveCandidates, selectedSection);
  const finalScore = selected?.finalScore ?? selectedSection.score;
  const strongSignals = selected ? strongSignalsForCandidate(query, selectedSection, selected) : ["definition_selected"];
  const rejectedReason = selected?.rejectedReason ?? null;
  const shouldAsk = Boolean(selected?.rejected) || finalScore < 8 || isAmbiguousDefinitionQuery(query);
  return {
    answerMode: shouldAsk ? "clarification" : "definition",
    answerConfidence: shouldAsk ? "low" : finalScore >= 50 ? "high" : "medium",
    confidenceReason: shouldAsk ? rejectedReason ?? "definition query is too ambiguous" : "definition section is relevant",
    finalScore,
    strongSignals,
    contradictions: [],
    shouldAskClarification: shouldAsk
  };
}

function strongSignalsForCandidate(
  query: string,
  section: EnrichedRetrievedSection,
  candidate: CandidateRelevance
): string[] {
  const signals: string[] = [];
  const normalizedQuery = normalizeForIntent(query);
  const title = normalizeForIntent(`${section.title ?? ""} ${section.section ?? ""}`);
  const body = normalizeForIntent(`${section.text ?? ""}`);
  const captions = normalizeForIntent((section.captions ?? []).join(" "));
  const titleTokens = meaningfulIntentTokens(title);
  const queryTokens = meaningfulIntentTokens(normalizedQuery);
  const sharedTitleTokens = queryTokens.filter((token) => titleTokens.includes(token));

  if (candidate.matchedTerms.some((term) => HS_CODE_PATTERN.test(term))) signals.push("exact_hscode_match");
  if (candidate.candidateMatchedPhrases.some((phrase) => title.includes(normalizeForIntent(phrase))) || sharedTitleTokens.length >= 2) signals.push("title_phrase_match");
  if (candidate.candidateMatchedPhrases.length >= 1) signals.push("product_name_phrase_match");
  if (candidate.matchedTerms.some((term) => /^[a-z]{3,}\s+[a-z]{3,}/.test(term))) signals.push("scientific_name_match");
  if (candidate.numericMatches.length > 0 && candidate.candidateMatchedPhrases.length + candidate.matchedTerms.length > candidate.numericMatches.length) signals.push("numeric_range_match_plus_attribute");
  if (candidate.candidateMatchedPhrases.length >= 2) signals.push("multiple_body_phrase_matches");
  if (queryTokens.some((token) => captions.includes(token))) signals.push("caption_phrase_match");
  if (candidate.matchedTerms.some((term) => term.length >= 7 && !/^\d+(?:\.\d+)?$/.test(term))) signals.push("rare_token_overlap");
  if (["use", "used", "function", "purpose", "incense", "perfume", "breeding", "consumption", "food"].some((token) => normalizedQuery.includes(token) && body.includes(token))) signals.push("usage_function_match");
  if (["fresh", "frozen", "dried", "roasted", "raw", "chips", "powder", "seedling", "beans", "paste"].some((token) => normalizedQuery.includes(token) && `${title} ${body}`.includes(token))) signals.push("trade_form_match");
  return uniqueStrings(signals);
}

function contradictionsForCandidate(
  query: string,
  section: EnrichedRetrievedSection,
  candidate: CandidateRelevance
): string[] {
  const normalizedQuery = normalizeForIntent(query);
  const text = normalizeForIntent(`${section.title ?? ""} ${section.section ?? ""} ${section.text ?? ""}`);
  const contradictions: string[] = [];
  if (candidate.contrastTermOnlyMatch) contradictions.push("contrast_term_only_match");
  if (candidate.contrastTerms.some((term) => normalizeForIntent(`${section.title ?? ""}`).includes(normalizeForIntent(term))) && candidate.candidateMatchedPhrases.length === 0) {
    contradictions.push("contrast_title_without_positive_attribute");
  }
  if (normalizedQuery.includes("higher") && text.includes("lower") && !text.includes("higher") && candidate.matchedTerms.includes("lower")) contradictions.push("higher_lower_conflict");
  if (normalizedQuery.includes("lower") && text.includes("higher") && !text.includes("lower") && candidate.matchedTerms.includes("higher")) contradictions.push("lower_higher_conflict");
  if (normalizedQuery.includes("human consumption") && text.includes("not fit for human consumption")) contradictions.push("usage_conflict");
  return uniqueStrings(contradictions);
}

function numericLookupAnswer(query: string, section?: EnrichedRetrievedSection): string {
  const value = query.trim();
  if (!section) {
    return `Tìm thấy '${value}' trong metadata nhưng chưa đủ thông tin để xác định HS Code chắc chắn. Vui lòng cung cấp thêm mô tả sản phẩm nếu muốn xác định mã HS chắc chắn.`;
  }
  return `Tìm thấy '${value}' trong section ${normalizedTitle(section)}. HS Code liên quan: ${formatCodes(hsCodesForSection(section))}. Vui lòng cung cấp thêm mô tả sản phẩm nếu muốn xác định mã HS chắc chắn.`;
}

function ambiguousLookupAnswer(section: EnrichedRetrievedSection): string {
  return `Tìm thấy section ${normalizedTitle(section)}. HS Code liên quan: ${formatCodes(hsCodesForSection(section))}. Vui lòng cung cấp thêm mô tả sản phẩm, trạng thái hàng hóa, công dụng hoặc thành phần để xác định HS Code chính xác hơn.`;
}

function clarificationAnswer(): string {
  return "Chưa đủ thông tin để xác định HS Code chắc chắn. Vui lòng cung cấp thêm mô tả sản phẩm, thành phần, công dụng, trạng thái hàng hóa hoặc thông số kỹ thuật.";
}

function deterministicGate(
  answerMode: AnswerMode,
  answerConfidence: AnswerConfidence,
  finalScore: number,
  strongSignals: string[],
  confidenceReason: string
): GateResult {
  return {
    answerMode,
    answerConfidence,
    confidenceReason,
    finalScore,
    strongSignals,
    contradictions: [],
    shouldAskClarification: false
  };
}

function debugGateFields(gate: GateResult): Partial<QaDebugInfo> {
  return {
    answerMode: gate.answerMode,
    answerConfidence: gate.answerConfidence,
    confidenceReason: gate.confidenceReason,
    finalScore: gate.finalScore,
    strongSignals: gate.strongSignals,
    contradictions: gate.contradictions
  };
}

function formatChapterSummaryAnswer(
  chapterNumber: number | undefined,
  items: Array<{ title: string; codes: string[] }>,
  fallback: string
): string {
  if (chapterNumber === undefined || items.length === 0) {
    return fallback;
  }
  return [
    `Chapter ${chapterNumber} nói về các nội dung chính:`,
    ...items.map((item) => `- ${item.title} — HS Code: ${item.codes.join(", ")}.`)
  ].join("\n");
}

export function hasChapterMarker(normalizedQuery: string): boolean {
  return /\b(?:chuong|chapter)\s+\d{1,3}\b/.test(normalizedQuery) ||
    /\bchapter[\s_-]*\d{1,3}\b/.test(normalizedQuery);
}

export function extractChapterNumber(normalizedQuery: string): number | undefined {
  const match = normalizedQuery.match(/\b(?:chuong|chapter)\s+(\d{1,3})\b/) ??
    normalizedQuery.match(/\bchapter[\s_-]*(\d{1,3})\b/);
  return match ? Number(match[1]) : undefined;
}

export function hasSummaryVerb(normalizedQuery: string): boolean {
  return /\b(tom\s+tat|noi\s+dung|noi\s+ve|ve\s+gi|co\s+gi|gom|liet\s+ke|main\s+content|about|cover)\b/.test(normalizedQuery) ||
    /\bwhat\s+is\s+(?:chuong|chapter)\s+\d{1,3}\s+about\b/.test(normalizedQuery) ||
    /\bwhat\s+does\s+(?:chuong|chapter)\s+\d{1,3}\s+cover\b/.test(normalizedQuery);
}

function extractChapterSummaryNumber(normalized: string): number | undefined {
  const patterns = [
    /\btom\s+tat\s+(?:chuong|chapter)\s+(\d{1,3})\b/,
    /\bnoi\s+dung\s+chinh\s+(?:chuong|chapter)\s+(\d{1,3})\b/,
    /\b(?:chuong|chapter)\s+(\d{1,3})\s+co\s+gi\b/,
    /\b(?:chuong|chapter)\s+(\d{1,3})\s+noi\s+ve(?:\s+cai)?\s+(?:gi|j)\b/,
    /\b(?:chuong|chapter)\s+(\d{1,3})\s+co\s+noi\s+dung\s+gi\b/,
    /\b(?:chuong|chapter)\s+(\d{1,3})\s+gom(?:\s+nhung)?\s+gi\b/,
    /\b(?:chuong|chapter)\s+(\d{1,3})\s+ve\s+gi\b/,
    /\bwhat\s+is\s+(?:chuong|chapter)\s+(\d{1,3})\s+about\b/,
    /\bwhat\s+does\s+(?:chuong|chapter)\s+(\d{1,3})\s+cover\b/,
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
    /chuong\s+(\d+)/i,
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

function sectionIdentity(section: SectionMetadata | EnrichedRetrievedSection): string {
  return [section.document, section.hsCode, section.section || section.title].filter(Boolean).join("|");
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

function selectedCandidate(candidates: CandidateRelevance[], section: EnrichedRetrievedSection): CandidateRelevance | undefined {
  const codes = new Set(hsCodesForSection(section));
  return candidates.find((candidate) =>
    candidate.document === section.document &&
    (candidate.hsCode && codes.has(candidate.hsCode) ||
      candidate.groupedHsCodes.some((code) => codes.has(code)) ||
      normalizeForIntent(candidate.title ?? "") === normalizeForIntent(section.title ?? "") ||
      normalizeForIntent(candidate.section ?? "") === normalizeForIntent(section.section ?? ""))
  );
}

function topCandidate(candidates: CandidateRelevance[]): CandidateRelevance | undefined {
  return [...candidates].sort((left, right) => right.finalScore - left.finalScore)[0];
}

function isNumericOnlyQuery(query: string): boolean {
  return /^\s*\d+(?:[.,]\d+)?\s*%?\s*$/.test(query);
}

function isAmbiguousProductQuery(query: string): boolean {
  if (query.match(HS_CODE_PATTERN)) return false;
  return meaningfulIntentTokens(query).length < 2;
}

function isAmbiguousDefinitionQuery(query: string): boolean {
  const normalized = normalizeForIntent(query).replace(/\b(what|define|definition|la|gi|duoc|dinh|nghia|is|are)\b/g, " ");
  return meaningfulIntentTokens(normalized).length < 1;
}

function meaningfulIntentTokens(value: string): string[] {
  const stopwords = new Set([
    "the", "and", "for", "with", "what", "which", "define", "definition", "code", "hscode",
    "hang", "hoa", "san", "pham", "duoc", "dinh", "nghia", "thuoc", "loai", "nao",
    "cua", "cho", "trong", "mot", "cac", "voi", "hon", "khac", "thay", "khong",
    "phai", "is", "are", "was", "were", "this", "that", "chapter", "chuong",
    "noi", "dung", "tom", "tat", "document", "file"
  ]);
  return uniqueStrings(normalizeForIntent(value)
    .split(/[^a-z0-9.]+/g)
    .filter((token) => token.length >= 3 || /^\d+(?:\.\d+)?$/.test(token))
    .filter((token) => !stopwords.has(token) && !/^\d+$/.test(token)));
}

function normalizedTitle(section: EnrichedRetrievedSection): string {
  return normalizeProductTitle(section.title || titleFromSection(section.section) || section.section || "section phu hop");
}

function formatCodes(codes: string[]): string {
  if (codes.length === 0) return "chưa có trong metadata";
  if (codes.length === 1) return codes[0];
  return codes.join(" hoặc ");
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
