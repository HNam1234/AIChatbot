export const HS_CODE_PATTERN = /\b\d{4}\.\d{2}\.\d{2}\b/;

export interface SectionMetadata {
  document: string;
  chapter?: string;
  hsCode?: string;
  groupedHsCodes?: string[];
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
  groupedHsCodes?: string[];
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
  finalHsCodes: string[];
  answerRepairApplied: boolean;
  structuredAnswer: StructuredAnswer;
}

export type AnswerStyle = "class-eval" | "verbose";

export interface StructuredAnswer {
  productTitle: string | null;
  normalizedProductName: string | null;
  hsCodes: string[];
  conciseExplanation: string | null;
  note: string | null;
  document: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  section: string | null;
  source: string | null;
  selectedPrimary: EnrichedRetrievedSection;
}

export interface ContrastDetection {
  terms: string[];
  baselineTokens: string[];
}

export interface QuerySignals {
  domainTerms: string[];
  productTerms: string[];
  physicalAttributes: string[];
  numericRanges: string[];
  usageTerms: string[];
  scientificNames: string[];
  tradeForms: string[];
  contrastTerms: string[];
  queryTokens: string[];
  queryPhrases: string[];
  quotedTerms: string[];
  capitalizedTerms: string[];
}

export interface CandidateRelevance {
  document: string;
  hsCode?: string;
  groupedHsCodes: string[];
  title?: string;
  section?: string;
  source?: string;
  pageStart: number | null;
  pageEnd: number | null;
  matchedTerms: string[];
  matchedNumericRanges: string[];
  matchedAttributes: string[];
  missingImportantTerms: string[];
  contrastTermOnlyMatch: boolean;
  relevanceScore: number;
  queryTokens: string[];
  queryPhrases: string[];
  candidateMatchedTokens: string[];
  candidateMatchedPhrases: string[];
  numericMatches: string[];
  contrastTerms: string[];
  finalScore: number;
  rejected: boolean;
  rejectedReason: string | null;
}

export interface RelevanceSelection {
  signals: QuerySignals;
  ranked: EnrichedRetrievedSection[];
  candidates: CandidateRelevance[];
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
    groupedHsCodes: groupedHsCodesFromUnknown(raw.groupedHsCodes) ?? extractGroupedHsCodes(
      [stringValue(raw.text), stringValue(raw.textPreview), stringValue(raw.section), stringValue(raw.markdownHeading)]
        .filter(Boolean)
        .join("\n")
    ),
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
  const groupedHsCodes = metadata?.groupedHsCodes ?? extractGroupedHsCodes(`${normalizedHit.title}\n${normalizedHit.text}`);
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
    groupedHsCodes,
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
      `[SECTION ${index + 1}]`,
      `- document: ${section.document}`,
      `- chapter: ${section.chapter ?? ""}`,
      `- pageStart: ${section.pageStart ?? ""}`,
      `- pageEnd: ${section.pageEnd ?? ""}`,
      `- hsCode: ${section.hsCode ?? ""}`,
      `- groupedHsCodes: ${(section.groupedHsCodes ?? []).join(", ")}`,
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
  alternatives: EnrichedRetrievedSection[] = [],
  options: { question?: string; answerStyle?: AnswerStyle } = {}
): RenderedHsCodeAnswer {
  const answerStyle = options.answerStyle ?? "class-eval";
  const finalHsCodes = hsCodesForSection(topSection);
  const structuredAnswer = buildStructuredAnswer(topSection, llmAnswer, options.question);
  if (answerStyle === "class-eval") {
    const answer = renderClassEvalAnswer(structuredAnswer, options.question);
    return {
      answer,
      citations: [topSection, ...alternatives],
      metadataWarnings: [...topSection.metadataWarnings],
      finalHsCodes,
      answerRepairApplied: classEvalRepairApplied(llmAnswer, structuredAnswer, answer),
      structuredAnswer
    };
  }

  const directAnswer = stripDisallowedHsCodes(cleanDirectAnswer(llmAnswer), finalHsCodes) || fallbackDirectAnswer(topSection);
  const metadataWarnings = [...topSection.metadataWarnings];
  const body = finalHsCodes.length > 0
    ? `${ensureSentenceEnd(directAnswer)} ${formatHsCodeLine(finalHsCodes, options.question)}`
    : `${ensureSentenceEnd(directAnswer)} Không tìm thấy HS Code trong metadata của section được retrieve.`;
  const alternativeLine = formatAlternativeSections(topSection, alternatives);
  const citation = formatCitation(topSection);
  const answer = [body, alternativeLine, citation].filter(Boolean).join("\n\n");
  const answerRepairApplied = Boolean(llmAnswer) && finalHsCodes.some((code) => !(llmAnswer ?? "").includes(code));

  return {
    answer,
    citations: [topSection, ...alternatives],
    metadataWarnings,
    finalHsCodes,
    answerRepairApplied,
    structuredAnswer
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

export function buildStructuredAnswer(
  selectedPrimary: EnrichedRetrievedSection,
  llmAnswer?: string,
  question?: string
): StructuredAnswer {
  const productTitle = selectedPrimary.title ?? titleFromHeading(selectedPrimary.section) ?? selectedPrimary.section ?? null;
  const normalizedProductName = productTitle ? normalizeProductTitle(productTitle) : null;
  const hsCodes = hsCodesForSection(selectedPrimary);
  const conciseExplanation =
    isDefinitionStyleQuestion(question ?? "") ? extractDefinitionSentence(selectedPrimary.text) : shortLlmExplanation(llmAnswer);
  const note = extractClassificationNote(selectedPrimary.text);

  return {
    productTitle,
    normalizedProductName,
    hsCodes,
    conciseExplanation,
    note,
    document: selectedPrimary.document || null,
    pageStart: selectedPrimary.pageStart ?? null,
    pageEnd: selectedPrimary.pageEnd ?? null,
    section: selectedPrimary.section ?? null,
    source: selectedPrimary.source ?? null,
    selectedPrimary
  };
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
  const seen = new Set([hsCodesForSection(top ?? {}).join("|"), top?.section].filter(Boolean));
  const alternatives: EnrichedRetrievedSection[] = [];
  for (const section of sections.slice(1)) {
    const key = hsCodesForSection(section).join("|") || section.section;
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

export function detectContrastTerms(question: string): ContrastDetection {
  const normalized = normalizeForSearch(question);
  const patterns = [
    "so voi",
    "khac voi",
    "khac",
    "thay vi",
    "khong phai",
    "it hon",
    "nhieu hon",
    "dai hon",
    "dang hon",
    "hon",
    "less than",
    "more than",
    "compared to",
    "rather than",
    "instead of",
    "different from"
  ];
  const matchedTerms = patterns.filter((term) => includesNormalizedPhrase(normalized, term));
  const terms = matchedTerms.filter((term) => !matchedTerms.some((other) => other !== term && other.includes(term)));
  const baselineTokens = uniqueStrings([
    ...terms.flatMap((term) => baselineTokensAfterTerm(normalized, term)),
    ...baselineTokensFromComparativeThan(normalized)
  ]);
  return { terms, baselineTokens };
}

export function extractQuerySignals(question: string): QuerySignals {
  const contrast = detectContrastTerms(question);
  const contrastTokenSet = new Set(contrast.baselineTokens);
  const quotedTerms = extractQuotedTerms(question);
  const capitalizedTerms = extractCapitalizedTerms(question);
  const queryTokens = uniqueStrings([
    ...meaningfulTokens(question),
    ...quotedTerms.flatMap(tokenizeForRanking),
    ...capitalizedTerms.flatMap(tokenizeForRanking)
  ]).filter((token) => !contrastTokenSet.has(token));
  const queryPhrases = buildUsefulPhrases(queryTokens, question);
  const numericRanges = extractNumericRanges(question);
  const scientificNames = extractScientificNames(question);

  return {
    domainTerms: queryTokens,
    productTerms: queryTokens,
    physicalAttributes: [],
    numericRanges,
    usageTerms: [],
    scientificNames,
    tradeForms: [],
    contrastTerms: uniqueStrings([...contrast.terms, ...contrast.baselineTokens]),
    queryTokens,
    queryPhrases,
    quotedTerms,
    capitalizedTerms
  };
}

export function evaluateCandidateRelevance(
  section: EnrichedRetrievedSection,
  question: string,
  signals: QuerySignals = extractQuerySignals(question)
): CandidateRelevance {
  const titleSource = `${section.title ?? ""} ${section.section ?? ""}`;
  const bodySource = `${section.text} ${(section.captions ?? []).join(" ")}`;
  const sourceSource = `${section.source ?? ""} ${section.chapter ?? ""} ${section.document}`;
  const titleText = normalizeForSearch(titleSource);
  const bodyText = normalizeForSearch(bodySource);
  const sourceText = normalizeForSearch(sourceSource);
  const allText = `${titleText} ${bodyText} ${sourceText}`;
  const candidateTokens = new Set(meaningfulTokens(`${titleSource} ${bodySource} ${sourceSource}`));
  const candidateTitleTokens = new Set(meaningfulTokens(titleSource));
  const candidateBodyTokens = new Set(meaningfulTokens(bodySource));
  const candidatePhrases = new Set([
    ...buildUsefulPhrases([...candidateTitleTokens], titleSource),
    ...buildUsefulPhrases([...candidateBodyTokens], bodySource)
  ]);
  const titleTokenMatches = signals.queryTokens.filter((token) => candidateTitleTokens.has(token));
  const bodyTokenMatches = signals.queryTokens.filter((token) => !candidateTitleTokens.has(token) && candidateBodyTokens.has(token));
  const sourceTokenMatches = signals.queryTokens.filter((token) => !candidateTitleTokens.has(token) && !candidateBodyTokens.has(token) && includesSignal(sourceText, token));
  const phraseMatches = signals.queryPhrases.filter((phrase) => candidatePhrases.has(phrase) || includesSignal(allText, phrase));
  const titlePhraseMatches = phraseMatches.filter((phrase) => includesSignal(titleText, phrase));
  const rareTokenMatches = signals.queryTokens.filter((token) => candidateTokens.has(token) && isRareQueryToken(token));
  const scientificMatches = signals.scientificNames.filter((term) => includesSignal(allText, term));
  const numericMatches = signals.numericRanges.filter((range) => candidateMatchesNumericRange(section, range));
  const contrastMatches = signals.contrastTerms.filter((term) => includesSignal(allText, term));
  const hsCodeMatches = hsCodesForSection(section).filter((code) => normalizeForSearch(question).includes(code));
  const meaningfulEvidenceTokens = uniqueStrings([
    ...titleTokenMatches,
    ...bodyTokenMatches,
    ...sourceTokenMatches,
    ...rareTokenMatches
  ]).filter((token) => !isWeakGenericQueryToken(token));
  const meaningfulPhraseMatches = phraseMatches.filter((phrase) =>
    meaningfulTokens(phrase).some((token) => !isWeakGenericQueryToken(token))
  );
  const onlyWeakTokenEvidence =
    hsCodeMatches.length === 0 &&
    meaningfulPhraseMatches.length === 0 &&
    numericMatches.length === 0 &&
    scientificMatches.length === 0 &&
    meaningfulEvidenceTokens.length === 0 &&
    titleTokenMatches.length + bodyTokenMatches.length + sourceTokenMatches.length + phraseMatches.length > 0;
  const matchedTerms = uniqueStrings([
    ...hsCodeMatches,
    ...titleTokenMatches,
    ...bodyTokenMatches,
    ...sourceTokenMatches,
    ...scientificMatches,
    ...rareTokenMatches
  ]);
  const importantTerms = uniqueStrings([...signals.queryTokens, ...signals.queryPhrases, ...signals.scientificNames, ...signals.numericRanges]);
  const matchedImportant = new Set([
    ...matchedTerms,
    ...phraseMatches,
    ...numericMatches
  ]);
  const missingImportantTerms = importantTerms.filter((term) => !matchedImportant.has(term) && !signals.contrastTerms.includes(term));

  let relevanceScore = section.score;
  relevanceScore += hsCodeMatches.length * 20;
  relevanceScore += titlePhraseMatches.length * 12;
  relevanceScore += phraseMatches.length * 9;
  relevanceScore += titleTokenMatches.length * 7;
  relevanceScore += numericMatches.length * 9;
  relevanceScore += rareTokenMatches.length * 6;
  relevanceScore += scientificMatches.length * 8;
  relevanceScore += bodyTokenMatches.length * 3;
  relevanceScore += sourceTokenMatches.length * 1;
  relevanceScore += signals.queryTokens.filter((term) => section.captions.some((caption) => includesSignal(normalizeForSearch(caption), term))).length * 4;

  const positiveEvidence =
    hsCodeMatches.length +
    titleTokenMatches.length +
    bodyTokenMatches.length +
    sourceTokenMatches.length +
    phraseMatches.length +
    scientificMatches.length +
    numericMatches.length;
  const contrastTermOnlyMatch = positiveEvidence === 0 && contrastMatches.length > 0;
  const hasStrongMatch = hsCodeMatches.length + titlePhraseMatches.length + numericMatches.length + meaningfulPhraseMatches.length + rareTokenMatches.length + scientificMatches.length > 0;
  const lowGenericOverlap = titleTokenMatches.length + bodyTokenMatches.length + phraseMatches.length + numericMatches.length === 0;

  if (contrastTermOnlyMatch) {
    relevanceScore -= 25;
  }
  if (contrastMatches.length > 0 && positiveEvidence <= contrastMatches.length) {
    relevanceScore -= contrastMatches.length * 6;
  }
  if (lowGenericOverlap) {
    relevanceScore -= 12;
  }

  let rejectedReason: string | null = null;
  const minimumScore = hasStrongMatch ? 5 : 8;
  if (contrastTermOnlyMatch) {
    rejectedReason = "candidate only matches contrast baseline terms";
  } else if (onlyWeakTokenEvidence) {
    rejectedReason = "candidate only matches weak generic/chapter tokens or bare numbers";
  } else if (relevanceScore < minimumScore) {
    rejectedReason = `relevance score below threshold ${minimumScore}`;
  } else if (lowGenericOverlap) {
    rejectedReason = "candidate has low generic token, phrase, and numeric overlap with query";
  }

  return {
    document: section.document,
    hsCode: section.hsCode,
    groupedHsCodes: section.groupedHsCodes ?? [],
    title: section.title,
    section: section.section,
    source: section.source,
    pageStart: section.pageStart ?? null,
    pageEnd: section.pageEnd ?? null,
    matchedTerms,
    matchedNumericRanges: numericMatches,
    matchedAttributes: phraseMatches,
    missingImportantTerms,
    contrastTermOnlyMatch,
    relevanceScore,
    queryTokens: signals.queryTokens,
    queryPhrases: signals.queryPhrases,
    candidateMatchedTokens: matchedTerms,
    candidateMatchedPhrases: phraseMatches,
    numericMatches,
    contrastTerms: contrastMatches,
    finalScore: relevanceScore,
    rejected: Boolean(rejectedReason),
    rejectedReason
  };
}

export function selectRelevantSections(
  sections: EnrichedRetrievedSection[],
  question: string,
  options: { requireHsMetadata?: boolean } = {}
): RelevanceSelection {
  const signals = extractQuerySignals(question);
  const evaluated = sections.map((section) => ({
    section,
    relevance: evaluateCandidateRelevance(section, question, signals)
  }));
  const ranked = evaluated
    .sort((left, right) => {
      if (left.relevance.rejected !== right.relevance.rejected) {
        return left.relevance.rejected ? 1 : -1;
      }
      return right.relevance.relevanceScore - left.relevance.relevanceScore ||
        right.section.score - left.section.score ||
        left.section.document.localeCompare(right.section.document);
    })
    .filter((item) => !item.relevance.rejected)
    .filter((item) => !options.requireHsMetadata || hasSectionHsMetadata(item.section))
    .map((item) => ({ ...item.section, score: item.relevance.relevanceScore }));

  return {
    signals,
    ranked,
    candidates: evaluated
      .sort((left, right) => right.relevance.relevanceScore - left.relevance.relevanceScore)
      .map((item) => item.relevance)
  };
}

export function rankSectionsForQuestion(
  sections: EnrichedRetrievedSection[],
  question: string
): EnrichedRetrievedSection[] {
  const contrast = detectContrastTerms(question);
  const queryTokens = tokenizeForRanking(question);
  const baselineTokens = new Set(contrast.baselineTokens);
  const positiveTokens = queryTokens.filter((token) => !baselineTokens.has(token));

  return sections
    .map((section) => {
      const titleText = normalizeForSearch(`${section.title ?? ""} ${section.section ?? ""}`);
      const bodyText = normalizeForSearch(`${section.text} ${(section.captions ?? []).join(" ")}`);
      const positiveTitleScore = positiveTokens.reduce((sum, token) => sum + countToken(titleText, token), 0) * 8;
      const positiveBodyScore = positiveTokens.reduce((sum, token) => sum + countToken(bodyText, token), 0);
      const baselineTitlePenalty = contrast.baselineTokens.reduce((sum, token) => sum + countToken(titleText, token), 0) * 7;
      const metadataBoost = hsCodesForSection(section).length > 0 ? 3 : 0;
      return {
        section,
        adjustedScore: section.score + positiveTitleScore + positiveBodyScore + metadataBoost - baselineTitlePenalty
      };
    })
    .sort((left, right) => right.adjustedScore - left.adjustedScore || left.section.document.localeCompare(right.section.document))
    .map((item) => ({ ...item.section, score: item.adjustedScore }));
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
  const topCodes = new Set(hsCodesForSection(topSection));
  const relevant = alternatives
    .map((section) => ({ section, codes: hsCodesForSection(section).filter((code) => !topCodes.has(code)) }))
    .filter((item) => item.codes.length > 0);
  if (relevant.length === 0) {
    return "";
  }

  return `Mã liên quan: ${relevant
    .map(({ section, codes }) => `HS Code: ${codes.join(", ")}, section "${section.section ?? section.title ?? "unknown"}"`)
    .join("; ")}.`;
}

export function hsCodesForSection(section: Pick<EnrichedRetrievedSection, "hsCode" | "groupedHsCodes">): string[] {
  return uniqueStrings([...(section.groupedHsCodes ?? []), section.hsCode].filter((code): code is string => Boolean(code)));
}

export function prefersVietnameseAnswer(question: string | undefined): boolean {
  if (!question?.trim()) {
    return true;
  }
  const normalized = normalizeForSearch(question);
  if (/[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i.test(question) ||
    /\b(la|gi|can|phai|yeu|cau|ngoai|quan|nhin|trong|nhu|nao|chuong|tom|tat|noi|dung|cong|dung|dac|diem|ma|thuoc)\b/.test(normalized)) {
    return true;
  }
  if (!/[a-z]/i.test(question)) {
    return true;
  }
  return false;
}

export function hasSectionHsMetadata(section: Pick<EnrichedRetrievedSection, "hsCode" | "groupedHsCodes">): boolean {
  return hsCodesForSection(section).length > 0;
}

export function propagateGroupedSectionPageRanges<T extends SectionMetadata>(sections: T[]): T[] {
  const groups = new Map<string, { pageStart?: number; pageEnd?: number }>();
  for (const section of sections) {
    const codes = uniqueStrings([...(section.groupedHsCodes ?? []), section.hsCode].filter((code): code is string => Boolean(code))).sort();
    if (codes.length <= 1 || !section.title || !section.document) {
      continue;
    }
    const key = groupedPageRangeKey(section.document, section.title, codes);
    const existing = groups.get(key) ?? {};
    groups.set(key, {
      pageStart: minDefined(existing.pageStart, section.pageStart),
      pageEnd: maxDefined(existing.pageEnd, section.pageEnd ?? section.pageStart)
    });
  }

  return sections.map((section) => {
    const codes = uniqueStrings([...(section.groupedHsCodes ?? []), section.hsCode].filter((code): code is string => Boolean(code))).sort();
    const range = codes.length > 1 && section.title && section.document
      ? groups.get(groupedPageRangeKey(section.document, section.title, codes))
      : undefined;
    if (!range?.pageStart && !range?.pageEnd) {
      return section;
    }
    return {
      ...section,
      pageStart: section.pageStart ?? range.pageStart,
      pageEnd: section.pageEnd ?? range.pageEnd ?? range.pageStart
    };
  });
}

function formatHsCodeLine(codes: string[], question: string | undefined): string {
  if (codes.length <= 1) {
    return `HS Code: ${codes[0]}.`;
  }

  const joined = codes.length === 2
    ? `${codes[0]} hoặc ${codes[1]}`
    : `${codes.slice(0, -1).join(", ")} hoặc ${codes[codes.length - 1]}`;
  const qualifier = question && questionSpecifiesState(question) ? "" : ", tùy trạng thái hàng hóa";
  return `HS Code: ${joined}${qualifier}.`;
}

function renderClassEvalAnswer(structured: StructuredAnswer, question: string | undefined): string {
  const product = structured.normalizedProductName || structured.productTitle || "sản phẩm phù hợp";
  const definition = isDefinitionStyleQuestion(question ?? "") && !asksForHsCodeOrClassificationQuestion(question ?? "")
    ? formatDefinitionExplanation(structured.conciseExplanation ?? firstSectionSentence(structured.selectedPrimary.text), question)
    : null;
  const prefix = definition ? ensureSentenceEnd(stripHsCodes(definition)) : `Sản phẩm là ${product},`;
  const codeLine = formatClassEvalHsCodeLine(structured.hsCodes);
  const note = !definition && structured.note ? ` Lưu ý: ${ensureSentenceEnd(stripHsCodes(structured.note))}` : "";
  const answer = `${prefix} ${codeLine}${note}`;
  return validateClassEvalAnswer(answer, structured) ? answer : fallbackClassEvalAnswer(structured);
}

function formatClassEvalHsCodeLine(codes: string[]): string {
  if (codes.length === 0) {
    return "HS Code: chưa có trong metadata.";
  }
  if (codes.length === 1) {
    return `HS Code: ${codes[0]}.`;
  }
  return `HS Code: ${joinHsCodes(codes)}, tùy trạng thái hàng hóa trong biểu mã.`;
}

function joinHsCodes(codes: string[]): string {
  if (codes.length <= 2) {
    return codes.join(" hoặc ");
  }
  return `${codes.slice(0, -1).join(", ")} hoặc ${codes[codes.length - 1]}`;
}

function formatDefinitionExplanation(value: string | null, question: string | undefined): string | null {
  if (!value) {
    return null;
  }
  if (!prefersVietnameseAnswer(question)) {
    return value;
  }
  return vietnameseDefinitionSentence(value);
}

function vietnameseDefinitionSentence(value: string): string {
  const cleaned = ensureSentenceEnd(value.replace(/^Shared description:\s*/i, "").replace(/\s+/g, " ").trim());
  if (/\b(là|được định nghĩa là|có nghĩa là)\b/i.test(cleaned)) {
    return cleaned;
  }
  const knownAs = cleaned.match(/^(.+?)\s+(?:are|is)\s+also\s+known\s+as\s+(.+?)[.!?]?$/i);
  if (knownAs?.[1] && knownAs[2]) {
    return `${normalizeProductTitle(knownAs[1])} còn được gọi là ${knownAs[2].trim()}.`;
  }
  const definition = cleaned.match(/^(.+?)\s+(?:are|is|refers to|means|defined as)\s+(.+?)[.!?]?$/i);
  if (definition?.[1] && definition[2]) {
    return `${normalizeProductTitle(definition[1])} là ${definition[2].trim()}.`;
  }
  return `Thông tin mô tả: ${cleaned}`;
}

function groupedPageRangeKey(document: string, title: string, codes: string[]): string {
  return `${document}|${normalizeComparable(title)}|${codes.join("|")}`;
}

function minDefined(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}

function maxDefined(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.max(left, right);
}

function fallbackClassEvalAnswer(structured: StructuredAnswer): string {
  const product = structured.normalizedProductName || structured.productTitle || "sản phẩm phù hợp";
  return `Sản phẩm là ${product}, ${formatClassEvalHsCodeLine(structured.hsCodes)}`;
}

function validateClassEvalAnswer(answer: string, structured: StructuredAnswer): boolean {
  if (!answer.includes("HS Code:")) {
    return false;
  }
  if (!structured.normalizedProductName && !structured.conciseExplanation) {
    return false;
  }
  if (!structured.hsCodes.every((code) => answer.includes(code))) {
    return false;
  }
  if (/\b(Retrieval:|PageIndex|Mã liên quan:|Selected section|Nguồn:)\b/i.test(answer)) {
    return false;
  }
  const mentionedCodes = [...answer.matchAll(new RegExp(HS_CODE_PATTERN.source, "g"))].map((match) => match[0]);
  if (mentionedCodes.some((code) => !structured.hsCodes.includes(code))) {
    return false;
  }
  return sentenceCount(answer) <= 3;
}

function classEvalRepairApplied(llmAnswer: string | undefined, structured: StructuredAnswer, answer: string): boolean {
  if (!llmAnswer) {
    return false;
  }
  const llmCodes = [...llmAnswer.matchAll(new RegExp(HS_CODE_PATTERN.source, "g"))].map((match) => match[0]);
  return llmCodes.some((code) => !structured.hsCodes.includes(code)) ||
    structured.hsCodes.some((code) => !llmAnswer.includes(code)) ||
    cleanDirectAnswer(llmAnswer) !== stripHsCodes(answer);
}

export function normalizeProductTitle(value: string): string {
  const cleaned = normalizeDisplayText(value)
    .replace(HS_CODE_PATTERN, "")
    .replace(/^[\s—–-]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) {
    return "";
  }
  const withoutDescriptiveParentheses = cleaned.replace(/\((not\s+fit\s+for\s+human\s+consumption)\)/i, "$1");
  const sentenceCase = uppercaseFirstLetter(withoutDescriptiveParentheses.toLowerCase())
    .replace(/\bhs\b/g, "HS")
    .replace(/\bgenus\s+([a-z]+)/g, (_match, genus: string) => `genus ${uppercaseFirstLetter(genus)}`);
  return sentenceCase.replace(/\(([^)]+)\)/g, (_match, inner: string) => `(${titleCasePhrase(inner)})`);
}

function titleCasePhrase(value: string): string {
  return value
    .split(/\s+/g)
    .map((part, index, parts) => {
      const lower = part.toLowerCase();
      if (SMALL_TITLE_WORDS.has(lower) && index > 0 && index < parts.length - 1) {
        return lower;
      }
      return `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
    })
    .join(" ");
}

function uppercaseFirstLetter(value: string): string {
  return value.replace(/[a-z]/, (letter) => letter.toUpperCase());
}

export function isDefinitionStyleQuestion(question: string): boolean {
  const normalized = normalizeForSearch(question);
  return /\b(define|definition|what is|what are|means|refers to)\b/i.test(question) ||
    /là gì|được định nghĩa|định nghĩa/i.test(question) ||
    /\b(la\s+gi|duoc\s+dinh\s+nghia|dinh\s+nghia)\b/.test(normalized) ||
    /lÃ[\s\S]{0,80}gÃ/i.test(question);
}

function asksForHsCodeOrClassificationQuestion(question: string): boolean {
  const normalized = normalizeForSearch(question);
  return HS_CODE_PATTERN.test(question) ||
    /\b(hs\s*code|hscode|ma\s+hs|ma\s+hscode|tariff\s+code|customs\s+code|classification|classified|classify|phan\s+loai|thuoc\s+ma|ma\s+nao|code\s+nao|which\s+code|belong\s+to\s+which\s+hs\s+code)\b/.test(normalized);
}

function extractDefinitionSentence(text: string): string | null {
  const sentence = splitSentences(cleanRetrievedText(text)).find((candidate) =>
    /\b(are|is|refers to|means|defined as)\b/i.test(candidate) ||
    /là|được định nghĩa là|có nghĩa là/i.test(candidate)
  );
  return sentence ? shortenSentence(sentence, 180) : null;
}

function firstSectionSentence(text: string): string | null {
  const sentence = splitSentences(cleanRetrievedText(text))[0];
  return sentence ? shortenSentence(sentence, 180) : null;
}

function shortLlmExplanation(answer: string | undefined): string | null {
  const cleaned = stripHsCodes(cleanDirectAnswer(answer));
  if (!cleaned) {
    return null;
  }
  return shortenSentence(splitSentences(cleaned)[0] ?? cleaned, 160);
}

function extractClassificationNote(text: string): string | null {
  const sentence = splitSentences(cleanRetrievedText(text)).find((candidate) =>
    /\b(should be classified under|classified under|remain in heading|does not apply|however|except|provided that|if)\b/i.test(candidate)
  );
  return sentence && sentence.length <= 220 ? sentence : sentence ? shortenSentence(sentence, 180) : null;
}

function splitSentences(text: string): string[] {
  return normalizeDisplayText(text)
    .split(/(?<=[.!?])\s+/g)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function shortenSentence(value: string, maxLength: number): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLength) {
    return ensureSentenceEnd(cleaned);
  }
  const sliced = cleaned.slice(0, maxLength).replace(/\s+\S*$/g, "").trim();
  return ensureSentenceEnd(sliced);
}

function stripHsCodes(value: string): string {
  return value
    .replace(/HS Code:\s*/gi, "")
    .replace(new RegExp(HS_CODE_PATTERN.source, "g"), "")
    .replace(/\s+/g, " ")
    .trim();
}

function sentenceCount(value: string): number {
  return splitSentences(value).length;
}

function stripDisallowedHsCodes(answer: string, allowedCodes: string[]): string {
  if (allowedCodes.length === 0) {
    return answer;
  }

  return answer.replace(HS_CODE_PATTERN, (code) => allowedCodes.includes(code) ? code : "").replace(/\s+/g, " ").trim();
}

function groupedHsCodesFromUnknown(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const codes = uniqueStrings(value.map((item) => String(item).match(HS_CODE_PATTERN)?.[0] ?? "").filter(Boolean));
  return codes.length > 0 ? codes : undefined;
}

function extractGroupedHsCodes(value: string): string[] | undefined {
  const normalized = normalizeDisplayText(value);
  if (!/grouped hs code set/i.test(normalized)) {
    return undefined;
  }

  const codes = uniqueStrings([...normalized.matchAll(new RegExp(HS_CODE_PATTERN.source, "g"))].map((match) => match[0]));
  return codes.length > 1 ? codes : undefined;
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

function normalizeForSearch(value: string): string {
  return normalizeDisplayText(value)
    .replace(/[đĐ]/g, "d")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\bca\s+phe\b/g, "coffee");
}

function tokenizeForRanking(value: string): string[] {
  return uniqueStrings(normalizeForSearch(value).split(/[^a-z0-9.]+/g).filter((token) => token.length >= 3));
}

function baselineTokensAfterTerm(normalizedQuestion: string, term: string): string[] {
  const match = normalizedPhraseRegex(term).exec(normalizedQuestion);
  if (!match) {
    return [];
  }
  const after = normalizedQuestion.slice((match.index ?? 0) + match[0].length).trim();
  return after.split(/[^a-z0-9.]+/g).filter((token) => token.length >= 3).slice(0, 4);
}

function baselineTokensFromComparativeThan(normalizedQuestion: string): string[] {
  const tokens: string[] = [];
  const comparativePattern = /\b(?:more|less|higher|lower|longer|shorter|bigger|smaller|stronger|weaker|sweeter|bitterer|milder|drier|fresher)\s+(?:[a-z0-9.]+\s+){0,4}?than\s+([a-z0-9.]+(?:\s+[a-z0-9.]+){0,3})/g;
  for (const match of normalizedQuestion.matchAll(comparativePattern)) {
    tokens.push(...match[1].split(/[^a-z0-9.]+/g).filter((token) => token.length >= 3).slice(0, 4));
  }
  return uniqueStrings(tokens);
}

function includesNormalizedPhrase(value: string, phrase: string): boolean {
  return normalizedPhraseRegex(phrase).test(value);
}

function normalizedPhraseRegex(phrase: string): RegExp {
  const pattern = phrase
    .trim()
    .split(/\s+/g)
    .map(escapeRegExp)
    .join("\\s+");
  return new RegExp(`(?:^|[^a-z0-9])${pattern}(?=$|[^a-z0-9])`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countToken(text: string, token: string): number {
  let count = 0;
  const pattern = new RegExp(`(?:^|[^a-z0-9.])${escapeRegExp(token)}(?=$|[^a-z0-9.])`, "g");
  for (const _match of text.matchAll(pattern)) {
    count += 1;
  }
  return count;
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
  return detectContrastTerms(question).terms.length > 0 ||
    /\b(vs|versus|compare|comparison|difference|different)\b/.test(normalized) ||
    /khác|so sánh|phân biệt/.test(normalized);
}

function ensureSentenceEnd(value: string): string {
  const trimmed = value.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function questionSpecifiesState(question: string): boolean {
  return /\b(fresh|frozen|dried|roasted|raw|processed|breeding|seedling|chips|powder)\b/i.test(question) ||
    /tươi|đông lạnh|khô|rang|sống|chế biến|giống|cây con|mảnh|bột/i.test(question);
}

const QUERY_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "what",
  "which",
  "define",
  "defined",
  "definition",
  "code",
  "hscode",
  "hang",
  "hoa",
  "san",
  "pham",
  "duoc",
  "dinh",
  "nghia",
  "thuoc",
  "loai",
  "nao",
  "cua",
  "cho",
  "trong",
  "mot",
  "cac",
  "voi",
  "hon",
  "khac",
  "thay",
  "khong",
  "phai",
  "is",
  "are",
  "was",
  "were",
  "this",
  "that"
]);

const WEAK_MATCH_TOKENS = new Set([
  "chapter",
  "chuong",
  "noi",
  "dung",
  "tom",
  "tat",
  "liet",
  "ke",
  "main",
  "content",
  "summary",
  "document",
  "file"
]);

const SMALL_TITLE_WORDS = new Set(["of", "the", "and", "or", "for", "to", "in", "on", "with", "not"]);

function extractScientificNames(question: string): string[] {
  const names: string[] = [];
  for (const match of question.matchAll(/\b([A-Z][a-z]{2,}\s+[a-z]{2,})(?:\s+[a-z]{2,})?\b/g)) {
    names.push(match[1]);
  }
  for (const match of question.matchAll(/["'“”‘’]([^"'“”‘’]{3,40})["'“”‘’]/g)) {
    names.push(match[1]);
  }
  return uniqueStrings(names.map((name) => normalizeForSearch(name)).filter((name) => {
    const tokens = name.split(/[^a-z0-9.]+/g).filter(Boolean);
    return tokens.length > 0 && tokens.some((token) => !QUERY_STOPWORDS.has(token));
  }));
}

function extractQuotedTerms(value: string): string[] {
  const terms: string[] = [];
  for (const match of value.matchAll(/["'“”‘’]([^"'“”‘’]{2,80})["'“”‘’]/g)) {
    terms.push(normalizeForSearch(match[1]));
  }
  return uniqueStrings(terms);
}

function extractCapitalizedTerms(value: string): string[] {
  const terms: string[] = [];
  for (const match of value.matchAll(/\b[A-Z][a-z]{2,}(?:\s+[A-Z]?[a-z]{2,}){0,2}\b/g)) {
    const normalized = normalizeForSearch(match[0]);
    const tokens = meaningfulTokens(normalized);
    if (tokens.length > 0 && tokens.some((token) => !QUERY_STOPWORDS.has(token))) {
      terms.push(normalized);
    }
  }
  return uniqueStrings(terms);
}

function meaningfulTokens(value: string): string[] {
  return uniqueStrings(
    normalizeForSearch(value)
      .split(/[^a-z0-9.]+/g)
      .filter((token) => token.length >= 3 || /^\d+(?:\.\d+)?$/.test(token))
      .filter((token) => !QUERY_STOPWORDS.has(token))
  );
}

function buildUsefulPhrases(tokens: string[], sourceText: string): string[] {
  const normalizedSource = normalizeForSearch(sourceText);
  const phrases: string[] = [];
  for (const size of [3, 2]) {
    for (let index = 0; index <= tokens.length - size; index += 1) {
      const phrase = tokens.slice(index, index + size).join(" ");
      if (phrase.length >= 7 && normalizedSource.includes(phrase)) {
        phrases.push(phrase);
      }
    }
  }
  return uniqueStrings(phrases);
}

function isRareQueryToken(token: string): boolean {
  return token.length >= 6 || /\d/.test(token);
}

function isWeakGenericQueryToken(token: string): boolean {
  return /^\d+$/.test(token) || WEAK_MATCH_TOKENS.has(token);
}

function extractNumericRanges(question: string): string[] {
  const normalized = normalizeForSearch(question).replace(/,/g, ".");
  const ranges: string[] = [];
  const patterns = [
    /\b\d+(?:\.\d+)?\s*(?:-|–|to|den|toi)\s*\d+(?:\.\d+)?\s*(?:%|cm|mm|m|kg|g|mg|ppm|do|degree|percent)?\b/g,
    /\b(?:less than|more than|at least|at most|under|over|duoi|tren|hon|it hon|nhieu hon|toi thieu|toi da)\s+\d+(?:\.\d+)?\s*(?:%|cm|mm|m|kg|g|mg|ppm)?\b/g,
    /\b\d+(?:\.\d+)?\s*(?:%|cm|mm|m|kg|g|mg|ppm)\b/g
  ];
  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      ranges.push(match[0].replace(/\s+/g, " ").trim());
    }
  }
  return uniqueStrings(ranges);
}

function candidateMatchesNumericRange(section: EnrichedRetrievedSection, range: string): boolean {
  const candidateText = normalizeForSearch(`${section.title ?? ""} ${section.section ?? ""} ${section.text} ${(section.captions ?? []).join(" ")}`);
  if (includesSignal(candidateText, range)) {
    return true;
  }
  const queryNumbers = numbersInText(range);
  if (queryNumbers.length === 0) {
    return false;
  }
  const candidateNumbers = numbersInText(candidateText);
  return queryNumbers.some((queryNumber) =>
    candidateNumbers.some((candidateNumber) => Math.abs(candidateNumber - queryNumber) < 0.0001)
  );
}

function numbersInText(value: string): number[] {
  return [...value.replace(/,/g, ".").matchAll(/\d+(?:\.\d+)?/g)]
    .map((match) => Number(match[0]))
    .filter((number) => Number.isFinite(number));
}

function includesSignal(text: string, term: string): boolean {
  const normalizedTerm = normalizeForSearch(term);
  if (!normalizedTerm) {
    return false;
  }
  if (/^[a-z0-9.]+$/i.test(normalizedTerm)) {
    return countToken(text, normalizedTerm) > 0;
  }
  return text.includes(normalizedTerm);
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
