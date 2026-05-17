export interface AlignmentBbox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PdfTextSpan {
  id: string;
  pageNumber: number;
  text: string;
  normalizedText?: string;
  bbox?: AlignmentBbox;
  blockId?: string;
}

export interface ParsedTextUnit {
  id: string;
  document: string;
  pageNumber?: number;
  section?: string;
  hsCode?: string;
  title?: string;
  blockId?: string;
  blockType?: string;
  text: string;
  normalizedText?: string;
  markdownAnchor?: string;
  source: "block" | "section" | "markdown";
}

export interface MappedBlockForAlignment {
  id: string;
  pageNumber?: number;
  bbox?: AlignmentBbox;
  text?: string;
  normalizedText?: string;
}

export interface TextAlignmentScore {
  score: number;
  confidence: "high" | "medium" | "low" | "fallback" | "none";
  reasons: string[];
}

export interface TextAlignmentMatch<T> extends TextAlignmentScore {
  item?: T;
}

export interface TextAlignmentOptions {
  currentPage?: number;
  blocks?: MappedBlockForAlignment[];
  threshold?: number;
}

const STOP_MARKDOWN = /[`*_~>#\[\]()]|!\[[^\]]*]\([^)]*\)|\[[^\]]*]\([^)]*\)/g;
const DIACRITICS = /[\u0300-\u036f]/g;
const TOKEN_SPLIT = /[^a-z0-9.]+/g;
const HS_CODE_PATTERN = /\b\d{2,4}(?:\.\d{2}){1,3}\b/g;
const NUMBER_PATTERN = /\b\d+(?:\.\d+)?\b/g;

export function normalizeTextForAlignment(text: unknown): string {
  return String(text ?? "")
    .replace(STOP_MARKDOWN, " ")
    .replace(/[–—−]/g, "-")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[đĐ]/g, "d")
    .normalize("NFKD")
    .replace(DIACRITICS, "")
    .toLowerCase()
    .replace(/\.{2,}/g, " ")
    .replace(/-{2,}/g, " ")
    .replace(/(?<=\d)-(?=\d)/g, " ")
    .replace(/(?<!\d)\.|\.(?!\d)/g, " ")
    .replace(/[,;:!?/\\|+=%$€£¥^"'{}<>-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function scoreTextAlignment(
  sourceText: string,
  candidateText: string,
  context: {
    samePage?: boolean;
    bboxOverlap?: number;
    sameBlock?: boolean;
  } = {}
): TextAlignmentScore {
  const source = normalizeTextForAlignment(sourceText);
  const candidate = normalizeTextForAlignment(candidateText);
  if (!source || !candidate) {
    return { score: 0, confidence: "none", reasons: ["empty-text"] };
  }

  const reasons: string[] = [];
  let score = 0;

  if (source === candidate) {
    score += 80;
    reasons.push("exact");
  } else if (candidate.includes(source) || source.includes(candidate)) {
    const shorter = Math.min(source.length, candidate.length);
    const longer = Math.max(source.length, candidate.length);
    score += 58 + Math.min(12, (shorter / Math.max(1, longer)) * 12);
    reasons.push("substring");
  }

  const tokenScore = overlapRatio(tokens(source), tokens(candidate));
  if (tokenScore > 0) {
    score += tokenScore * 34;
    reasons.push(`token:${tokenScore.toFixed(2)}`);
  }

  const phraseScore = overlapRatio(phrases(tokens(source), 2), phrases(tokens(candidate), 2));
  if (phraseScore > 0) {
    score += phraseScore * 34;
    reasons.push(`phrase:${phraseScore.toFixed(2)}`);
  }

  const numericScore = overlapRatio(numbers(source), numbers(candidate));
  if (numericScore > 0) {
    score += numericScore * 26;
    reasons.push(`numeric:${numericScore.toFixed(2)}`);
  }

  const hsScore = overlapRatio(hsCodes(source), hsCodes(candidate));
  if (hsScore > 0) {
    score += hsScore * 34;
    reasons.push(`hs:${hsScore.toFixed(2)}`);
  }

  if (context.samePage) {
    score += 8;
    reasons.push("same-page");
  }
  if (context.sameBlock) {
    score += 12;
    reasons.push("same-block");
  }
  if (context.bboxOverlap && context.bboxOverlap > 0) {
    score += Math.min(18, context.bboxOverlap * 18);
    reasons.push(`bbox:${context.bboxOverlap.toFixed(2)}`);
  }

  return {
    score,
    confidence: confidenceForScore(score),
    reasons
  };
}

export function bestMatchPdfSpanToParsedUnit(
  span: PdfTextSpan,
  units: ParsedTextUnit[],
  options: TextAlignmentOptions = {}
): TextAlignmentMatch<ParsedTextUnit> {
  const candidates = samePageCandidates(units, span.pageNumber, options.currentPage);
  return bestMatch(span, candidates, (unit) => scoreTextAlignment(span.text, unit.text, {
    samePage: isSamePage(span.pageNumber, unit.pageNumber, options.currentPage),
    sameBlock: Boolean(span.blockId && unit.blockId && span.blockId === unit.blockId),
    bboxOverlap: span.bbox ? bestBlockOverlap(span.bbox, options.blocks, unit.blockId) : 0
  }), options.threshold ?? 32);
}

export function bestMatchParsedUnitToPdfSpan(
  unit: ParsedTextUnit,
  spans: PdfTextSpan[],
  options: TextAlignmentOptions = {}
): TextAlignmentMatch<PdfTextSpan> {
  const candidates = samePageCandidates(spans, unit.pageNumber, options.currentPage);
  return bestMatch(unit, candidates, (span) => scoreTextAlignment(unit.text, span.text, {
    samePage: isSamePage(span.pageNumber, unit.pageNumber, options.currentPage),
    sameBlock: Boolean(span.blockId && unit.blockId && span.blockId === unit.blockId),
    bboxOverlap: span.bbox ? bestBlockOverlap(span.bbox, options.blocks, unit.blockId) : 0
  }), options.threshold ?? 30);
}

export function fallbackBlockForPdfSpan(
  span: PdfTextSpan,
  blocks: MappedBlockForAlignment[] = []
): TextAlignmentMatch<MappedBlockForAlignment> {
  const candidates = blocks.filter((block) => !block.pageNumber || block.pageNumber === span.pageNumber);
  const match = bestMatch(span, candidates, (block) => {
    const textScore = scoreTextAlignment(span.text, block.text ?? "", { samePage: true });
    const overlap = span.bbox && block.bbox ? bboxOverlapRatio(span.bbox, block.bbox) : 0;
    return {
      score: textScore.score * 0.55 + overlap * 45,
      confidence: "fallback",
      reasons: [...textScore.reasons, overlap > 0 ? `bbox:${overlap.toFixed(2)}` : "block-fallback"]
    };
  }, 8);
  return match.item ? { ...match, confidence: "fallback" } : match;
}

export function bboxOverlapRatio(a: AlignmentBbox, b: AlignmentBbox): number {
  const x0 = Math.max(a.x0, b.x0);
  const y0 = Math.max(a.y0, b.y0);
  const x1 = Math.min(a.x1, b.x1);
  const y1 = Math.min(a.y1, b.y1);
  const intersection = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const area = Math.max(1, (a.x1 - a.x0) * (a.y1 - a.y0));
  return Math.max(0, Math.min(1, intersection / area));
}

function bestMatch<T>(
  source: unknown,
  candidates: T[],
  scorer: (candidate: T) => TextAlignmentScore,
  threshold: number
): TextAlignmentMatch<T> {
  let best: TextAlignmentMatch<T> = { score: 0, confidence: "none", reasons: ["no-candidates"] };
  void source;
  for (const candidate of candidates) {
    const scored = scorer(candidate);
    if (scored.score > best.score) {
      best = { ...scored, item: candidate };
    }
  }
  if (!best.item || best.score < threshold) {
    return { ...best, item: undefined, confidence: best.score > 0 ? "low" : "none" };
  }
  return best;
}

function tokens(text: string): string[] {
  return unique(
    text
      .split(TOKEN_SPLIT)
      .map((token) => token.trim())
      .filter((token) => token.length > 1)
  );
}

function numbers(text: string): string[] {
  return unique(text.match(NUMBER_PATTERN) ?? []);
}

function hsCodes(text: string): string[] {
  return unique(text.match(HS_CODE_PATTERN) ?? []);
}

function phrases(items: string[], size: number): string[] {
  if (items.length < size) return [];
  const result: string[] = [];
  for (let index = 0; index <= items.length - size; index += 1) {
    result.push(items.slice(index, index + size).join(" "));
  }
  return unique(result);
}

function overlapRatio(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const rightSet = new Set(right);
  const shared = left.filter((item) => rightSet.has(item)).length;
  return shared / Math.max(1, Math.min(left.length, right.length));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function confidenceForScore(score: number): TextAlignmentScore["confidence"] {
  if (score >= 82) return "high";
  if (score >= 48) return "medium";
  if (score > 0) return "low";
  return "none";
}

function isSamePage(spanPage?: number, unitPage?: number, currentPage?: number): boolean {
  if (spanPage && unitPage) return spanPage === unitPage;
  if (spanPage && currentPage) return spanPage === currentPage;
  if (unitPage && currentPage) return unitPage === currentPage;
  return false;
}

function bestBlockOverlap(
  bbox: AlignmentBbox,
  blocks: MappedBlockForAlignment[] | undefined,
  blockId: string | undefined
): number {
  if (!blocks?.length) return 0;
  const candidates = blockId ? blocks.filter((block) => block.id === blockId) : blocks;
  return candidates.reduce((best, block) => block.bbox ? Math.max(best, bboxOverlapRatio(bbox, block.bbox)) : best, 0);
}

function samePageCandidates<T extends { pageNumber?: number }>(items: T[], pageNumber?: number, currentPage?: number): T[] {
  const targetPage = pageNumber ?? currentPage;
  if (!targetPage) return items;
  const samePage = items.filter((item) => item.pageNumber === targetPage);
  return samePage.length > 0 ? samePage : items;
}
