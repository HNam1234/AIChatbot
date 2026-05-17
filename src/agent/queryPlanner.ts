import { resolveGeminiApiKeys } from "../config/gemini";
import { GeminiRoundRobinClient } from "./geminiClient";
import { HS_CODE_PATTERN } from "./qaAnswerFormatter";
import { FIELD_SYNONYM_GROUPS, canonicalRequestedFieldFromText, normalizeFieldText } from "./fieldExtractor";

export type QueryIntent =
  | "exact_hscode_lookup"
  | "product_classification"
  | "definition"
  | "chapter_summary"
  | "document_summary"
  | "selected_section_qa"
  | "section_attribute_question"
  | "comparison"
  | "clarification_needed";

export type QueryLanguage = "vi" | "en" | "mixed" | "unknown";
export type QueryPlanConfidence = "high" | "medium" | "low";
export type PlannerSource = "rule" | "llm" | "fallback";

export interface QueryPlan {
  intent: QueryIntent;
  target: string | null;
  requestedField: string | null;
  needsHsCode: boolean;
  language: QueryLanguage;
  confidence: QueryPlanConfidence;
  reason: string;
}

export interface QueryPlanningResult {
  queryPlan: QueryPlan;
  plannerSource: PlannerSource;
  rawPlannerOutput?: string;
  plannerError?: string;
}

export interface QueryPlannerOptions {
  geminiApiKeys?: string[];
  useLlm?: boolean;
  llmPlanner?: {
    planQuery(prompt: string): Promise<string>;
  };
}

const VALID_INTENTS: QueryIntent[] = [
  "exact_hscode_lookup",
  "product_classification",
  "definition",
  "chapter_summary",
  "document_summary",
  "selected_section_qa",
  "section_attribute_question",
  "comparison",
  "clarification_needed"
];

const VALID_LANGUAGES: QueryLanguage[] = ["vi", "en", "mixed", "unknown"];
const VALID_CONFIDENCE: QueryPlanConfidence[] = ["high", "medium", "low"];

export async function planQuery(query: string, options: QueryPlannerOptions = {}): Promise<QueryPlanningResult> {
  const rulePlan = planQueryWithRules(query);
  if (rulePlan) {
    return { queryPlan: rulePlan, plannerSource: "rule" };
  }

  if (options.useLlm !== false) {
    try {
      const llmOutput = await runLlmPlanner(query, options);
      if (llmOutput) {
        const queryPlan = parseAndValidateQueryPlan(llmOutput, query);
        return { queryPlan, plannerSource: "llm", rawPlannerOutput: llmOutput };
      }
    } catch (error) {
      return {
        queryPlan: planQueryWithFallback(query, error instanceof Error ? error.message : String(error)),
        plannerSource: "fallback",
        plannerError: error instanceof Error ? error.message : String(error)
      };
    }
  }

  return { queryPlan: planQueryWithFallback(query), plannerSource: "fallback" };
}

export function planQueryWithRules(query: string): QueryPlan | null {
  const trimmed = query.trim();
  const normalized = normalizeForPlanner(trimmed);
  const language = detectQueryLanguage(trimmed);
  const exactHsCode = trimmed.match(HS_CODE_PATTERN)?.[0];
  if (exactHsCode) {
    return {
      intent: "exact_hscode_lookup",
      target: exactHsCode,
      requestedField: null,
      needsHsCode: true,
      language,
      confidence: "high",
      reason: "query contains an exact HS code"
    };
  }

  const chapterNumber = hasChapterMarker(normalized) && hasSummaryVerb(normalized)
    ? extractChapterNumber(normalized)
    : null;
  if (chapterNumber !== null) {
    return {
      intent: "chapter_summary",
      target: `chapter ${chapterNumber}`,
      requestedField: null,
      needsHsCode: false,
      language,
      confidence: "high",
      reason: "query asks for chapter contents"
    };
  }

  const documentName = extractDocumentSummaryName(trimmed, normalized);
  if (documentName) {
    return {
      intent: "document_summary",
      target: documentName,
      requestedField: null,
      needsHsCode: false,
      language,
      confidence: "high",
      reason: "query asks for a document summary"
    };
  }

  return null;
}

export function planQueryWithFallback(query: string, fallbackReason?: string): QueryPlan {
  const trimmed = query.trim();
  const normalized = normalizeForPlanner(trimmed);
  const language = detectQueryLanguage(trimmed);

  if (!trimmed) {
    return clarificationPlan(null, language, "empty query");
  }

  if (hasHsCodeQuestion(normalized)) {
    const target = extractHsCodeQuestionTarget(trimmed);
    return {
      intent: "product_classification",
      target: target || null,
      requestedField: null,
      needsHsCode: true,
      language,
      confidence: target ? "high" : "low",
      reason: fallbackReason ? `fallback after planner error: ${fallbackReason}` : "query asks for an HS code classification"
    };
  }

  if (/^\d+(?:[.,]\d+)?%?$/.test(trimmed)) {
    return clarificationPlan(trimmed, language, fallbackReason
      ? `fallback after planner error: ${fallbackReason}; numeric-only query is not enough for classification`
      : "numeric-only query is not enough for classification");
  }

  const tokens = meaningfulPlannerTokens(trimmed);
  return {
    intent: "selected_section_qa",
    target: cleanTarget(trimmed) || null,
    requestedField: null,
    needsHsCode: hasHsCodeQuestion(normalized),
    language,
    confidence: tokens.length >= 2 ? "medium" : "low",
    reason: fallbackReason
      ? `fallback after planner error: ${fallbackReason}; use selected-section QA flow`
      : "fallback uses selected-section QA flow"
  };
}

export function buildQueryPlannerPrompt(query: string): string {
  return [
    "You are a query planner for an HSCode document QA system.",
    "Classify the user's question into a structured JSON plan.",
    "Do not answer the question.",
    "Do not invent HS codes.",
    "Return only JSON.",
    "",
    "Valid intents:",
    "- exact_hscode_lookup",
    "- product_classification",
    "- definition",
    "- chapter_summary",
    "- document_summary",
    "- selected_section_qa",
    "- section_attribute_question",
    "- comparison",
    "- clarification_needed",
    "",
    "Intent meanings:",
    "- exact_hscode_lookup: user provides an exact HS code and asks about it.",
    "- product_classification: user asks for the HS code/classification of a product, item, or product description.",
    "- definition: user asks what a term, product, or phrase means.",
    "- selected_section_qa: general question answered from the best retrieved section.",
    "- section_attribute_question: user asks for a requirement, characteristic, appearance, condition, usage, activity, size, weight, note, or another field from the relevant section.",
    "- chapter_summary: user asks about the contents of a chapter.",
    "- document_summary: user asks about the contents of a document/file.",
    "- comparison: user asks to compare or distinguish terms/products/sections.",
    "- clarification_needed: the question is too short, ambiguous, missing a target, or missing a requested field.",
    "",
    "Return exactly this JSON shape:",
    "{",
    '  "intent": "...",',
    '  "target": "...",',
    '  "requestedField": "...",',
    '  "needsHsCode": true,',
    '  "language": "...",',
    '  "confidence": "...",',
    '  "reason": "..."',
    "}",
    "",
    "Rules:",
    "- If the user asks for an HS code, set needsHsCode=true.",
    "- If the user asks for a field/requirement/attribute only, set needsHsCode=false unless they also ask for HS code.",
    "- If the target is unclear, set target=null.",
    "- If the requested field is unclear, set requestedField=null.",
    "- If confidence is low, use clarification_needed.",
    "- Do not include any explanation outside JSON.",
    "",
    `Question: ${query}`
  ].join("\n");
}

export function parseAndValidateQueryPlan(rawJson: string, query: string): QueryPlan {
  const raw = JSON.parse(extractJsonObject(rawJson)) as Record<string, unknown>;
  const language = isValidLanguage(raw.language) ? raw.language : detectQueryLanguage(query);
  const intent = isValidIntent(raw.intent) ? raw.intent : "clarification_needed";
  const requestedField = typeof raw.requestedField === "string" && raw.requestedField.trim()
    ? canonicalRequestedFieldFromText(raw.requestedField) ?? raw.requestedField.trim()
    : null;
  const target = typeof raw.target === "string" && raw.target.trim()
    ? raw.target.trim()
    : null;
  const confidence = isValidConfidence(raw.confidence) ? raw.confidence : "low";
  const reason = typeof raw.reason === "string" && raw.reason.trim()
    ? raw.reason.trim().slice(0, 240)
    : "LLM returned a structured plan";
  const needsHsCode = typeof raw.needsHsCode === "boolean"
    ? raw.needsHsCode
    : intent === "exact_hscode_lookup" || intent === "product_classification";

  return {
    intent,
    target,
    requestedField,
    needsHsCode,
    language,
    confidence,
    reason
  };
}

export function queryPlanToDebug(plan: QueryPlan): Record<string, unknown> {
  return {
    intent: plan.intent,
    target: plan.target,
    requestedField: plan.requestedField,
    needsHsCode: plan.needsHsCode,
    language: plan.language,
    confidence: plan.confidence,
    reason: plan.reason
  };
}

function clarificationPlan(target: string | null, language: QueryLanguage, reason: string): QueryPlan {
  return {
    intent: "clarification_needed",
    target,
    requestedField: null,
    needsHsCode: false,
    language,
    confidence: "low",
    reason
  };
}

async function runLlmPlanner(query: string, options: QueryPlannerOptions): Promise<string | null> {
  if (options.llmPlanner) {
    return await options.llmPlanner.planQuery(buildQueryPlannerPrompt(query));
  }

  const apiKeys = plannerApiKeys(options);
  if (apiKeys.length === 0) {
    return null;
  }

  const client = new GeminiRoundRobinClient({ apiKeys });
  return await client.planQuery(buildQueryPlannerPrompt(query), { temperature: 0, maxOutputTokens: 384 });
}

function plannerApiKeys(options: QueryPlannerOptions): string[] {
  if (options.geminiApiKeys !== undefined) {
    return uniqueStrings(options.geminiApiKeys.map((key) => key.trim()).filter(Boolean));
  }
  try {
    return resolveGeminiApiKeys();
  } catch {
    return [];
  }
}

function extractJsonObject(raw: string): string {
  const withoutFence = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Planner did not return a JSON object.");
  }
  return withoutFence.slice(start, end + 1);
}

function isValidIntent(value: unknown): value is QueryIntent {
  return typeof value === "string" && VALID_INTENTS.includes(value as QueryIntent);
}

function isValidLanguage(value: unknown): value is QueryLanguage {
  return typeof value === "string" && VALID_LANGUAGES.includes(value as QueryLanguage);
}

function isValidConfidence(value: unknown): value is QueryPlanConfidence {
  return typeof value === "string" && VALID_CONFIDENCE.includes(value as QueryPlanConfidence);
}

function detectQueryLanguage(query: string): QueryLanguage {
  const normalized = normalizeForPlanner(query);
  if (!normalized) return "unknown";
  const hasVietnameseMarkers = /[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i.test(query) ||
    /\b(la|gi|can|phai|yeu|cau|ngoai|quan|nhin|trong|nhu|nao|chuong|tom|tat|noi|dung|cong|dung|dac|diem)\b/.test(normalized);
  const hasEnglishMarkers = /\b(what|which|how|definition|define|chapter|document|requirements?|appearance|activeness|usage|compare|difference)\b/.test(normalized);
  if (hasVietnameseMarkers && hasEnglishMarkers) {
    return "mixed";
  }
  if (hasVietnameseMarkers) return "vi";
  if (/[a-z]/i.test(query)) return "en";
  return "unknown";
}

function hasChapterMarker(normalizedQuery: string): boolean {
  return /\b(?:chuong|chapter)\s+\d{1,3}\b/.test(normalizedQuery) ||
    /\bchapter[\s_-]*\d{1,3}\b/.test(normalizedQuery);
}

function extractChapterNumber(normalizedQuery: string): number | null {
  const match = normalizedQuery.match(/\b(?:chuong|chapter)\s+(\d{1,3})\b/) ??
    normalizedQuery.match(/\bchapter[\s_-]*(\d{1,3})\b/);
  return match ? Number(match[1]) : null;
}

function hasSummaryVerb(normalizedQuery: string): boolean {
  return /\b(summary|summarize|about|contents?|cover|tom\s+tat|noi\s+dung|noi\s+ve|co\s+gi|gom|liet\s+ke)\b/.test(normalizedQuery);
}

function extractDocumentSummaryName(query: string, normalized: string): string | null {
  if (!/\b(document|file)\b/.test(normalized) || !hasSummaryVerb(normalized)) {
    return null;
  }
  const marker = normalized.match(/\b(document|file)\b/);
  if (!marker || marker.index === undefined) {
    return null;
  }
  const afterMarker = query.slice(marker.index + marker[0].length).trim();
  const beforeMarker = query.slice(0, marker.index).trim();
  const rawName = stripSummarySignals(afterMarker) || stripSummarySignals(beforeMarker);
  return cleanTarget(rawName).replace(/[?.!]+$/g, "") || null;
}

function extractDefinitionTerm(query: string, normalized: string): string | null {
  const definitionPrefix = normalized.match(/^define\s+(.+)$/);
  if (definitionPrefix?.[1]) {
    return cleanTarget(query.slice(normalized.indexOf(definitionPrefix[1])).trim().replace(/[?.!]+$/g, "")) || null;
  }

  const viSuffix = normalized.match(/^(.+?)\s+la\s+gi\??$/);
  if (viSuffix?.[1]) {
    return cleanTarget(query.slice(normalized.indexOf(viSuffix[1])).trim().replace(/[?.!]+$/g, "")) || null;
  }

  const englishQuestion = normalized.match(/^what\s+is\s+(.+?)\??$/);
  if (englishQuestion?.[1]) {
    return cleanTarget(query.slice(normalized.indexOf(englishQuestion[1])).trim().replace(/[?.!]+$/g, "")) || null;
  }
  return null;
}

function hasHsCodeQuestion(normalized: string): boolean {
  return /\b(hs\s*code|hscode|ma\s+hs|ma\s+hscode|tariff\s+code|customs\s+code|classified?|classification|phan\s+loai|thuoc\s+ma)\b/.test(normalized);
}

function extractHsCodeQuestionTarget(query: string): string {
  return cleanTarget(query
    .replace(/\b(?:HS\s*Code|HSCode|tariff\s+code|customs\s+code|classification|classified|classify)\b/gi, " ")
    .replace(/\b(?:mã\s*HS|ma\s*HS|phân\s+loại|phan\s+loai|thuộc\s+mã|thuoc\s+ma)\b/gi, " ")
    .replace(/\b(?:what|which|is|are|for|of|the|là|la|gì|gi|nào|nao|là\s+gì|la\s+gi)\b/gi, " "));
}

function extractFieldQuestionTarget(query: string, requestedField: string): string {
  const fieldTerms = [
    requestedField,
    ...requestedField.split(/\s+/g),
    ...FIELD_SYNONYM_GROUPS.flatMap((group) => group.labels)
  ];
  let target = query;
  for (const term of fieldTerms) {
    const normalizedTerm = normalizeFieldText(term);
    if (!normalizedTerm) continue;
    target = target.replace(new RegExp(`\\b${escapeRegExp(term)}\\b`, "gi"), " ");
    target = target.replace(new RegExp(`\\b${escapeRegExp(normalizedTerm)}\\b`, "gi"), " ");
  }
  return cleanTarget(target.replace(/\b(?:can|cần|phai|phải|dap\s+ung|đáp\s+ứng|yeu\s+cau|yêu\s+cầu|nao|nào|gi|gì|nhu\s+nao|như\s+nào)\b/gi, " "));
}

function stripSummarySignals(value: string): string {
  return value
    .replace(/\b(summary|summarize|about|contents?|cover|tom\s+tat|noi\s+dung|noi\s+ve|co\s+gi|gom|liet\s+ke)\b/gi, " ")
    .replace(/\b(có\s+gì|nội\s+dung|nói\s+về|tóm\s+tắt|gồm|liệt\s+kê)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanTarget(value: string): string {
  return value
    .replace(/\s*(?:là|la)\s+(?:gì|gi)\s*[?!.]*\s*$/i, " ")
    .replace(/^\s*what\s+is\s+/i, " ")
    .replace(/[?!.:,;]+/g, " ")
    .replace(/\b(?:product|item|goods|sản phẩm|san pham|hàng hóa|hang hoa|con|cái|cai|the|a|an)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function meaningfulPlannerTokens(value: string): string[] {
  const stopwords = new Set([
    "the",
    "and",
    "for",
    "with",
    "what",
    "which",
    "how",
    "does",
    "code",
    "hs",
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
    "khong",
    "phai",
    "can",
    "yeu",
    "cau",
    "dap",
    "ung",
    "la",
    "gi",
    "is",
    "are",
    "chapter",
    "chuong",
    "document",
    "file"
  ]);
  return uniqueStrings(normalizeForPlanner(value)
    .split(/[^a-z0-9.]+/g)
    .filter((token) => token.length >= 2)
    .filter((token) => !stopwords.has(token)));
}

function looksLikeDescriptiveProductQuery(value: string): boolean {
  const tokens = meaningfulPlannerTokens(cleanTarget(value));
  return tokens.length >= 4;
}

function normalizeForPlanner(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
