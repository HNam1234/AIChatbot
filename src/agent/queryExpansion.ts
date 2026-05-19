import { loadEnvConfig, type QueryExpansionProviderName } from "../config/env";
import { BifrostClient } from "./bifrostClient";
import { GeminiRoundRobinClient } from "./geminiClient";

export type QueryExpansionSource = "none" | "llm" | "translation" | "semantic" | "fallback";
export type QueryExpansionConfidence = "high" | "medium" | "low";

export type QueryExpansionResult = {
  originalQuery: string;
  expandedQuery: string;
  expansionTerms: string[];
  expansionSource: QueryExpansionSource;
  confidence: QueryExpansionConfidence;
  error?: string;
};

export type QueryExpansionDebug = Omit<QueryExpansionResult, "error"> & {
  error: string | null;
  cacheHit: boolean;
};

export interface QueryExpansionProviderOutput {
  englishQuery?: string;
  keywords?: string[];
  phrases?: string[];
  confidence?: QueryExpansionConfidence;
}

export interface QueryExpansionProvider {
  name: QueryExpansionProviderName;
  source: "llm" | "translation";
  model: string;
  expand(query: string, prompt: string, options: { timeoutMs: number }): Promise<QueryExpansionProviderOutput>;
}

export interface QueryExpansionRuntimeConfig {
  enabled: boolean;
  provider: QueryExpansionProviderName;
  maxTerms: number;
  timeoutMs: number;
  cacheEnabled: boolean;
}

export interface QueryExpansionOptions {
  config?: Partial<QueryExpansionRuntimeConfig>;
  provider?: QueryExpansionProvider;
}

const DEFAULT_GEMINI_QUERY_EXPANSION_MODEL = "gemini-2.5-flash";
const expansionCache = new Map<string, QueryExpansionResult>();

export async function expandQueryForRetrieval(query: string): Promise<QueryExpansionResult> {
  return (await expandQueryForRetrievalWithDebug(query)).result;
}

export async function expandQueryForRetrievalWithDebug(
  query: string,
  options: QueryExpansionOptions = {}
): Promise<{ result: QueryExpansionResult; debug: QueryExpansionDebug }> {
  const runtimeConfig = resolveRuntimeConfig(options.config);
  if (!runtimeConfig.enabled || runtimeConfig.provider === "none") {
    const result = originalOnlyResult(query, "none");
    return { result, debug: queryExpansionDebug(result, false) };
  }

  const provider = options.provider ?? createDefaultProvider(runtimeConfig.provider);
  if (!provider) {
    const result = originalOnlyResult(query, "fallback", `Query expansion provider '${runtimeConfig.provider}' is not configured.`);
    return { result, debug: queryExpansionDebug(result, false) };
  }

  const cacheKey = buildCacheKey(query, provider.name, provider.model);
  if (runtimeConfig.cacheEnabled) {
    const cached = expansionCache.get(cacheKey);
    if (cached) {
      const result = resultForOriginalQuery(query, cached);
      return { result, debug: queryExpansionDebug(result, true) };
    }
  }

  try {
    const prompt = buildQueryExpansionPrompt(query);
    const output = await withTimeout(
      provider.expand(query, prompt, { timeoutMs: runtimeConfig.timeoutMs }),
      runtimeConfig.timeoutMs
    );
    const result = expansionResultFromProviderOutput(query, output, provider.source, runtimeConfig.maxTerms);
    if (runtimeConfig.cacheEnabled) {
      expansionCache.set(cacheKey, result);
    }
    return { result, debug: queryExpansionDebug(result, false) };
  } catch (error) {
    const result = originalOnlyResult(query, "fallback", error instanceof Error ? error.message : String(error));
    return { result, debug: queryExpansionDebug(result, false) };
  }
}

export function buildQueryExpansionPrompt(query: string): string {
  return [
    "You are a retrieval query expansion module for an HSCode document search system.",
    "The source documents are mostly in English.",
    "Given a user query that may be Vietnamese, English, or mixed, produce English retrieval keywords and short phrases that preserve the same meaning.",
    "",
    "Do not answer the question.",
    "Do not choose an HS Code.",
    "Do not choose a product.",
    "Do not add facts not implied by the query.",
    "Return only JSON.",
    "",
    "JSON shape:",
    "{",
    '  "englishQuery": "...",',
    '  "keywords": ["..."],',
    '  "phrases": ["..."],',
    '  "confidence": "high|medium|low"',
    "}",
    "",
    "Rules:",
    "- Keep terms short and useful for retrieval.",
    "- Preserve product names, numbers, units, scientific names, and technical terms.",
    "- Include action/attribute/usage words if present in the user query.",
    "- If query is too short or ambiguous, return low confidence and minimal terms.",
    "- Do not include explanations outside JSON.",
    "",
    "User query:",
    query
  ].join("\n");
}

export function parseQueryExpansionJson(rawJson: string): QueryExpansionProviderOutput {
  const parsed = JSON.parse(stripJsonFence(rawJson)) as Record<string, unknown>;
  return {
    englishQuery: stringValue(parsed.englishQuery),
    keywords: stringArrayValue(parsed.keywords),
    phrases: stringArrayValue(parsed.phrases),
    confidence: isExpansionConfidence(parsed.confidence) ? parsed.confidence : "low"
  };
}

export function clearQueryExpansionCache(): void {
  expansionCache.clear();
}

function resolveRuntimeConfig(overrides: Partial<QueryExpansionRuntimeConfig> | undefined): QueryExpansionRuntimeConfig {
  const env = loadEnvConfig();
  return {
    enabled: overrides?.enabled ?? env.enableLlmQueryExpansion,
    provider: overrides?.provider ?? env.queryExpansionProvider,
    maxTerms: positiveInteger(overrides?.maxTerms, env.queryExpansionMaxTerms),
    timeoutMs: positiveInteger(overrides?.timeoutMs, env.queryExpansionTimeoutMs),
    cacheEnabled: overrides?.cacheEnabled ?? env.queryExpansionCacheEnabled
  };
}

function createDefaultProvider(provider: QueryExpansionProviderName): QueryExpansionProvider | null {
  if (provider === "gemini") {
    return new GeminiQueryExpansionProvider(DEFAULT_GEMINI_QUERY_EXPANSION_MODEL);
  }
  if (provider === "openai") {
    return new BifrostQueryExpansionProvider(loadEnvConfig().bifrostModel);
  }
  return null;
}

class GeminiQueryExpansionProvider implements QueryExpansionProvider {
  public readonly name = "gemini";
  public readonly source = "llm";

  public constructor(public readonly model: string) {}

  public async expand(_query: string, prompt: string, _options: { timeoutMs: number }): Promise<QueryExpansionProviderOutput> {
    const client = new GeminiRoundRobinClient({
      model: this.model,
      temperature: 0,
      maxOutputTokens: 512
    });
    const raw = await client.planQuery(prompt, { temperature: 0, maxOutputTokens: 512 });
    return parseQueryExpansionJson(raw);
  }
}

class BifrostQueryExpansionProvider implements QueryExpansionProvider {
  public readonly name = "openai";
  public readonly source = "llm";

  public constructor(public readonly model: string) {}

  public async expand(_query: string, prompt: string, _options: { timeoutMs: number }): Promise<QueryExpansionProviderOutput> {
    const env = loadEnvConfig();
    const client = new BifrostClient({
      apiKey: env.bifrostApiKey ?? "",
      baseUrl: env.bifrostBaseUrl ?? "",
      model: this.model,
      temperature: 0,
      maxOutputTokens: 512
    });
    const raw = await client.planQuery(prompt, { temperature: 0, maxOutputTokens: 512 });
    return parseQueryExpansionJson(raw);
  }
}

function expansionResultFromProviderOutput(
  query: string,
  output: QueryExpansionProviderOutput,
  source: "llm" | "translation",
  maxTerms: number
): QueryExpansionResult {
  const terms = dedupeTerms([
    output.englishQuery,
    ...(output.keywords ?? []),
    ...(output.phrases ?? [])
  ], query).slice(0, maxTerms);
  const expandedQuery = terms.length > 0 ? [query, ...terms].join("\n") : query;
  return {
    originalQuery: query,
    expandedQuery,
    expansionTerms: terms,
    expansionSource: source,
    confidence: output.confidence ?? "low"
  };
}

function originalOnlyResult(query: string, source: "none" | "fallback", error?: string): QueryExpansionResult {
  return {
    originalQuery: query,
    expandedQuery: query,
    expansionTerms: [],
    expansionSource: source,
    confidence: "low",
    ...(error ? { error } : {})
  };
}

function queryExpansionDebug(result: QueryExpansionResult, cacheHit: boolean): QueryExpansionDebug {
  return {
    ...result,
    error: result.error ?? null,
    cacheHit
  };
}

function resultForOriginalQuery(query: string, cached: QueryExpansionResult): QueryExpansionResult {
  return {
    ...cached,
    originalQuery: query,
    expandedQuery: cached.expansionTerms.length > 0 ? [query, ...cached.expansionTerms].join("\n") : query
  };
}

function buildCacheKey(query: string, provider: QueryExpansionProviderName, model: string): string {
  return [
    normalizeCacheQuery(query),
    provider,
    model.trim().toLowerCase()
  ].join("|");
}

function normalizeCacheQuery(query: string): string {
  return query
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeTerms(values: Array<string | undefined>, originalQuery: string): string[] {
  const original = normalizeCacheQuery(originalQuery);
  const seen = new Set<string>([original]);
  const terms: string[] = [];
  for (const value of values) {
    const cleaned = cleanTerm(value);
    const key = normalizeCacheQuery(cleaned);
    if (!cleaned || !key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    terms.push(cleaned);
  }
  return terms;
}

function cleanTerm(value: string | undefined): string {
  return value
    ?.replace(/\s+/g, " ")
    .replace(/^[-*"'`]+|[-*"'`]+$/g, "")
    .trim() ?? "";
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`Query expansion timed out after ${timeoutMs}ms.`)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
}

function stripJsonFence(rawJson: string): string {
  const trimmed = rawJson.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1]?.trim() ?? trimmed;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => stringValue(item)).filter((item): item is string => Boolean(item));
}

function isExpansionConfidence(value: unknown): value is QueryExpansionConfidence {
  return value === "high" || value === "medium" || value === "low";
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}
