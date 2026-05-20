import {
  HS_CODE_PATTERN,
  hsCodesForSection,
  normalizeProductTitle,
  prefersVietnameseAnswer,
  type QuerySignals,
  type ValidatedCandidate
} from "./qaAnswerFormatter";
import { FIELD_SYNONYM_GROUPS, canonicalRequestedFieldFromText, extractRequestedField, normalizeFieldText } from "./fieldExtractor";

export type LocalAnswerResult = {
  answer: string | null;
  answerGeneration:
    | "template-classification"
    | "extractive-definition"
    | "extractive-field"
    | "broad-lookup"
    | "safe-fallback";
  confidence: "high" | "medium" | "low";
  reason: string;
};

export interface AnswerPolicy {
  classificationRequested?: boolean;
  definitionRequested?: boolean;
  requestedField?: string | null;
  attachHsCode?: boolean;
  allowRelatedHsCode?: boolean;
  maxAnswerChars?: number;
}

interface AnswerBlock {
  heading: string;
  text: string;
  type: "heading" | "bullet" | "paragraph" | "table" | "caption";
}

interface TableComparisonAnswer {
  answer: string;
  confidence: "high" | "medium";
  reason: string;
}

interface ParsedTableRow {
  label: string;
  values: Array<{ column: string; value: number; rawValue: string }>;
}

const DEFAULT_MAX_ANSWER_CHARS = 420;
const LOCAL_STOPWORDS = new Set([
  "the", "and", "or", "for", "with", "what", "which", "how", "does", "are", "is", "was", "were",
  "this", "that", "these", "those", "code", "hscode", "hs", "hang", "hoa", "san", "pham", "cua",
  "cho", "trong", "mot", "cac", "nhung", "nao", "gi", "la", "co", "ve", "noi", "dung",
  "more", "less", "than", "has", "have", "having", "compared", "compare", "versus"
]);
const DEBUG_LABEL_PATTERN = /\b(Index source|PageIndex logs?|cache freshness|final score|candidate debug|candidate|cache status|Primary citation|Related citation|Retrieval|PageIndex|raw JSON):[\s\S]*$/i;
const LOCAL_TOKEN_EQUIVALENTS = new Map<string, string[]>([
  ["high", ["higher", "highest"]],
  ["higher", ["high", "highest"]],
  ["low", ["lower", "lowest"]],
  ["lower", ["low", "lowest"]],
  ["large", ["larger", "largest"]],
  ["larger", ["large", "largest"]],
  ["long", ["longer", "longest"]],
  ["longer", ["long", "longest"]],
  ["round", ["rounder"]],
  ["rounder", ["round"]],
  ["coarse", ["coarser"]],
  ["coarser", ["coarse"]],
  ["smooth", ["smoother"]],
  ["smoother", ["smooth"]],
  ["dry", ["dried", "drier"]],
  ["dried", ["dry", "drier"]]
]);

export function generateLocalAnswer(args: {
  originalQuery: string;
  selectedCandidate: ValidatedCandidate;
  selectedSectionText: string;
  querySignals: QuerySignals;
  answerPolicy: AnswerPolicy;
}): LocalAnswerResult {
  const { originalQuery, selectedCandidate, selectedSectionText, querySignals, answerPolicy } = args;
  const maxChars = answerPolicy.maxAnswerChars ?? DEFAULT_MAX_ANSWER_CHARS;

  if (answerPolicy.classificationRequested || asksForHsCodeOrClassification(originalQuery)) {
    return classificationAnswer(selectedCandidate, originalQuery);
  }

  if (answerPolicy.definitionRequested || isDefinitionQuery(originalQuery) || answerPolicy.requestedField === "definition") {
    const definition = extractDefinitionParagraph(selectedSectionText, maxChars);
    if (!definition) {
      return nullAnswer("extractive-definition", "no descriptive definition evidence found");
    }
    const answer = maybeAppendHsCodeSentence(definition, selectedCandidate, answerPolicy.attachHsCode ?? true);
    return {
      answer,
      answerGeneration: "extractive-definition",
      confidence: selectedCandidate.validation.confidence === "low" ? "medium" : "high",
      reason: "definition extracted from selected section text"
    };
  }

  const requestedField = answerPolicy.requestedField ?? canonicalRequestedFieldFromText(originalQuery);
  if (!requestedField && !hasGeneralEvidenceSignal(originalQuery, querySignals)) {
    return nullAnswer("safe-fallback", "local_extractor_no_requested_field");
  }
  const tableComparison = tryTableComparisonAnswer(originalQuery, selectedSectionText, querySignals);
  if (tableComparison) {
    return {
      answer: tableComparison.answer,
      answerGeneration: "extractive-field",
      confidence: tableComparison.confidence,
      reason: tableComparison.reason
    };
  }
  if (requestedField) {
    const extracted = extractRequestedField(selectedSectionText, requestedField);
    const extractedAnswer = cleanAnswerText(extracted.extractedText, maxChars);
    const normalizedExtracted = normalizeForLocal(extractedAnswer);
    const normalizedField = normalizeForLocal(requestedField);
    const normalizedHeading = normalizeForLocal(extracted.matchedHeading ?? "");
    if (
      extractedAnswer &&
      extracted.confidence !== "low" &&
      normalizedExtracted !== normalizedField &&
      normalizedExtracted !== normalizedHeading
    ) {
      const fieldAnswer = extracted.matchedHeading && !normalizeForLocal(extractedAnswer).startsWith(normalizedHeading)
        ? `${extracted.matchedHeading}: ${extractedAnswer}`
        : extractedAnswer;
      return {
        answer: ensureSentence(fieldAnswer),
        answerGeneration: "extractive-field",
        confidence: extracted.confidence,
        reason: `matched requested field '${requestedField}'${extracted.matchedHeading ? ` under '${extracted.matchedHeading}'` : ""}`
      };
    }
  }
  const blocks = segmentAnswerBlocks(selectedSectionText);
  const best = bestScoredBlock(blocks, originalQuery, querySignals, requestedField);
  if (!best || best.score < 3.2) {
    return nullAnswer("safe-fallback", "no medium-confidence local field evidence found");
  }

  const confidence = best.score >= 6 ? "high" : "medium";
  let answer = focusedAnswerText(best.block, originalQuery, querySignals, requestedField, maxChars);
  if (asksForHsCodeOrClassification(originalQuery)) {
    answer = maybeAppendRelatedCode(answer, selectedCandidate, answerPolicy, confidence);
  }
  return {
    answer,
    answerGeneration: "extractive-field",
    confidence,
    reason: `matched ${best.block.type} block${best.block.heading ? ` under '${best.block.heading}'` : ""}`
  };
}

function classificationAnswer(candidate: ValidatedCandidate, query: string): LocalAnswerResult {
  const codes = hsCodesForSection(candidate);
  const vietnamese = prefersVietnameseAnswer(query);
  if (codes.length === 0) {
    return nullAnswer("template-classification", "selected candidate has no HS code metadata");
  }
  const title = normalizeProductTitle(candidate.title || titleFromSection(candidate.section) || candidate.section || (vietnamese ? "sản phẩm phù hợp" : "the matching product"));
  const codeText = formatHsCodes(codes, vietnamese);
  const suffix = codes.length > 1
    ? vietnamese
      ? ", tùy trạng thái hàng hóa trong biểu mã."
      : ", depending on the product state in the tariff."
    : ".";
  return {
    answer: vietnamese
      ? `Sản phẩm là ${title}, HS Code: ${codeText}${suffix}`
      : `The product is ${title}, HS Code: ${codeText}${suffix}`,
    answerGeneration: "template-classification",
    confidence: candidate.validation.confidence === "low" ? "medium" : "high",
    reason: "classification answered from selected candidate metadata"
  };
}

function extractDefinitionParagraph(sectionText: string, maxChars: number): string | null {
  const blocks = segmentAnswerBlocks(sectionText);
  const descriptive = blocks
    .map((block) => block.text)
    .map((text) => cleanDefinitionText(text, maxChars))
    .find((text) => text && hasMeaningfulLetters(text));
  return descriptive ? ensureSentence(textWithoutDuplicateHsCode(descriptive)) : null;
}

function segmentAnswerBlocks(sectionText: string): AnswerBlock[] {
  const cleaned = normalizeSectionText(sectionText);
  if (!cleaned) {
    return [];
  }
  const expanded = expandInlineFieldLabels(cleaned)
    .replace(/[•▪◦]/g, "\n- ")
    .replace(/(?:^|\n)\s+-\s+/g, "\n- ");
  const lines = expanded.split(/\n+/g).map((line) => line.trim()).filter(Boolean);
  const blocks: AnswerBlock[] = [];
  let currentHeading = "";
  let bulletBuffer: string[] = [];
  let paragraphBuffer: string[] = [];

  const flushBullets = () => {
    if (bulletBuffer.length === 0) return;
    blocks.push({
      heading: currentHeading,
      text: cleanAnswerText([currentHeading, ...bulletBuffer].filter(Boolean).join(": ")),
      type: "bullet"
    });
    bulletBuffer = [];
  };
  const flushParagraph = () => {
    if (paragraphBuffer.length === 0) return;
    blocks.push({
      heading: currentHeading,
      text: cleanAnswerText(paragraphBuffer.join(" ")),
      type: "paragraph"
    });
    paragraphBuffer = [];
  };

  for (const rawLine of lines) {
    const line = stripDebugTail(rawLine);
    if (!line) {
      continue;
    }
    if (isNoiseLine(line)) {
      continue;
    }
    const heading = parseHeadingLine(line);
    if (heading) {
      flushBullets();
      flushParagraph();
      currentHeading = heading.heading;
      if (heading.inlineText) {
        blocks.push({ heading: currentHeading, text: cleanAnswerText(heading.inlineText), type: "heading" });
      }
      continue;
    }
    if (isStandaloneFieldHeading(line)) {
      flushBullets();
      flushParagraph();
      currentHeading = line.trim();
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      flushParagraph();
      bulletBuffer.push(line.replace(/^[-*]\s+/, ""));
      continue;
    }
    if (line.includes("|") || /\S+\s{2,}\S+/.test(line)) {
      flushBullets();
      flushParagraph();
      blocks.push({ heading: currentHeading, text: cleanAnswerText(line), type: "table" });
      continue;
    }
    flushBullets();
    paragraphBuffer.push(line);
  }
  flushBullets();
  flushParagraph();

  if (blocks.length === 0) {
    return splitParagraphs(cleaned).map((text) => ({ heading: "", text: cleanAnswerText(text), type: "paragraph" }));
  }
  return blocks.filter((block) => block.text.length >= 8 && hasMeaningfulLetters(block.text));
}

function bestScoredBlock(
  blocks: AnswerBlock[],
  query: string,
  querySignals: QuerySignals,
  requestedField: string | null
): { block: AnswerBlock; score: number } | null {
  let best: { block: AnswerBlock; score: number } | null = null;
  for (const block of blocks) {
    const score = scoreBlock(block, query, querySignals, requestedField);
    if (!best || score > best.score) {
      best = { block, score };
    }
  }
  return best;
}

function hasGeneralEvidenceSignal(query: string, querySignals: QuerySignals): boolean {
  const normalized = normalizeForLocal(query);
  const answerableUsageTerms = querySignals.usageTerms.filter((term) =>
    !["breeding", "sowing", "planting"].includes(normalizeForLocal(term))
  );
  return querySignals.physicalAttributes.length > 0 ||
    answerableUsageTerms.length > 0 ||
    querySignals.tradeForms.length > 0 ||
    querySignals.numericRanges.length > 0 ||
    /\b(compare|comparison|different|difference|more|less|higher|lower|longer|shorter|vs|versus)\b/.test(normalized) ||
    /\b(so\s+sanh|khac|phan\s+biet|hon|it\s+hon|nhieu\s+hon)\b/.test(normalized);
}

function tryTableComparisonAnswer(
  query: string,
  sectionText: string,
  querySignals: QuerySignals
): TableComparisonAnswer | null {
  const direction = tableComparisonDirection(query);
  if (!direction) {
    return null;
  }

  const rows = parseTableRows(sectionText, query);
  if (rows.length === 0) {
    return null;
  }

  const row = selectMetricRow(rows, query, querySignals);
  if (!row || row.values.length < 2) {
    return null;
  }

  const comparedValues = selectComparedValues(row.values, query);
  if (comparedValues.length < 2) {
    return null;
  }

  const sorted = [...comparedValues].sort((left, right) =>
    direction === "higher" ? right.value - left.value : left.value - right.value
  );
  const selected = sorted[0];
  const baseline = sorted.find((value) => value.column !== selected.column) ?? sorted[1];
  if (!selected || !baseline) {
    return null;
  }
  if (Math.abs(selected.value - baseline.value) < 0.000001) {
    const metric = formatMetricLabel(row.label);
    const vietnamese = prefersVietnameseAnswer(query);
    return {
      answer: vietnamese
        ? `${formatColumnLabel(selected.column, true)} và ${formatColumnLabel(baseline.column)} có ${metric} bằng nhau: ${formatTableValue(selected.rawValue, row.label)}.`
        : `${formatColumnLabel(selected.column, true)} and ${formatColumnLabel(baseline.column)} have the same ${metric}: ${formatTableValue(selected.rawValue, row.label)}.`,
      confidence: "medium",
      reason: `matched table row '${row.label}'`
    };
  }

  const metric = formatMetricLabel(row.label);
  const vietnamese = prefersVietnameseAnswer(query);
  const relation = direction === "higher"
    ? vietnamese ? "cao hơn" : "higher"
    : vietnamese ? "thấp hơn" : "lower";
  return {
    answer: vietnamese
      ? `${formatColumnLabel(selected.column, true)} có ${metric} ${relation}: ${formatTableValue(selected.rawValue, row.label)} so với ${formatColumnLabel(baseline.column)} ${formatTableValue(baseline.rawValue, row.label)}.`
      : `${formatColumnLabel(selected.column, true)} has ${relation} ${metric}: ${formatTableValue(selected.rawValue, row.label)} compared with ${formatColumnLabel(baseline.column)} ${formatTableValue(baseline.rawValue, row.label)}.`,
    confidence: "high",
    reason: `matched table row '${row.label}'`
  };
}

function tableComparisonDirection(query: string): "higher" | "lower" | null {
  const normalized = normalizeForLocal(query);
  if (/\b(higher|more|greater|larger|cao\s+hon|nhieu\s+hon)\b/.test(normalized)) {
    return "higher";
  }
  if (/\b(lower|less|smaller|thap\s+hon|it\s+hon)\b/.test(normalized)) {
    return "lower";
  }
  return null;
}

function parseTableRows(sectionText: string, query: string): ParsedTableRow[] {
  return uniqueTableRows([
    ...parseMarkdownTableRows(sectionText),
    ...parseFlattenedNumericRows(sectionText, query)
  ]);
}

function parseMarkdownTableRows(sectionText: string): ParsedTableRow[] {
  const rows: ParsedTableRow[] = [];
  const lines = sectionText.split(/\n+/g).map((line) => line.trim()).filter((line) => line.includes("|"));
  for (let index = 0; index < lines.length; index += 1) {
    const header = parseMarkdownTableLine(lines[index]);
    const separator = parseMarkdownTableLine(lines[index + 1] ?? "");
    if (header.length < 3 || !separator.some((cell) => /^:?-{2,}:?$/.test(cell))) {
      continue;
    }
    const columns = header.slice(1).map(normalizeColumnLabel).filter(Boolean);
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const cells = parseMarkdownTableLine(lines[rowIndex]);
      if (cells.length < 3) {
        break;
      }
      const label = normalizeTableLabel(cells[0]);
      const values = cells.slice(1).map((cell, valueIndex) => {
        const rawValue = numericText(cell);
        return rawValue && columns[valueIndex]
          ? { column: columns[valueIndex], value: Number(rawValue), rawValue }
          : null;
      }).filter((value): value is ParsedTableRow["values"][number] => Boolean(value));
      if (label && values.length >= 2) {
        rows.push({ label, values });
      }
    }
  }
  return rows;
}

function parseMarkdownTableLine(line: string): string[] {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function parseFlattenedNumericRows(sectionText: string, query: string): ParsedTableRow[] {
  const columns = inferComparisonColumns(sectionText, query);
  if (columns.length < 2) {
    return [];
  }
  const compact = normalizeSectionText(sectionText)
    .replace(/[|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const rows: ParsedTableRow[] = [];
  const rowPattern = /([A-Za-z][A-Za-z /()%.-]{0,90}?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)(?=\s+[A-Za-z]|$)/g;
  for (const match of compact.matchAll(rowPattern)) {
    const label = normalizeTableLabel(match[1] ?? "");
    const first = match[2] ?? "";
    const second = match[3] ?? "";
    if (!label || !first || !second || labelLooksLikeHeaderOnly(label)) {
      continue;
    }
    rows.push({
      label,
      values: [
        { column: columns[0], value: Number(first), rawValue: first },
        { column: columns[1], value: Number(second), rawValue: second }
      ]
    });
  }
  return rows;
}

function inferComparisonColumns(sectionText: string, query: string): string[] {
  const normalized = normalizeForLocal(`${query} ${sectionText}`);
  const hasMature = /\bmature\b/.test(normalized);
  const hasTenderYoung = /\btender\s*\/\s*young\b|\btender\b|\byoung\b/.test(normalized);
  if (hasMature && hasTenderYoung) {
    const suffix = /\bcoconut\s+water\b/.test(normalized) ? " coconut water" : "";
    return [`mature${suffix}`, `tender/young${suffix}`];
  }
  return [];
}

function selectMetricRow(rows: ParsedTableRow[], query: string, querySignals: QuerySignals): ParsedTableRow | null {
  const normalizedQuery = normalizeForLocal(query);
  const queryTokens = new Set(meaningfulLocalTokens(query));
  const phraseSignals = uniqueStrings([
    ...querySignals.queryPhrases,
    ...querySignals.productTerms,
    ...querySignals.physicalAttributes,
    ...querySignals.domainTerms
  ].map(normalizeForLocal).filter((value) => value.length >= 4));
  const scored = rows.map((row, index) => {
    const normalizedLabel = normalizeForLocal(row.label);
    const labelTokens = meaningfulLocalTokens(row.label);
    let score = 0;
    if (normalizedQuery.includes(normalizedLabel)) {
      score += 6;
    }
    for (const phrase of phraseSignals) {
      if (phrase && (normalizedLabel.includes(phrase) || phrase.includes(normalizedLabel))) {
        score += 4;
      }
    }
    score += labelTokens.filter((token) => queryTokens.has(token)).length * 2;
    return { row, score, index };
  }).filter((item) => item.score >= 2);

  return scored.sort((left, right) => right.score - left.score || left.index - right.index)[0]?.row ?? null;
}

function selectComparedValues(
  values: ParsedTableRow["values"],
  query: string
): ParsedTableRow["values"] {
  const normalizedQuery = normalizeForLocal(query);
  const mentioned = values.filter((value) => {
    const column = normalizeForLocal(value.column);
    return column.split(/\s+|\//g).filter((token) => token.length >= 3).some((token) => normalizedQuery.includes(token));
  });
  return mentioned.length >= 2 ? mentioned : values;
}

function uniqueTableRows(rows: ParsedTableRow[]): ParsedTableRow[] {
  const byKey = new Map<string, ParsedTableRow>();
  for (const row of rows) {
    const key = normalizeForLocal(row.label);
    if (!byKey.has(key)) {
      byKey.set(key, row);
    }
  }
  return [...byKey.values()];
}

function labelLooksLikeHeaderOnly(label: string): boolean {
  const normalized = normalizeForLocal(label);
  return normalized === "water" || normalized.endsWith(" coconut water") || normalized.includes("table ");
}

function normalizeTableLabel(value: string): string {
  return value
    .replace(/\b(?:mature\s+coconut\s+water|tender\/young\s+coconut(?:\s+water)?|water)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeColumnLabel(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function numericText(value: string): string | null {
  return value.match(/-?\d+(?:\.\d+)?/)?.[0] ?? null;
}

function formatMetricLabel(label: string): string {
  return label
    .replace(/\s*(?:mg\s*)?%/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function formatColumnLabel(label: string, sentenceStart = false): string {
  const normalized = label.replace(/\s+/g, " ").trim().toLowerCase();
  return sentenceStart && normalized ? `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}` : normalized;
}

function formatTableValue(value: string, label: string): string {
  const raw = value.trim();
  if (/mg\s*%/i.test(label)) {
    return `${raw} mg%`;
  }
  if (/%/.test(label)) {
    return `${raw}%`;
  }
  return raw;
}

function scoreBlock(block: AnswerBlock, query: string, querySignals: QuerySignals, requestedField: string | null): number {
  const blockText = normalizeForLocal(`${block.heading} ${block.text}`);
  const blockTokens = new Set(meaningfulLocalTokens(blockText));
  const contrastTokens = new Set(querySignals.contrastTerms.flatMap(meaningfulLocalTokens));
  const queryTokens = uniqueStrings([
    ...querySignals.queryTokens,
    ...querySignals.physicalAttributes.flatMap(meaningfulLocalTokens),
    ...querySignals.usageTerms.flatMap(meaningfulLocalTokens),
    ...querySignals.tradeForms.flatMap(meaningfulLocalTokens),
    ...querySignals.scientificNames.flatMap(meaningfulLocalTokens),
    ...meaningfulLocalTokens(query)
  ]).filter((token) => !contrastTokens.has(token) && !LOCAL_STOPWORDS.has(token));
  let score = 0;

  for (const phrase of querySignals.queryPhrases) {
    if (phrase.length >= 6 && blockText.includes(normalizeForLocal(phrase))) {
      score += 3.5;
    }
  }
  for (const token of queryTokens) {
    if (tokenMatchesLocal(blockTokens, token)) {
      score += isDistinctiveToken(token) ? 1.7 : 0.6;
    }
  }
  for (const range of querySignals.numericRanges) {
    if (blockText.includes(normalizeForLocal(range))) {
      score += 3;
    }
  }
  const field = requestedField ?? canonicalRequestedFieldFromText(query);
  if (field) {
    const fieldScore = fieldOverlapScore(field, block.heading || block.text);
    score += fieldScore * 5;
    if (block.heading && fieldOverlapScore(field, block.heading) > 0) {
      score += 1.5;
    } else if (block.heading) {
      score -= 1.5;
    }
  }
  const missingDistinctiveTokens = queryTokens.filter((token) => isDistinctiveToken(token) && !tokenMatchesLocal(blockTokens, token));
  const allowedMissing = field ? 2 : 3;
  score -= Math.max(0, missingDistinctiveTokens.length - allowedMissing) * (field ? 0.4 : 1.2);
  if (block.type === "bullet" || block.type === "heading") {
    score += 0.8;
  }
  return score;
}

function focusedAnswerText(
  block: AnswerBlock,
  query: string,
  querySignals: QuerySignals,
  requestedField: string | null,
  maxChars: number
): string {
  const blockText = block.type === "heading" && block.heading && block.text
    ? `${block.heading}: ${block.text}`
    : block.text || block.heading;
  if (requestedField) {
    return cleanAnswerText(blockText, maxChars);
  }

  const chunks = splitEvidenceChunks(blockText);
  if (chunks.length <= 1) {
    return cleanAnswerText(blockText, maxChars);
  }

  const scored = chunks
    .map((text, index) => ({
      text,
      index,
      score: scoreBlock({ heading: block.heading, text, type: "paragraph" }, query, querySignals, requestedField)
    }))
    .filter((item) => item.score >= 1.4)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 2)
    .sort((left, right) => left.index - right.index);
  const selected = scored.map((item) => item.text).join(" ");
  return cleanAnswerText(selected || blockText, maxChars);
}

function splitEvidenceChunks(value: string): string[] {
  const normalized = value
    .replace(/[â€¢ï‚·â–ªâ—¦]/g, "\n")
    .replace(/\s+(?=(?:Physical|The content of|Content of|Aroma|Usage|Appearance|Activeness|Weight and size|Condition)\s*:)/gi, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
  return normalized
    .split(/(?<=[.!?])\s+|\n+/g)
    .map((part) => cleanAnswerText(part, 260))
    .filter((part) => part.length >= 12 && hasMeaningfulLetters(part));
}

function tokenMatchesLocal(tokens: Set<string>, token: string): boolean {
  if (tokens.has(token)) {
    return true;
  }
  return (LOCAL_TOKEN_EQUIVALENTS.get(token) ?? []).some((equivalent) => tokens.has(equivalent));
}

function fieldOverlapScore(field: string, text: string): number {
  const normalizedField = normalizeFieldText(field);
  const normalizedText = normalizeFieldText(text);
  if (!normalizedField || !normalizedText) return 0;
  if (normalizedText.includes(normalizedField)) return 1;
  const fieldTokens = meaningfulLocalTokens(normalizedField);
  const textTokens = new Set(meaningfulLocalTokens(normalizedText));
  const tokenOverlap = fieldTokens.filter((token) => textTokens.has(token)).length;
  const groupOverlap = FIELD_SYNONYM_GROUPS.filter((group) =>
    group.labels.some((label) => normalizedField.includes(normalizeFieldText(label))) &&
    group.labels.some((label) => normalizedText.includes(normalizeFieldText(label)))
  ).length;
  return Math.min(1, (tokenOverlap / Math.max(1, fieldTokens.length)) * 0.45 + Math.min(1, groupOverlap) * 0.55);
}

function maybeAppendHsCodeSentence(answer: string, candidate: ValidatedCandidate, attach: boolean): string {
  if (!attach || HS_CODE_PATTERN.test(answer)) {
    return ensureSentence(answer);
  }
  const codes = hsCodesForSection(candidate);
  return codes.length > 0 ? `${ensureSentence(answer)} HS Code: ${formatHsCodes(codes)}.` : ensureSentence(answer);
}

function maybeAppendRelatedCode(
  answer: string,
  candidate: ValidatedCandidate,
  policy: AnswerPolicy,
  confidence: LocalAnswerResult["confidence"]
): string {
  if (policy.allowRelatedHsCode === false || confidence === "low" || candidate.validation.confidence === "low" || HS_CODE_PATTERN.test(answer) || answer.length > 340) {
    return ensureSentence(answer);
  }
  const codes = hsCodesForSection(candidate);
  if (codes.length > 3) {
    return ensureSentence(answer);
  }
  return codes.length > 0 ? `${ensureSentence(answer)} Mã liên quan: ${formatHsCodes(codes)}.` : ensureSentence(answer);
}

function formatHsCodes(codes: string[], vietnamese = true): string {
  const uniqueCodes = uniqueStrings(codes);
  if (uniqueCodes.length <= 1) return uniqueCodes[0] ?? "";
  const joiner = vietnamese ? "hoặc" : "or";
  if (uniqueCodes.length === 2) return `${uniqueCodes[0]} ${joiner} ${uniqueCodes[1]}`;
  return `${uniqueCodes.slice(0, -1).join(", ")} ${joiner} ${uniqueCodes[uniqueCodes.length - 1]}`;
}

function cleanDefinitionText(value: string, maxChars: number): string {
  const cleaned = cleanAnswerText(value, maxChars)
    .replace(/^Grouped HS code set:\s*[\s\S]*?(?=\bShared description:|\n|$)/i, "")
    .replace(/^Shared description:\s*/i, "")
    .replace(/^Definition:\s*/i, "")
    .trim();
  return shortenToSentences(cleaned, maxChars);
}

function cleanAnswerText(value: string, maxChars = DEFAULT_MAX_ANSWER_CHARS): string {
  const cleaned = value
    .replace(/<doc=[^>]+>/gi, " ")
    .replace(DEBUG_LABEL_PATTERN, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\bGrouped HS code set:\s*[\s\S]*?(?=\bShared description:|\n|$)/gi, " ")
    .replace(/\bShared description:\s*/gi, " ")
    .replace(/[•▪◦\uf0b7]/g, " ")
    .replace(/^\s*(?:Source|Citation|Page|Image|Picture|Caption):.*$/gim, " ")
    .replace(/^\s*\(?Source:[^)]+\)?\s*$/gim, " ")
    .replace(/^\s*\d{4}\.\d{2}\.\d{2}\s*[-—–].*$/gm, " ")
    .replace(/\{[\s\S]*\}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return shortenToSentences(textWithoutDuplicateHsCode(cleaned), maxChars);
}

function stripDebugTail(value: string): string {
  return value.replace(DEBUG_LABEL_PATTERN, " ").replace(/\s+/g, " ").trim();
}

function shortenToSentences(value: string, maxChars: number): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxChars) {
    return cleaned;
  }
  const sentences = splitSentences(cleaned);
  const selected: string[] = [];
  for (const sentence of sentences) {
    const next = [...selected, sentence].join(" ");
    if (next.length > maxChars) break;
    selected.push(sentence);
  }
  return (selected.join(" ") || cleaned.slice(0, maxChars).replace(/\s+\S*$/g, "")).trim();
}

function normalizeSectionText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/!\[[^\]]*]\([^)]+\)/g, "")
    .replace(/\bGrouped HS code set:\s*[\s\S]*?(?=\bShared description:|\n|$)/gi, "\n")
    .replace(/\bShared description:\s*/gi, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function expandInlineFieldLabels(value: string): string {
  const labels = FIELD_SYNONYM_GROUPS
    .flatMap((group) => group.labels)
    .concat(["general requirements on appearance", "scientific name", "dimension", "dimensions", "process", "processing", "material", "composition"])
    .filter((label) => label.length >= 4)
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExp)
    .join("|");
  return value.replace(new RegExp(`\\b((?:${labels})(?:\\s+(?:requirements?|characteristics?|notes?))?)\\s*:`, "gi"), "\n$1:\n");
}

function parseHeadingLine(line: string): { heading: string; inlineText: string } | null {
  const normalizedLine = line.replace(/^[-*]\s+/, "");
  const markdown = normalizedLine.match(/^#{1,6}\s+(.+)$/);
  if (markdown) return { heading: markdown[1].trim(), inlineText: "" };
  const colon = normalizedLine.match(/^([^:]{3,100}):\s*(.*)$/);
  if (colon && isCompactHeading(colon[1])) {
    return { heading: colon[1].trim(), inlineText: colon[2]?.trim() ?? "" };
  }
  if (isCompactHeading(normalizedLine) && canonicalRequestedFieldFromText(normalizedLine)) {
    return { heading: normalizedLine.trim(), inlineText: "" };
  }
  return null;
}

function isStandaloneFieldHeading(line: string): boolean {
  const trimmed = line.trim();
  return isCompactHeading(trimmed) && canonicalRequestedFieldFromText(trimmed) !== null;
}

function isCompactHeading(value: string): boolean {
  const words = value.trim().split(/\s+/g).filter(Boolean);
  return words.length > 0 && words.length <= 14 && value.length <= 100;
}

function isNoiseLine(line: string): boolean {
  return /^\s*(?:source|citation|page|index source|pageindex|cache status|final score)\b/i.test(line) ||
    /^\s*(?:grouped hs code set|shared description)\b/i.test(line) ||
    /^\s*\(?Source:[^)]+\)?\s*$/i.test(line) ||
    /^#{1,6}\s*\d{4}\.\d{2}\.\d{2}\b/.test(line) ||
    /^\s*\d{4}\.\d{2}\.\d{2}\s*[-â€”â€“]/.test(line);
}

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}|(?<=[.!?])\s+(?=[A-Z])/g)
    .map((part) => part.trim())
    .filter((part) => part.length >= 8);
}

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/g).map((part) => part.trim()).filter(Boolean);
}

function asksForHsCodeOrClassification(query: string): boolean {
  const normalized = normalizeForLocal(query);
  return HS_CODE_PATTERN.test(query) ||
    /\b(hs\s*code|hscode|ma\s+hs|ma\s+hscode|tariff\s+code|customs\s+code|classification|classified|classify|phan\s+loai|thuoc\s+ma|ma\s+nao|code\s+nao|which\s+code|belong\s+to\s+which\s+hs\s+code)\b/.test(normalized) ||
    /\bcode\s*\??$/.test(normalized);
}

function isDefinitionQuery(query: string): boolean {
  const normalized = normalizeForLocal(query);
  return /\b(define|definition|what\s+is|what\s+are|meaning|means|refers\s+to|la\s+gi|dinh\s+nghia|duoc\s+dinh\s+nghia)\b/.test(normalized);
}

function meaningfulLocalTokens(value: string): string[] {
  return uniqueStrings(normalizeForLocal(value)
    .split(/[^a-z0-9.]+/g)
    .map(normalizeLocalToken)
    .filter((token) => token.length >= 3)
    .filter((token) => !LOCAL_STOPWORDS.has(token)));
}

function normalizeLocalToken(token: string): string {
  if (token === "higher" || token === "highest") return "high";
  if (token === "lower" || token === "lowest") return "low";
  if (token === "larger" || token === "largest") return "large";
  if (token === "longer" || token === "longest") return "long";
  if (token === "rounder") return "round";
  if (token === "coarser") return "coarse";
  if (token === "smoother") return "smooth";
  if (token === "dried" || token === "drier") return "dry";
  return token;
}

function isDistinctiveToken(token: string): boolean {
  return token.length >= 5 || /\d/.test(token);
}

function normalizeForLocal(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[Ä‘Ä]/g, "d")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function titleFromSection(value: string | undefined): string | undefined {
  return value?.replace(HS_CODE_PATTERN, "").replace(/^[\s—–-]+/, "").trim() || undefined;
}

function textWithoutDuplicateHsCode(value: string): string {
  return value.replace(/(?:^|\s)HS Code:\s*\d{4}\.\d{2}\.\d{2}\.?/gi, " ").replace(/\s+/g, " ").trim();
}

function ensureSentence(value: string): string {
  const trimmed = value.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function hasMeaningfulLetters(value: string): boolean {
  return /[a-zA-Z]{3,}/.test(value) && !/^[\W\d_]+$/.test(value);
}

function nullAnswer(answerGeneration: LocalAnswerResult["answerGeneration"], reason: string): LocalAnswerResult {
  return {
    answer: null,
    answerGeneration,
    confidence: "low",
    reason
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
