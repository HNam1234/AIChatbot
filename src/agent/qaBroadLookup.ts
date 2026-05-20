import {
  HS_CODE_PATTERN,
  hsCodesForSection,
  type CandidateRelevance,
  type ValidatedCandidate
} from "./qaAnswerFormatter";

export interface AmbiguousLookupDetection {
  token: string;
  reason: string;
  candidates: CandidateRelevance[];
}

export type BroadQueryDecision = {
  isBroad: boolean;
  reason: string;
  suggestedMode: "broad_lookup" | "clarification" | "normal";
};

export function detectAmbiguousLookup(
  query: string,
  candidates: CandidateRelevance[]
): AmbiguousLookupDetection | null {
  const tokens = meaningfulIntentTokens(query);
  if (tokens.length !== 1) {
    return null;
  }
  const token = tokens[0];
  const matches = distinctCandidateSections(candidates
    .filter((candidate) => !candidate.rejected)
    .filter((candidate) => hsCodesForCandidate(candidate).length > 0)
    .filter((candidate) => candidateSharesOnlyBroadToken(candidate, token))
    .sort((left, right) => right.finalScore - left.finalScore));

  if (matches.length < 2) {
    return null;
  }

  return {
    token,
    reason: "single broad token matched multiple sections",
    candidates: matches
  };
}

export function detectBroadQuery(args: {
  originalQuery: string;
  querySignals?: unknown;
  validatedCandidates: ValidatedCandidate[];
}): BroadQueryDecision {
  const query = args.originalQuery.trim();
  const tokens = meaningfulIntentTokens(query);
  const accepted = groupDistinctValidatedCandidates(args.validatedCandidates
    .filter((candidate) => candidate.validation.accepted)
    .filter((candidate) => hsCodesForSection(candidate).length > 0));
  const top = accepted[0];
  const second = accepted[1];
  const topRelevance = top?.relevance;
  const exactCodeMatch = Boolean(query.match(HS_CODE_PATTERN) && accepted.some((candidate) => hsCodesForSection(candidate).some((code) => query.includes(code))));
  const strongTitlePhrase = accepted.some((candidate) =>
    candidate.validation.strongSignals.includes("exact_or_near_exact_title_phrase_match") ||
    candidate.validation.strongSignals.includes("distinctive_multi_token_phrase_overlap") ||
    candidate.validation.strongSignals.includes("caption_or_body_distinctive_phrase_match") ||
    candidate.validation.strongSignals.includes("numeric_unit_match_plus_product_or_attribute_evidence") ||
    candidate.validation.strongSignals.includes("scientific_or_latin_like_term_match")
  );
  if (exactCodeMatch) {
    return { isBroad: false, reason: "exact HS code match exists", suggestedMode: "normal" };
  }
  if (accepted.length === 1 && (strongTitlePhrase || top?.validation.confidence !== "low")) {
    return { isBroad: false, reason: "single accepted candidate after validation", suggestedMode: "normal" };
  }
  if (strongTitlePhrase && !multipleSimilarCandidates(accepted)) {
    return { isBroad: false, reason: "strong distinctive phrase/title/numeric evidence exists", suggestedMode: "normal" };
  }
  if (isNumericOnlyQuery(query)) {
    return {
      isBroad: true,
      reason: accepted.length > 0 ? "numeric-only query has related evidence but no product context" : "numeric-only query lacks product context",
      suggestedMode: "clarification"
    };
  }
  if (tokens.length <= 1 && accepted.length >= 2) {
    return {
      isBroad: true,
      reason: "single broad token matched multiple distinct candidates",
      suggestedMode: "broad_lookup"
    };
  }
  if (tokens.length <= 1 && accepted.length <= 1 && !strongTitlePhrase) {
    return {
      isBroad: true,
      reason: "query has fewer than two meaningful distinctive tokens",
      suggestedMode: accepted.length > 0 ? "broad_lookup" : "clarification"
    };
  }
  if (accepted.length >= 2 && topRelevance && second?.relevance) {
    const margin = topRelevance.finalScore - second.relevance.finalScore;
    const lowConfidenceAccepted = accepted.filter((candidate) => candidate.validation.confidence === "low").length;
    const onlyBroadEvidence = accepted.slice(0, 5).every((candidate) => candidateEvidenceIsBroadOnly(candidate.relevance, tokens));
    if (margin >= 15 && !onlyBroadEvidence && lowConfidenceAccepted < 2) {
      return { isBroad: false, reason: "top candidate dominates with sufficient margin", suggestedMode: "normal" };
    }
    if (margin < 10 || lowConfidenceAccepted >= 2 || onlyBroadEvidence) {
      return {
        isBroad: true,
        reason: margin < 10
          ? "top candidate does not clearly dominate similar candidates"
          : onlyBroadEvidence
            ? "evidence is broad/common token only"
            : "multiple accepted candidates have similar low-confidence evidence",
        suggestedMode: "broad_lookup"
      };
    }
  }
  return { isBroad: false, reason: "query has enough distinctive support for normal routing", suggestedMode: "normal" };
}

export function groupDistinctBroadLookupCandidates(candidates: CandidateRelevance[]): CandidateRelevance[] {
  const byKey = new Map<string, CandidateRelevance>();
  for (const candidate of candidates.filter((item) => !item.rejected && hsCodesForCandidate(item).length > 0)) {
    const key = distinctCandidateGroupKey(candidate);
    const existing = byKey.get(key);
    if (!existing || candidate.finalScore > existing.finalScore) {
      byKey.set(key, candidate);
    }
  }
  return [...byKey.values()];
}

export function applyCandidateDocumentScope<T extends { document: string }>(
  candidates: T[],
  allowedDocuments: string[] | undefined
): T[] {
  const allowed = new Set(allowedDocuments ?? []);
  if (allowed.size === 0) {
    return candidates;
  }
  return candidates.filter((candidate) => allowed.has(candidate.document));
}

export function validatedCandidatesFromRelevance(candidates: CandidateRelevance[]): ValidatedCandidate[] {
  return candidates.map((candidate) => ({
    document: candidate.document,
    hsCode: candidate.hsCode,
    groupedHsCodes: candidate.groupedHsCodes,
    title: candidate.title,
    section: candidate.section,
    pageStart: candidate.pageStart ?? undefined,
    pageEnd: candidate.pageEnd ?? undefined,
    source: candidate.source,
    text: "",
    captions: [],
    score: candidate.finalScore,
    metadataWarnings: [],
    relevance: candidate,
    validation: candidate.validation ?? {
      accepted: !candidate.rejected,
      confidence: candidate.rejected ? "low" : "medium",
      reason: candidate.rejectedReason ?? "candidate accepted by relevance",
      strongSignals: [],
      weakSignals: [],
      missingEvidence: []
    }
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

function groupDistinctValidatedCandidates(candidates: ValidatedCandidate[]): ValidatedCandidate[] {
  const byKey = new Map<string, ValidatedCandidate>();
  for (const candidate of candidates) {
    const key = distinctSectionGroupKey(candidate);
    const existing = byKey.get(key);
    if (!existing || (candidate.relevance?.finalScore ?? candidate.score) > (existing.relevance?.finalScore ?? existing.score)) {
      byKey.set(key, candidate);
    }
  }
  return [...byKey.values()].sort((left, right) => (right.relevance?.finalScore ?? right.score) - (left.relevance?.finalScore ?? left.score));
}

function multipleSimilarCandidates(candidates: ValidatedCandidate[]): boolean {
  if (candidates.length < 2) {
    return false;
  }
  const [top, second] = candidates;
  return ((top.relevance?.finalScore ?? top.score) - (second.relevance?.finalScore ?? second.score)) < 10;
}

function candidateEvidenceIsBroadOnly(candidate: CandidateRelevance | undefined, queryTokens: string[]): boolean {
  if (!candidate) {
    return true;
  }
  if (candidate.numericMatches.length > 0 || candidate.matchedNumericRanges.length > 0) {
    return false;
  }
  if (candidate.candidateMatchedPhrases.some((phrase) => meaningfulIntentTokens(phrase).length >= 2)) {
    return false;
  }
  const evidence = uniqueStrings([...candidate.matchedTerms, ...candidate.candidateMatchedTokens]
    .flatMap(meaningfulIntentTokens));
  return evidence.length <= 1 && evidence.every((token) => queryTokens.includes(token));
}

function candidateSharesOnlyBroadToken(candidate: CandidateRelevance, token: string): boolean {
  const evidenceTokens = uniqueStrings([
    ...candidate.matchedTerms,
    ...candidate.candidateMatchedTokens
  ].map(normalizeForIntent).filter(Boolean));
  const phraseTokens = uniqueStrings(candidate.candidateMatchedPhrases.flatMap(meaningfulIntentTokens));
  const nonCodeEvidence = uniqueStrings([...evidenceTokens, ...phraseTokens].filter((term) => !HS_CODE_PATTERN.test(term)));
  return nonCodeEvidence.includes(token) &&
    nonCodeEvidence.every((term) => term === token) &&
    candidate.numericMatches.length === 0 &&
    candidate.matchedNumericRanges.length === 0;
}

function distinctCandidateGroupKey(candidate: CandidateRelevance): string {
  const codes = (candidate.groupedHsCodes.length > 1 ? candidate.groupedHsCodes : hsCodesForCandidate(candidate)).sort().join("|");
  const title = normalizeForIntent(candidate.title ?? titleFromSection(candidate.section) ?? "");
  const section = candidate.groupedHsCodes.length > 1 ? "" : normalizeForIntent(candidate.section ?? "");
  return [
    candidate.document,
    codes,
    title,
    candidate.groupedHsCodes.length > 1 ? "grouped" : section || `${candidate.pageStart ?? ""}-${candidate.pageEnd ?? ""}`
  ].join("|");
}

function distinctSectionGroupKey(section: ValidatedCandidate): string {
  const groupedCodes = section.groupedHsCodes ?? [];
  const codes = (groupedCodes.length > 1 ? groupedCodes : hsCodesForSection(section)).sort().join("|");
  const title = normalizeForIntent(section.title ?? titleFromSection(section.section) ?? "");
  const sectionText = groupedCodes.length > 1 ? "" : normalizeForIntent(section.section ?? "");
  return [
    section.document,
    codes,
    title,
    groupedCodes.length > 1 ? "grouped" : sectionText || `${section.pageStart ?? ""}-${section.pageEnd ?? ""}`
  ].join("|");
}

function hsCodesForCandidate(candidate: CandidateRelevance): string[] {
  return uniqueStrings([
    ...candidate.groupedHsCodes,
    candidate.hsCode
  ].filter((code): code is string => Boolean(code)));
}

function isNumericOnlyQuery(query: string): boolean {
  return /^\s*\d+(?:[.,]\d+)?\s*%?\s*$/.test(query);
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

function titleFromSection(value: string | undefined): string | undefined {
  return value?.replace(HS_CODE_PATTERN, "").replace(/^[\sÃ¢â‚¬â€Ã¢â‚¬â€œ-]+/, "").trim() || undefined;
}

function normalizeForIntent(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[Ã„â€˜Ã„Â]/g, "d")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
