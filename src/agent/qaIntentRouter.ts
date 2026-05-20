import {
  HS_CODE_PATTERN,
  buildStructuredAnswer,
  evaluateCandidateRelevance,
  hsCodesForSection,
  isDefinitionStyleQuestion,
  normalizeProductTitle,
  prefersVietnameseAnswer,
  renderHsCodeAnswer,
  type CandidateRelevance,
  type EnrichedRetrievedSection,
  type RenderedHsCodeAnswer,
  type SectionMetadata
} from "./qaAnswerFormatter";
import {
  planQueryWithRules,
  type PlannerSource,
  type QueryPlan
} from "./queryPlanner";
import {
  canonicalRequestedFieldFromText,
  extractRequestedField,
  type FieldExtractionConfidence
} from "./fieldExtractor";
import { sanitizeFinalAnswer } from "./qaAnswerSanitizer";
import {
  applyCandidateDocumentScope,
  detectAmbiguousLookup,
  detectBroadQuery,
  groupDistinctBroadLookupCandidates,
  validatedCandidatesFromRelevance,
  type BroadQueryDecision
} from "./qaBroadLookup";

export { sanitizeFinalAnswer } from "./qaAnswerSanitizer";
export {
  applyCandidateDocumentScope,
  detectAmbiguousLookup,
  detectBroadQuery,
  groupDistinctBroadLookupCandidates
} from "./qaBroadLookup";

export type QaIntent =
  | "exact_hscode_lookup"
  | "product_classification"
  | "definition"
  | "chapter_summary"
  | "document_summary"
  | "selected_section_qa"
  | "section_attribute_question"
  | "comparison"
  | "clarification_needed";

export type AnswerMode =
  | "classification"
  | "lookup"
  | "numeric_lookup"
  | "broad_lookup"
  | "ambiguous_lookup"
  | "clarification"
  | "exact_hscode_lookup"
  | "chapter_summary"
  | "document_summary"
  | "selected_section_qa"
  | "definition"
  | "section_attribute_question"
  | "comparison"
  | "clarification_needed";

export type AnswerConfidence = "high" | "medium" | "low";
export type QaAnswerGenerationMode =
  | "template-classification"
  | "extractive-definition"
  | "extractive-field"
  | "broad-lookup"
  | "llm-selected-section"
  | "safe-fallback";

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
  queryPlan?: QueryPlan;
  plannerSource?: PlannerSource;
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

export interface LocalSelectedSectionAnswer {
  answer: string | undefined;
  answerGeneration: QaAnswerGenerationMode | null;
  fallbackReason: string | null;
  fieldExtraction?: {
    requestedField: string | null;
    matchedHeading: string | null;
    confidence: FieldExtractionConfidence;
    fallbackUsed: boolean;
  };
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
  queryPlan?: QueryPlan;
  plannerSource?: PlannerSource;
  selectedHandler?: string;
  fieldExtraction?: {
    requestedField: string | null;
    matchedHeading: string | null;
    confidence: FieldExtractionConfidence;
    fallbackUsed: boolean;
  };
  answerGeneration?: QaAnswerGenerationMode | string;
  llmCalled?: boolean;
  llmSkippedReason?: string | null;
  llmErrorType?: string | null;
  sectionTextChars?: number;
  selectedSectionTextChars?: number;
  contextChars?: number;
  fallbackReason?: string | null;
  localExtractorUsed?: boolean;
  localExtractorConfidence?: AnswerConfidence | null;
  localExtractorReason?: string | null;
  hsCodeAttached?: boolean;
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
  const rulePlan = planQueryWithRules(query);
  if (rulePlan) {
    return intentDetectionFromQueryPlan(rulePlan, "rule");
  }
  if (/^\s*\d+(?:[.,]\d+)?\s*%?\s*$/.test(query)) {
    return {
      intent: "clarification_needed",
      confidence: 0.3,
      reason: "numeric-only query is not enough for classification",
      plannerSource: "fallback"
    };
  }
  const explicitHsQuestion = asksForHsCodeOrClassification(query);
  if (!explicitHsQuestion && isDefinitionStyleQuestion(query) && !isUsageStyleQuestion(query) && !isAmbiguousDefinitionQuery(query)) {
    return {
      intent: "definition",
      confidence: 0.75,
      reason: "query asks for a definition or meaning",
      definitionTerm: extractDefinitionTarget(query),
      plannerSource: "fallback"
    };
  }
  const requestedField = canonicalRequestedFieldFromText(query);
  if (!explicitHsQuestion && requestedField) {
    return {
      intent: "section_attribute_question",
      confidence: 0.78,
      reason: "query asks for a specific section attribute or field",
      queryPlan: {
        intent: "section_attribute_question",
        target: null,
        requestedField,
        needsHsCode: false,
        language: "unknown",
        confidence: "medium",
        reason: "rule-based attribute field detection"
      },
      plannerSource: "fallback"
    };
  }
  if (!explicitHsQuestion && isComparisonIntentQuestion(query)) {
    return {
      intent: "comparison",
      confidence: 0.72,
      reason: "query asks for comparison or contrast evidence",
      plannerSource: "fallback"
    };
  }
  return {
    intent: explicitHsQuestion ? "product_classification" : "selected_section_qa",
    confidence: query.trim() ? 0.65 : 0.3,
    reason: explicitHsQuestion
      ? "query explicitly asks for HS code/classification after section retrieval"
      : "general selected-section Q&A flow",
    plannerSource: "fallback"
  };
}

export function intentDetectionFromQueryPlan(plan: QueryPlan, plannerSource?: PlannerSource): IntentDetection {
  const confidence = plan.confidence === "high" ? 0.95 : plan.confidence === "medium" ? 0.65 : 0.3;
  const normalizedTarget = normalizeForIntent(plan.target ?? "");
  return {
    intent: plan.intent,
    confidence: plan.intent === "exact_hscode_lookup" ? 1 : confidence,
    reason: plan.reason,
    exactHsCode: plan.intent === "exact_hscode_lookup" ? plan.target?.match(HS_CODE_PATTERN)?.[0] : undefined,
    chapterNumber: plan.intent === "chapter_summary" ? extractChapterNumber(normalizedTarget) : undefined,
    documentName: plan.intent === "document_summary" ? plan.target ?? undefined : undefined,
    definitionTerm: plan.intent === "definition" ? plan.target ?? undefined : undefined,
    queryPlan: plan,
    plannerSource
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
  const finalAnswer = selected
    ? prefersVietnameseAnswer(query)
      ? answer
      : `HS Code ${exactCode} is ${normalizeProductTitle(title)}.`
    : answer;

  return {
    intent: "exact_hscode_lookup",
    answerMode: gate.answerMode,
    answerConfidence: gate.answerConfidence,
    answer: sanitizeFinalAnswer(finalAnswer),
    selectedPrimary,
    documentSummary: null,
    citations: selectedPrimary ? [selectedPrimary] : [],
    debug: buildDebug(baseDebug, detection, {
      selectedHandler: "exact_hscode_lookup",
      selectedPrimary,
      candidateRejectionReasons: [],
      exactHsCode: exactCode,
      answerGeneration: baseDebug.answerGeneration ?? "template-classification",
      broadQueryDecision: { isBroad: false, reason: "exact HS code lookup bypasses broad handling", suggestedMode: "normal" },
      finalAnswerSanitized: true,
      scopeApplied: true,
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
    answer: sanitizeFinalAnswer(formatChapterSummaryAnswer(chapterNumber, items, answer)),
    selectedPrimary: null,
    documentSummary,
    citations: [],
    debug: buildDebug(baseDebug, detection, {
      selectedHandler: "chapter_summary",
      resolvedDocument: resolved,
      selectedPrimary: null,
      candidateRejectionReasons: [],
      broadQueryDecision: { isBroad: false, reason: "chapter summary bypasses broad handling", suggestedMode: "normal" },
      finalAnswerSanitized: true,
      scopeApplied: true,
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
    answer: sanitizeFinalAnswer(answer),
    selectedPrimary: null,
    documentSummary,
    citations: [],
    debug: buildDebug(baseDebug, detection, {
      selectedHandler: "document_summary",
      resolvedDocument: resolved,
      selectedPrimary: null,
      candidateRejectionReasons: [],
      broadQueryDecision: { isBroad: false, reason: "document summary bypasses broad handling", suggestedMode: "normal" },
      finalAnswerSanitized: true,
      scopeApplied: true,
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
  baseDebug: Partial<QaDebugInfo> = {},
  localAnswer?: string
): RoutedQaAnswer {
  if (detection.queryPlan?.confidence === "low") {
    return emptyIntentAnswer("definition", clarificationAnswer(), detection, candidates, baseDebug, {
      answerMode: "clarification",
      answerConfidence: "low",
      confidenceReason: "query plan confidence is low",
      finalScore: 0,
      strongSignals: [],
      contradictions: [],
      shouldAskClarification: true
    });
  }
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
  const cleanedLocalAnswer = cleanDefinitionLocalAnswer(localAnswer);
  if (cleanedLocalAnswer) {
    const selectedPrimary = publicSection(selectedSection);
    return {
      intent: "definition",
      answerMode: gate.answerMode,
      answerConfidence: gate.answerConfidence,
      answer: sanitizeFinalAnswer(cleanedLocalAnswer),
      selectedPrimary,
      documentSummary: null,
      citations: [selectedPrimary],
      debug: buildDebug(baseDebug, detection, {
        selectedHandler: "definition",
        selectedPrimary,
        selectedPrimaryId: sectionIdentity(selectedSection),
        candidateRejectionReasons: candidateRejections(candidates),
        finalHsCodes: answerMentionsHsCode(cleanedLocalAnswer) ? hsCodesForSection(selectedSection) : [],
        answerGeneration: baseDebug.answerGeneration ?? "extractive-definition",
        answerRepairApplied: false,
        structuredAnswer: buildStructuredAnswer(selectedSection, undefined, query),
        rejectedReason: selectedCandidate(candidates, selectedSection)?.rejectedReason ?? null,
        finalAnswerSanitized: true,
        scopeApplied: true,
        ...debugGateFields(gate)
      })
    };
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
    return emptyIntentAnswer("product_classification", gate.answerMode === "numeric_lookup" ? numericOnlyClarificationAnswer(query) : clarificationAnswer(), detection, candidates, baseDebug, gate);
  }
  let broadDecision = detectBroadQuery({
    originalQuery: query,
    validatedCandidates: validatedCandidatesFromRelevance(candidates)
  });
  if (broadDecision.isBroad && selectedCandidateHasDecisiveEvidence(candidates, selectedSection)) {
    broadDecision = {
      isBroad: false,
      reason: "selected candidate has decisive validation evidence",
      suggestedMode: "normal"
    };
  }
  const hasTemplateAnswer = Boolean(llmAnswer?.trim()) && baseDebug.answerGeneration === "template-classification";
  if (broadDecision.isBroad && !hasTemplateAnswer) {
    const lookupCandidates = lookupCandidatesForAnswer(selectedSection, alternatives, candidates);
    if (broadDecision.suggestedMode === "broad_lookup" && groupDistinctBroadLookupCandidates(lookupCandidates).length === 1) {
      const gate = productGate(query, selectedSection, candidates);
      const rendered = renderHsCodeAnswer(llmAnswer, selectedSection, alternatives, { question: query, answerStyle: "class-eval" });
      return renderedIntentAnswer("product_classification", rendered, selectedSection, candidates, detection, baseDebug, gate);
    }
    if (broadDecision.suggestedMode === "broad_lookup" && lookupCandidates.length > 0) {
      return broadLookupIntentAnswer("product_classification", query, lookupCandidates, selectedSection, detection, baseDebug, broadDecision);
    }
    const gate = deterministicGate("clarification", "low", topCandidate(candidates)?.finalScore ?? 0, [], broadDecision.reason);
    return emptyIntentAnswer("product_classification", numericOnlyClarificationAnswer(query, selectedSection), detection, candidates, baseDebug, gate, broadDecision);
  }

  const gate = productGate(query, selectedSection, candidates);
  if (gate.answerMode === "numeric_lookup") {
    return lookupIntentAnswer("product_classification", numericOnlyClarificationAnswer(query, selectedSection), selectedSection, candidates, detection, baseDebug, gate);
  }
  if (gate.answerMode === "ambiguous_lookup" || gate.answerMode === "lookup") {
    const lookupCandidates = lookupCandidatesForAnswer(selectedSection, alternatives, candidates);
    if (lookupCandidates.length > 0) {
      return multiResultLookupIntentAnswer("product_classification", query, lookupCandidates, selectedSection, detection, baseDebug, gate);
    }
    return emptyIntentAnswer("product_classification", clarificationAnswer(), detection, candidates, baseDebug, gate);
  }
  if (gate.shouldAskClarification) {
    return emptyIntentAnswer("product_classification", clarificationAnswer(), detection, candidates, baseDebug, gate);
  }
  const rendered = renderHsCodeAnswer(llmAnswer, selectedSection, alternatives, { question: query, answerStyle: "class-eval" });
  return renderedIntentAnswer("product_classification", rendered, selectedSection, candidates, detection, baseDebug, gate);
}

export function extractLocalSelectedSectionAnswer(
  query: string,
  selectedSection: EnrichedRetrievedSection | undefined,
  detection: IntentDetection = detectIntent(query)
): LocalSelectedSectionAnswer {
  if (!selectedSection) {
    return {
      answer: undefined,
      answerGeneration: null,
      fallbackReason: "no_selected_section"
    };
  }

  const sectionText = [selectedSection.text, ...(selectedSection.captions ?? [])]
    .filter(Boolean)
    .join("\n\n")
    .trim();
  if (!sectionText) {
    return {
      answer: undefined,
      answerGeneration: null,
      fallbackReason: "missing_section_text"
    };
  }

  const requestedField = detection.queryPlan?.requestedField ??
    canonicalRequestedFieldFromText(query) ??
    (isDefinitionStyleQuestion(query) ? "definition" : null);
  if (!requestedField) {
    return {
      answer: undefined,
      answerGeneration: null,
      fallbackReason: "local_extractor_no_requested_field"
    };
  }

  const extracted = extractRequestedField(sectionText, requestedField);
  const fieldExtraction = {
    requestedField,
    matchedHeading: extracted.matchedHeading,
    confidence: extracted.confidence,
    fallbackUsed: extracted.fallbackUsed
  };
  const answer = cleanSelectedSectionAnswer(extracted.extractedText, query);
  if (answer) {
    return {
      answer,
      answerGeneration: requestedField === "definition" ? "extractive-definition" : "extractive-field",
      fallbackReason: null,
      fieldExtraction
    };
  }

  return {
    answer: undefined,
    answerGeneration: null,
    fallbackReason: "local_extractor_no_match",
    fieldExtraction
  };
}

export function handleSelectedSectionQa(
  query: string,
  selectedSection: EnrichedRetrievedSection | undefined,
  llmAnswer: string | undefined = undefined,
  candidates: CandidateRelevance[] = [],
  detection: IntentDetection = detectIntent(query),
  baseDebug: Partial<QaDebugInfo> = {}
): RoutedQaAnswer {
  if (asksForHsCodeOrClassification(query)) {
    return handleProductClassification(query, selectedSection, [], undefined, candidates, detection, baseDebug);
  }

  if (!selectedSection) {
    return emptyIntentAnswer("selected_section_qa", clarificationAnswer(), detection, candidates, baseDebug, {
      answerMode: "clarification",
      answerConfidence: "low",
      confidenceReason: "no sufficiently relevant section found",
      finalScore: 0,
      strongSignals: [],
      contradictions: [],
      shouldAskClarification: true
    });
  }

  const broadDecision = meaningfulIntentTokens(query).length <= 1 ? detectBroadQuery({
    originalQuery: query,
    validatedCandidates: validatedCandidatesFromRelevance(candidates)
  }) : { isBroad: false, reason: "multi-token selected-section question uses normal QA", suggestedMode: "normal" } satisfies BroadQueryDecision;
  if (broadDecision.isBroad) {
    const lookupCandidates = lookupCandidatesForAnswer(selectedSection, [], candidates);
    if (broadDecision.suggestedMode === "broad_lookup" && lookupCandidates.length > 0) {
      return broadLookupIntentAnswer("selected_section_qa", query, lookupCandidates, selectedSection, detection, baseDebug, broadDecision);
    }
    const gate = deterministicGate("clarification", "low", topCandidate(candidates)?.finalScore ?? 0, [], broadDecision.reason);
    return emptyIntentAnswer("selected_section_qa", isNumericOnlyQuery(query) ? numericOnlyClarificationAnswer(query, selectedSection) : clarificationAnswer(), detection, candidates, baseDebug, gate, broadDecision);
  }

  const gate = selectedSectionGate(selectedSection, candidates);
  if (gate.shouldAskClarification) {
    return emptyIntentAnswer("selected_section_qa", clarificationAnswer(), detection, candidates, baseDebug, gate);
  }

  const selectedPrimary = publicSection(selectedSection);
  let cleanedAnswer = cleanSelectedSectionAnswer(llmAnswer, query);
  let effectiveFallbackReason = baseDebug.fallbackReason ?? null;
  let effectiveAnswerGeneration = typeof baseDebug.answerGeneration === "string" ? baseDebug.answerGeneration : undefined;
  let fieldExtraction = baseDebug.fieldExtraction;
  if (!cleanedAnswer && baseDebug.answerGeneration !== "safe-fallback") {
    const localAnswer = extractLocalSelectedSectionAnswer(query, selectedSection, detection);
    if (localAnswer.answer) {
      cleanedAnswer = cleanSelectedSectionAnswer(localAnswer.answer, query);
      effectiveAnswerGeneration = localAnswer.answerGeneration ?? effectiveAnswerGeneration;
      effectiveFallbackReason = null;
      fieldExtraction = localAnswer.fieldExtraction;
    } else {
      effectiveFallbackReason = effectiveFallbackReason ?? localAnswer.fallbackReason;
      fieldExtraction = fieldExtraction ?? localAnswer.fieldExtraction;
    }
  }
  effectiveAnswerGeneration = effectiveAnswerGeneration ?? (cleanedAnswer ? "llm-selected-section" : "safe-fallback");
  const usedGeneratedAnswer = Boolean(cleanedAnswer) && !effectiveFallbackReason && effectiveAnswerGeneration !== "safe-fallback";
  const answer = maybeAppendRelatedHsCode(
    cleanedAnswer || safeSelectedSectionFallbackAnswer(selectedSection),
    query,
    selectedSection,
    gate,
    usedGeneratedAnswer
  );
  const finalHsCodes = answerMentionsHsCode(answer) ? hsCodesForSection(selectedSection) : [];
  return {
    intent: "selected_section_qa",
    answerMode: "selected_section_qa",
    answerConfidence: gate.answerConfidence,
    answer: sanitizeFinalAnswer(answer),
    selectedPrimary,
    documentSummary: null,
    citations: [selectedPrimary],
    debug: buildDebug(baseDebug, detection, {
      selectedHandler: "selected_section_qa",
      selectedPrimary,
      selectedPrimaryId: sectionIdentity(selectedSection),
      candidateRejectionReasons: candidateRejections(candidates),
      finalHsCodes,
      answerGeneration: effectiveAnswerGeneration,
      fallbackReason: effectiveFallbackReason,
      fieldExtraction,
      rejectedReason: selectedCandidate(candidates, selectedSection)?.rejectedReason ?? null,
      finalAnswerSanitized: true,
      scopeApplied: true,
      ...debugGateFields(gate)
    })
  };
}

export function handleClarificationNeeded(
  query: string,
  detection: IntentDetection = detectIntent(query),
  baseDebug: Partial<QaDebugInfo> = {}
): RoutedQaAnswer {
  const gate = deterministicGate(
    "clarification",
    "low",
    0,
    [],
    detection.reason || "query needs clarification"
  );
  return {
    intent: detection.intent,
    answerMode: gate.answerMode,
    answerConfidence: gate.answerConfidence,
    answer: sanitizeFinalAnswer(clarificationAnswer()),
    selectedPrimary: null,
    documentSummary: null,
    citations: [],
    debug: buildDebug(baseDebug, detection, {
      selectedHandler: detection.intent,
      selectedPrimary: null,
      candidateRejectionReasons: [],
      ...debugGateFields(gate)
    })
  };
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
    answer: sanitizeFinalAnswer(rendered.answer),
    selectedPrimary,
    documentSummary: null,
    citations: rendered.citations.map(publicSection),
    debug: buildDebug(baseDebug, detection, {
      selectedHandler: intent,
      selectedPrimary,
      selectedPrimaryId: sectionIdentity(selectedSection),
      candidateRejectionReasons: candidateRejections(candidates),
      finalHsCodes: rendered.finalHsCodes,
      answerGeneration: baseDebug.answerGeneration ??
        (intent === "definition" ? "extractive-definition" : intent === "product_classification" ? "template-classification" : undefined),
      answerRepairApplied: rendered.answerRepairApplied,
      structuredAnswer: buildStructuredAnswer(selectedSection, undefined),
      rejectedReason: selectedCandidate(candidates, selectedSection)?.rejectedReason ?? null,
      finalAnswerSanitized: true,
      scopeApplied: true,
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
    answer: sanitizeFinalAnswer(answer),
    selectedPrimary,
    documentSummary: null,
    citations: [selectedPrimary],
    debug: buildDebug(baseDebug, detection, {
      selectedHandler: intent,
      selectedPrimary,
      selectedPrimaryId: sectionIdentity(selectedSection),
      candidateRejectionReasons: candidateRejections(candidates),
      finalHsCodes: hsCodesForSection(selectedSection),
      rejectedReason: selectedCandidate(candidates, selectedSection)?.rejectedReason ?? null,
      finalAnswerSanitized: true,
      scopeApplied: true,
      ...debugGateFields(gate)
    })
  };
}

function multiResultLookupIntentAnswer(
  intent: QaIntent,
  query: string,
  candidates: CandidateRelevance[],
  selectedSection: EnrichedRetrievedSection | undefined,
  detection: IntentDetection,
  baseDebug: Partial<QaDebugInfo>,
  gate: GateResult
): RoutedQaAnswer {
  const listedCandidates = groupDistinctBroadLookupCandidates(candidates)
    .sort((left, right) => right.finalScore - left.finalScore)
    .slice(0, 5);
  const selectedPrimary = selectedSection ? publicSection(selectedSection) : null;
  return {
    intent,
    answerMode: gate.answerMode,
    answerConfidence: gate.answerConfidence,
    answer: sanitizeFinalAnswer(broadLookupUserAnswer(query, listedCandidates)),
    selectedPrimary,
    documentSummary: null,
    citations: listedCandidates.map(publicCandidate),
    debug: buildDebug(baseDebug, detection, {
      selectedHandler: intent,
      selectedPrimary,
      selectedPrimaryId: selectedSection ? sectionIdentity(selectedSection) : undefined,
      candidateRejectionReasons: candidateRejections(candidates),
      finalHsCodes: selectedSection ? hsCodesForSection(selectedSection) : [],
      answerGeneration: "broad-lookup",
      broadQueryDecision: { isBroad: true, reason: gate.confidenceReason, suggestedMode: "broad_lookup" },
      broadLookupCandidates: listedCandidates.map(publicCandidate),
      rejectedReason: selectedSection ? selectedCandidate(candidates, selectedSection)?.rejectedReason ?? null : topCandidate(candidates)?.rejectedReason ?? null,
      finalAnswerSanitized: true,
      scopeApplied: true,
      ...debugGateFields(gate)
    })
  };
}

function broadLookupIntentAnswer(
  intent: QaIntent,
  query: string,
  candidates: CandidateRelevance[],
  selectedSection: EnrichedRetrievedSection | undefined,
  detection: IntentDetection,
  baseDebug: Partial<QaDebugInfo>,
  decision: BroadQueryDecision
): RoutedQaAnswer {
  const listedCandidates = groupDistinctBroadLookupCandidates(candidates)
    .sort((left, right) => right.finalScore - left.finalScore)
    .slice(0, 5);
  const gate = deterministicGate(
    decision.suggestedMode === "clarification" ? "clarification" : "broad_lookup",
    "low",
    topCandidate(listedCandidates)?.finalScore ?? 0,
    [],
    decision.reason
  );
  const selectedPrimary = selectedSection ? publicSection(selectedSection) : null;
  return {
    intent,
    answerMode: gate.answerMode,
    answerConfidence: gate.answerConfidence,
    answer: sanitizeFinalAnswer(decision.suggestedMode === "clarification"
      ? numericOnlyClarificationAnswer(query, selectedSection)
      : broadLookupUserAnswer(query, listedCandidates)),
    selectedPrimary: null,
    documentSummary: null,
    citations: listedCandidates.map(publicCandidate),
    debug: buildDebug(baseDebug, detection, {
      selectedHandler: intent,
      selectedPrimary,
      candidateRejectionReasons: [],
      finalHsCodes: [],
      answerGeneration: "broad-lookup",
      broadQueryDecision: decision,
      broadLookupCandidates: listedCandidates.map(publicCandidate),
      candidateCount: candidates.length,
      finalAnswerSanitized: true,
      scopeApplied: true,
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
  gate: GateResult = deterministicGate("clarification", "low", 0, [], "no selected section"),
  broadQueryDecision: BroadQueryDecision = { isBroad: false, reason: "not evaluated", suggestedMode: "normal" }
): RoutedQaAnswer {
  return {
    intent,
    answerMode: gate.answerMode,
    answerConfidence: gate.answerConfidence,
    answer: sanitizeFinalAnswer(answer),
    selectedPrimary: null,
    documentSummary: null,
    citations: [],
    debug: buildDebug(baseDebug, detection, {
      selectedHandler: intent,
      selectedPrimary: null,
      candidateRejectionReasons: candidateRejections(candidates),
      rejectedReason: topCandidate(candidates)?.rejectedReason ?? null,
      broadQueryDecision,
      finalAnswerSanitized: true,
      scopeApplied: true,
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
    queryPlan: detection.queryPlan,
    plannerSource: detection.plannerSource,
    resolvedDocument: null,
    selectedPrimary: null,
    candidateRejectionReasons: [],
    broadQueryDecision: { isBroad: false, reason: "not evaluated", suggestedMode: "normal" },
    broadLookupCandidates: [],
    finalAnswerSanitized: true,
    scopeApplied: true,
    ...baseDebug,
    ...overrides
  };
}

const CLASSIFICATION_MIN_SCORE = 35;
const MIN_STRONG_SIGNALS = 1;

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
  const strongSignals = selectedSection && selected ? uniqueStrings([
    ...strongSignalsForCandidate(query, selectedSection, selected),
    ...(selected.validation?.strongSignals ?? [])
  ]) : [];
  const contradictions = selectedSection && selected ? contradictionsForCandidate(query, selectedSection, selected) : [];
  const shortQuery = isAmbiguousProductQuery(query);
  const numericOnly = isNumericOnlyQuery(query);
  const rejectedReason = selected?.rejectedReason ?? null;
  const rejected = Boolean(selected?.rejected);
  const weakOnly = Boolean(rejectedReason && /weak generic|bare numbers|contrast baseline/i.test(rejectedReason));
  const weakExpansionOnly = candidateMatchesOnlyWeakExpansion(selected);
  const validation = selected?.validation;

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

  if (validation && !validation.accepted) {
    return {
      answerMode: "clarification",
      answerConfidence: "low",
      confidenceReason: validation.reason,
      finalScore,
      strongSignals,
      contradictions,
      shouldAskClarification: true
    };
  }

  if (weakExpansionOnly) {
    return {
      answerMode: "lookup",
      answerConfidence: "low",
      confidenceReason: "candidate matched only weak query expansion terms",
      finalScore,
      strongSignals,
      contradictions,
      shouldAskClarification: false
    };
  }

  if (validation?.confidence === "low") {
    return {
      answerMode: "lookup",
      answerConfidence: "low",
      confidenceReason: validation.reason,
      finalScore,
      strongSignals,
      contradictions,
      shouldAskClarification: false
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

  const lowerThresholdAllowed = finalScore >= 30 &&
    (strongSignals.includes("title_phrase_match") || strongSignals.includes("scientific_name_match") || strongSignals.includes("product_name_phrase_match"));
  const signalMinimum = MIN_STRONG_SIGNALS;
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
  const strongSignals = selected ? uniqueStrings([
    ...strongSignalsForCandidate(query, selectedSection, selected),
    ...(selected.validation?.strongSignals ?? [])
  ]) : ["definition_selected"];
  const rejectedReason = selected?.rejectedReason ?? null;
  const weakExpansionOnly = candidateMatchesOnlyWeakExpansion(selected);
  const validation = selected?.validation;
  const validationRejects = validation ? !validation.accepted || validation.confidence === "low" : false;
  const shouldAsk = Boolean(selected?.rejected) || validationRejects || weakExpansionOnly || finalScore < 8 || isAmbiguousDefinitionQuery(query);
  return {
    answerMode: shouldAsk ? "clarification" : "definition",
    answerConfidence: shouldAsk ? "low" : finalScore >= 50 ? "high" : "medium",
    confidenceReason: shouldAsk ? rejectedReason ?? validation?.reason ?? (weakExpansionOnly ? "candidate matched only weak query expansion terms" : "definition query is too ambiguous") : "definition section is relevant",
    finalScore,
    strongSignals,
    contradictions: [],
    shouldAskClarification: shouldAsk
  };
}

function sectionAttributeGate(
  selectedSection: EnrichedRetrievedSection,
  candidates: CandidateRelevance[]
): GateResult {
  const selected = selectedCandidate(candidates, selectedSection);
  const finalScore = selected?.finalScore ?? selectedSection.score ?? 0;
  const rejectedReason = selected?.rejectedReason ?? null;
  const rejected = Boolean(selected?.rejected);
  const weakExpansionOnly = candidateMatchesOnlyWeakExpansion(selected);
  const validation = selected?.validation;
  const validationRejects = validation ? !validation.accepted || validation.confidence === "low" : false;
  const shouldAsk = rejected || validationRejects || weakExpansionOnly || finalScore < 8;
  return {
    answerMode: shouldAsk ? "clarification" : "section_attribute_question",
    answerConfidence: shouldAsk ? "low" : finalScore >= 50 ? "high" : "medium",
    confidenceReason: shouldAsk ? rejectedReason ?? validation?.reason ?? (weakExpansionOnly ? "candidate matched only weak query expansion terms" : "selected section relevance is low") : "selected section is relevant for requested field extraction",
    finalScore,
    strongSignals: selected ? uniqueStrings([...selected.candidateMatchedPhrases, ...selected.candidateMatchedTokens, ...(selected.validation?.strongSignals ?? [])]).slice(0, 8) : [],
    contradictions: selected?.contrastTermOnlyMatch ? ["contrast_term_only_match"] : [],
    shouldAskClarification: shouldAsk
  };
}

function selectedSectionGate(
  selectedSection: EnrichedRetrievedSection,
  candidates: CandidateRelevance[]
): GateResult {
  const selected = selectedCandidate(candidates, selectedSection);
  const finalScore = selected?.finalScore ?? selectedSection.score ?? 0;
  const rejectedReason = selected?.rejectedReason ?? null;
  const rejected = Boolean(selected?.rejected);
  const weakExpansionOnly = candidateMatchesOnlyWeakExpansion(selected);
  const validation = selected?.validation;
  const validationRejects = validation ? !validation.accepted || validation.confidence === "low" : false;
  const shouldAsk = rejected || validationRejects || weakExpansionOnly || finalScore < 8;
  return {
    answerMode: shouldAsk ? "clarification" : "selected_section_qa",
    answerConfidence: shouldAsk ? "low" : finalScore >= 50 ? "high" : "medium",
    confidenceReason: shouldAsk ? rejectedReason ?? validation?.reason ?? (weakExpansionOnly ? "candidate matched only weak query expansion terms" : "selected section relevance is low") : "selected section is relevant",
    finalScore,
    strongSignals: selected ? uniqueStrings([...selected.candidateMatchedPhrases, ...selected.candidateMatchedTokens, ...(selected.validation?.strongSignals ?? [])]).slice(0, 8) : [],
    contradictions: selected?.contrastTermOnlyMatch ? ["contrast_term_only_match"] : [],
    shouldAskClarification: shouldAsk
  };
}

export function asksForHsCodeOrClassification(query: string): boolean {
  const normalized = normalizeForIntent(query);
  return HS_CODE_PATTERN.test(query) ||
    /\b(hs\s*code|hscode|ma\s+hs|ma\s+hscode|tariff\s+code|customs\s+code|classification|classified|classify|phan\s+loai|thuoc\s+ma|ma\s+nao|code\s+nao|which\s+code|belong\s+to\s+which\s+hs\s+code)\b/.test(normalized) ||
    /\bcode\s*\??$/.test(normalized);
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

function candidateMatchesOnlyWeakExpansion(candidate: CandidateRelevance | undefined): boolean {
  if (!candidate) {
    return false;
  }
  const originalMatches = candidate.matchedOriginalTerms ?? [];
  const expansionMatches = candidate.matchedExpansionTerms ?? [];
  if (originalMatches.length > 0 || expansionMatches.length === 0) {
    return false;
  }
  if (candidate.expansionConfidence !== "high") {
    return true;
  }
  const hasExactCode = candidate.matchedTerms.some((term) => HS_CODE_PATTERN.test(term));
  const hasNumericEvidence = candidate.numericMatches.length > 0 || candidate.matchedNumericRanges.length > 0;
  const hasSpecificPhrase = candidate.candidateMatchedPhrases.some((phrase) => meaningfulIntentTokens(phrase).length >= 2);
  const specificExpansionTokens = uniqueStrings(expansionMatches.flatMap(meaningfulIntentTokens))
    .filter((token) => token.length >= 4 && !/^\d+$/.test(token));
  return !(hasExactCode || hasNumericEvidence || hasSpecificPhrase || specificExpansionTokens.length >= 2);
}

function numericOnlyClarificationAnswer(query: string, section?: EnrichedRetrievedSection): string {
  const value = query.trim();
  return section
    ? `Tim thay '${value}' trong section ${normalizedTitle(section)}, nhung chi gia tri so thi chua du de phan loai chac chan. Vui long cung cap them mo ta san pham.`
    : `Gia tri '${value}' chua du de xac dinh san pham hoac ma HS. Vui long cung cap them mo ta san pham.`;
}


function cleanSelectedSectionAnswer(answer: string | undefined, query: string): string {
  const cleaned = answer
    ?.replace(/<doc=[^>]+>/gi, "")
    .replace(/^\s*(Nguá»“n|Citation|Source):.*$/gim, "")
    .replace(/\b(Index source|PageIndex logs?|cache freshness|final score|candidate debug|candidate|cache status|Primary citation|Related citation|Retrieval|PageIndex):[\s\S]*$/gi, " ")
    .replace(/\s+/g, " ")
    .trim() ?? "";
  if (!cleaned) {
    return "";
  }
  if (asksForHsCodeOrClassification(query)) {
    return sanitizeFinalAnswer(ensureSentence(cleaned), { stripHsCode: false });
  }
  return sanitizeFinalAnswer(ensureSentence(cleaned
    .replace(/(?:^|\s)HS Code:\s*\d{4}\.\d{2}\.\d{2}\.?/gi, " ")
    .replace(/\s+/g, " ")
    .trim()), { stripHsCode: false });
}

function cleanDefinitionLocalAnswer(answer: string | undefined): string {
  const cleaned = answer
    ?.replace(/<doc=[^>]+>/gi, "")
    .replace(/^\s*(NguÃ¡Â»â€œn|Citation|Source):.*$/gim, "")
    .replace(/\b(Index source|PageIndex logs?|cache freshness|final score|candidate debug|candidate|cache status|Primary citation|Related citation|Retrieval|PageIndex):[\s\S]*$/gi, " ")
    .replace(/\s+/g, " ")
    .trim() ?? "";
  return cleaned ? sanitizeFinalAnswer(ensureSentence(cleaned), { stripHsCode: false }) : "";
}

function maybeAppendRelatedHsCode(
  answer: string,
  query: string,
  section: EnrichedRetrievedSection,
  gate: GateResult,
  usedGeneratedAnswer: boolean
): string {
  const codes = hsCodesForSection(section);
  if (
    !usedGeneratedAnswer ||
    codes.length === 0 ||
    !asksForHsCodeOrClassification(query) ||
    gate.answerConfidence !== "high" ||
    answerMentionsHsCode(answer) ||
    !isSelectedSectionCodeUsefulQuestion(query) ||
    isSelectedSectionAnswerCluttered(answer)
  ) {
    return answer;
  }
  return `${ensureSentence(answer)} Mã liên quan: ${formatCodes(codes)}.`;
}

function answerMentionsHsCode(answer: string): boolean {
  return HS_CODE_PATTERN.test(answer);
}

function isSelectedSectionCodeUsefulQuestion(query: string): boolean {
  const normalized = normalizeForIntent(query);
  return /\b(requirement|requirements|attribute|attributes|appearance|condition|conditions|usage|used|use|purpose|note|notes|characteristic|characteristics|feature|features|size|weight|content|origin|where|grown|planted)\b/.test(normalized) ||
    /\b(yeu\s+cau|dac\s+diem|ngoai\s+quan|dieu\s+kien|cong\s+dung|su\s+dung|dung|ghi\s+chu|luu\s+y|thuoc\s+tinh|hinh\s+dang|kich\s+thuoc|trong\s+luong|thanh\s+phan|nguon\s+goc|trong|o\s+dau)\b/.test(normalized);
}

function isSelectedSectionAnswerCluttered(answer: string): boolean {
  const sentenceTotal = answer.split(/[.!?]+(?:\s+|$)/).map((part) => part.trim()).filter(Boolean).length;
  return answer.length > 420 || sentenceTotal > 3;
}

function safeSelectedSectionFallbackAnswer(section: EnrichedRetrievedSection): string {
  const chars = `${section.text ?? ""} ${(section.captions ?? []).join(" ")}`.trim().length;
  if (chars === 0) {
    return "Tìm thấy section liên quan nhưng thiếu nội dung chi tiết để trả lời.";
  }
  return "Tôi đã tìm thấy section liên quan, nhưng chưa thể trích xuất câu trả lời từ nội dung section. Vui lòng thử lại hoặc bật API key.";
}


function ambiguousLookupAnswer(section: EnrichedRetrievedSection): string {
  return `Tim thay section ${normalizedTitle(section)}, nhung chua du tin hieu de phan loai chac chan. Vui long cung cap them mo ta san pham, trang thai hang hoa, cong dung hoac thanh phan.`;
}

function broadLookupAnswer(query: string, candidates: CandidateRelevance[]): string {
  return [
    `Tìm thấy nhiều mục liên quan đến '${query.trim()}':`,
    ...candidates.map((candidate) => `- ${candidateTitle(candidate)} - HS Code: ${formatCodes(hsCodesForCandidate(candidate))}.`),
    "Vui lòng nói rõ bạn muốn tra mục nào."
  ].join("\n");
}


function clarificationAnswer(): string {
  return "Chưa đủ thông tin để xác định HS Code chắc chắn. Vui lòng cung cấp thêm mô tả sản phẩm, thành phần, công dụng, trạng thái hàng hóa hoặc thông số kỹ thuật.";
}

function broadLookupUserAnswer(query: string, candidates: CandidateRelevance[]): string {
  return [
    `Tìm thấy nhiều mục liên quan đến '${query.trim()}':`,
    ...candidates.map((candidate) => `- ${candidateTitle(candidate)} — HS Code: ${formatCodes(hsCodesForCandidate(candidate))}`),
    "Vui lòng nói rõ bạn muốn tra mục nào."
  ].join("\n");
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
    `Chapter ${chapterNumber} gồm các nội dung chính:`,
    ...items.map((item) => `- ${item.title} â€” HS Code: ${item.codes.join(", ")}.`)
  ].join("\n");
}

export function extractChapterNumber(normalizedQuery: string): number | undefined {
  const match = normalizedQuery.match(/\b(?:chuong|chapter)\s+(\d{1,3})\b/) ??
    normalizedQuery.match(/\bchapter[\s_-]*(\d{1,3})\b/);
  return match ? Number(match[1]) : undefined;
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

function extractDefinitionTarget(query: string): string | undefined {
  const trimmed = query.trim().replace(/[?.!]+$/g, "");
  const patterns = [
    /^\s*(?:what\s+(?:is|are)|define|definition\s+of)\s+(.+)$/i,
    /^\s*(.+?)\s+(?:là\s+gì|la\s+gi|được\s+định\s+nghĩa|duoc\s+dinh\s+nghia|có\s+nghĩa\s+là|co\s+nghia\s+la)\s*$/i
  ];
  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return trimmed || undefined;
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
    /chÆ°Æ¡ng\s+(\d+)/i
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
  const sourceText = [
    section.section,
    section.title,
    "text" in section ? section.text : undefined,
    "textPreview" in section ? section.textPreview : undefined,
    "captions" in section ? section.captions?.join(" ") : undefined
  ].filter(Boolean).join("\n\n");

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
    metadataWarnings: "metadataWarnings" in section ? section.metadataWarnings : [],
    sourceText
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
      matchedOriginalTerms: candidate.matchedOriginalTerms ?? [],
      matchedExpansionTerms: candidate.matchedExpansionTerms ?? [],
      matchedPhrases: candidate.matchedPhrases ?? candidate.candidateMatchedPhrases,
      numericMatches: candidate.numericMatches,
      finalScore: candidate.finalScore,
      validation: candidate.validation ?? null
    }));
}

function distinctCandidateSections(candidates: CandidateRelevance[]): CandidateRelevance[] {
  const seen = new Set<string>();
  const distinct: CandidateRelevance[] = [];
  for (const candidate of candidates) {
    const key = [
      candidate.document,
      hsCodesForCandidate(candidate).join("|"),
      normalizeForIntent(candidate.title ?? ""),
      normalizeForIntent(candidate.section ?? "")
    ].join("|");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    distinct.push(candidate);
  }
  return distinct;
}

function lookupCandidatesForAnswer(
  selectedSection: EnrichedRetrievedSection | undefined,
  alternatives: EnrichedRetrievedSection[],
  candidates: CandidateRelevance[]
): CandidateRelevance[] {
  const fromCandidates = candidates
    .filter((candidate) => !candidate.rejected)
    .filter((candidate) => hsCodesForCandidate(candidate).length > 0);
  const fromSections = [selectedSection, ...alternatives]
    .filter((section): section is EnrichedRetrievedSection => Boolean(section))
    .filter((section) => hsCodesForSection(section).length > 0)
    .map((section, index) => candidateFromSectionForLookup(section, 100 - index));
  return distinctCandidateSections([...fromCandidates, ...fromSections]);
}

function candidateFromSectionForLookup(section: EnrichedRetrievedSection, fallbackScore: number): CandidateRelevance {
  const finalScore = section.score ?? fallbackScore;
  return {
    document: section.document,
    hsCode: section.hsCode,
    groupedHsCodes: section.groupedHsCodes ?? [],
    title: section.title,
    section: section.section,
    source: section.source,
    pageStart: section.pageStart ?? null,
    pageEnd: section.pageEnd ?? null,
    matchedTerms: [],
    matchedNumericRanges: [],
    matchedAttributes: [],
    missingImportantTerms: [],
    contrastTermOnlyMatch: false,
    relevanceScore: finalScore,
    queryTokens: [],
    queryPhrases: [],
    candidateMatchedTokens: [],
    candidateMatchedPhrases: [],
    numericMatches: [],
    contrastTerms: [],
    finalScore,
    rejected: false,
    rejectedReason: null
  };
}

function hsCodesForCandidate(candidate: CandidateRelevance): string[] {
  return uniqueStrings([
    ...candidate.groupedHsCodes,
    candidate.hsCode
  ].filter((code): code is string => Boolean(code)));
}

function publicCandidate(candidate: CandidateRelevance): Record<string, unknown> {
  return {
    document: candidate.document,
    hsCode: candidate.hsCode ?? null,
    groupedHsCodes: candidate.groupedHsCodes,
    title: candidate.title ?? null,
    section: candidate.section ?? null,
    pageStart: candidate.pageStart,
    pageEnd: candidate.pageEnd,
    source: candidate.source ?? null,
    score: candidate.finalScore,
    matchedTerms: candidate.matchedTerms
  };
}

function candidateTitle(candidate: CandidateRelevance): string {
  return normalizeProductTitle(candidate.title || titleFromSection(candidate.section) || candidate.section || "Untitled");
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

function selectedCandidateHasDecisiveEvidence(
  candidates: CandidateRelevance[],
  section: EnrichedRetrievedSection
): boolean {
  const candidate = selectedCandidate(candidates, section);
  if (!candidate || candidate.rejected || candidate.validation?.accepted === false) {
    return false;
  }
  const strongSignals = candidate.validation?.strongSignals ?? [];
  const weakSignals = candidate.validation?.weakSignals ?? [];
  if (strongSignals.some((signal) =>
    signal === "exact_or_near_exact_title_phrase_match" ||
    signal === "distinctive_multi_token_phrase_overlap" ||
    signal === "caption_or_body_distinctive_phrase_match" ||
    signal === "numeric_unit_match_plus_product_or_attribute_evidence" ||
    signal === "scientific_or_latin_like_term_match"
  )) {
    return strongSignals.length >= 2 || weakSignals.length <= 1;
  }
  return strongSignals.length >= 2 && weakSignals.length === 0 && candidate.finalScore >= 45;
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

function isComparisonIntentQuestion(query: string): boolean {
  const normalized = normalizeForIntent(query);
  return /\b(vs|versus|compare|comparison|difference|different|distinguish|more|less|higher|lower|longer|shorter)\b/.test(normalized) ||
    /\b(?:so\s+sanh|khac|phan\s+biet|hon|it\s+hon|nhieu\s+hon)\b/.test(normalized);
}

function isUsageStyleQuestion(query: string): boolean {
  const normalized = normalizeForIntent(query);
  return /\b(used?\s+for|usage|purpose|function|cong\s+dung|muc\s+dich|su\s+dung)\b/.test(normalized);
}

function meaningfulIntentTokens(value: string): string[] {
  const stopwords = new Set([
    "the", "and", "for", "with", "what", "which", "define", "definition", "code", "hscode",
    "hang", "hoa", "san", "pham", "duoc", "dinh", "nghia", "thuoc", "loai", "nao",
    "cua", "cho", "trong", "mot", "cac", "voi", "hon", "khac", "thay", "khong",
    "phai", "is", "are", "was", "were", "it", "this", "that", "these", "those", "nay", "day", "do", "chapter", "chuong",
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
  if (codes.length === 2) return `${codes[0]} hoặc ${codes[1]}`;
  return `${codes.slice(0, -1).join(", ")} hoặc ${codes[codes.length - 1]}`;
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
  return value?.replace(HS_CODE_PATTERN, "").replace(/^[\sâ€”â€“-]+/, "").trim() || undefined;
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
    .replace(/[Ä‘Ä]/g, "d")
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

