import { GoogleGenAI, type GenerateContentConfig } from "@google/genai";
import { resolveGeminiApiKeys } from "../config/gemini";

export interface GeminiRoundRobinOptions {
  apiKeys?: string[];
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
  generator?: GeminiTextGenerator;
}

export interface GeminiSynthesisOptions {
  language?: string;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface SelectedSectionAnswerContext {
  document?: string;
  section?: string;
  title?: string;
  hsCode?: string;
  source?: string;
  text: string;
  context?: string;
}

export interface GeminiQueryPlannerOptions {
  temperature?: number;
  maxOutputTokens?: number;
}

export interface GeminiTextGenerator {
  generateText(options: {
    apiKey: string;
    model: string;
    prompt: string;
    config: GenerateContentConfig;
  }): Promise<string>;
}

export class GoogleGenAITextGenerator implements GeminiTextGenerator {
  public async generateText(options: {
    apiKey: string;
    model: string;
    prompt: string;
    config: GenerateContentConfig;
  }): Promise<string> {
    const ai = new GoogleGenAI({ apiKey: options.apiKey });
    const response = await ai.models.generateContent({
      model: options.model,
      contents: options.prompt,
      config: options.config
    });

    return (response.text ?? "").trim();
  }
}

export class GeminiRoundRobinClient {
  private readonly apiKeys: string[];
  private readonly model: string;
  private readonly temperature: number;
  private readonly maxOutputTokens: number;
  private readonly generator: GeminiTextGenerator;
  private currentIndex = 0;

  public constructor(options: GeminiRoundRobinOptions = {}) {
    this.apiKeys = dedupeApiKeys(options.apiKeys ?? resolveGeminiApiKeys());

    if (this.apiKeys.length === 0) {
      throw new Error("No Gemini API keys found. Set GEMINI_KEY_1..3 or GEMINI_API_KEY.");
    }

    this.model = options.model ?? "gemini-2.5-flash";
    this.temperature = options.temperature ?? 0.2;
    this.maxOutputTokens = options.maxOutputTokens ?? 512;
    this.generator = options.generator ?? new GoogleGenAITextGenerator();
  }

  public get keyCount(): number {
    return this.apiKeys.length;
  }

  public async synthesizeAnswer(context: string, query: string, options: GeminiSynthesisOptions = {}): Promise<string> {
    const prompt = buildHsCodePrompt(context, query, options.language ?? "Vietnamese");
    const config: GenerateContentConfig = {
      temperature: options.temperature ?? this.temperature,
      maxOutputTokens: options.maxOutputTokens ?? this.maxOutputTokens
    };
    return await this.generateWithFailover(prompt, config);
  }

  public async synthesizeSectionAnswer(
    section: SelectedSectionAnswerContext,
    query: string,
    options: GeminiSynthesisOptions = {}
  ): Promise<string> {
    const prompt = buildSelectedSectionAnswerPrompt(section, query);
    const config: GenerateContentConfig = {
      temperature: options.temperature ?? this.temperature,
      maxOutputTokens: options.maxOutputTokens ?? this.maxOutputTokens
    };
    return await this.generateWithFailover(prompt, config);
  }

  public async planQuery(prompt: string, options: GeminiQueryPlannerOptions = {}): Promise<string> {
    const config: GenerateContentConfig = {
      temperature: options.temperature ?? 0,
      maxOutputTokens: options.maxOutputTokens ?? 384,
      responseMimeType: "application/json"
    };
    return await this.generateWithFailover(prompt, config);
  }

  private async generateWithFailover(prompt: string, config: GenerateContentConfig): Promise<string> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.apiKeys.length; attempt += 1) {
      const { apiKey, slot } = this.getNextKey();

      try {
        const answer = await this.generator.generateText({
          apiKey,
          model: this.model,
          prompt,
          config
        });
        if (!answer) {
          throw new Error("Gemini returned an empty answer.");
        }
        return answer;
      } catch (error) {
        lastError = error;
        if (!isRetryableGeminiError(error)) {
          throw error;
        }

        console.warn(`[Round-Robin] Gemini key slot ${slot} failed; trying next enabled key.`);
      }
    }

    throw new Error(`All configured Gemini key slots failed. Last error: ${formatError(lastError)}`);
  }

  private getNextKey(): { apiKey: string; slot: number } {
    const slot = this.currentIndex + 1;
    const apiKey = this.apiKeys[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.apiKeys.length;
    return { apiKey, slot };
  }
}

export function buildHsCodePrompt(context: string, query: string, language: string): string {
  return [
    "You are answering HSCode questions using retrieved sections.",
    "You are a customs HSCode expert. Identify the HS code for the actual product described by the user.",
    "Use only the provided context and provided metadata. Do not invent HS Codes that are not supported by the context.",
    "CORE RULE - CONTRAST TERM TRAP: if the question contains comparative or contrast expressions such as 'hơn X', 'so với X', 'khác với X', 'thay vì X', 'không phải X', 'less/more than X', 'compared to X', 'rather than X', or 'instead of X', then X is often a comparison baseline, not the target product.",
    "Do not select the HS code of X only because X appears in the query. Prefer sections matching product attributes, numeric ranges, physical traits, and usage/function. Reject candidates that only match the contrast term or conflict with described attributes.",
    "If hsCode is present in retrieved metadata, the final answer MUST include exactly: HS Code: <hsCode>.",
    "The citation MUST include document, page/page range, and section.",
    "Do not omit HS Code when available. If metadata and text conflict, prefer metadata for hsCode, title, and citation.",
    `Answer in ${language} unless the user explicitly asks for another language.`,
    "Return the most relevant HS Code, product/title, and 1-2 short reasons based on the context.",
    "If the context is insufficient, say that the document context is insufficient.",
    "",
    "Context:",
    context,
    "",
    `Question: ${query}`
  ].join("\n");
}

export function buildSelectedSectionAnswerPrompt(section: SelectedSectionAnswerContext, query: string): string {
  return [
    "You are answering a question using only the selected HSCode document section.",
    "Use the selected section text and retrieved context as evidence.",
    "Do not use outside knowledge.",
    "Do not invent information.",
    "If the selected section does not contain the requested information, say so.",
    "Prefer Vietnamese for Vietnamese or mixed-language questions.",
    "Answer the user's actual question directly.",
    "If the user asks about requirements, characteristics, appearance, usage, definition, meaning, or notes, extract that information from the selected section.",
    "Do not output HS Code unless the user explicitly asks for HS Code or classification.",
    "",
    "Selected section metadata:",
    `- document: ${section.document ?? ""}`,
    `- section: ${section.section ?? ""}`,
    `- title: ${section.title ?? ""}`,
    `- hsCode: ${section.hsCode ?? ""}`,
    `- source: ${section.source ?? ""}`,
    "",
    "Selected section text:",
    "---",
    section.text,
    "---",
    ...(section.context
      ? [
          "",
          "Retrieved context:",
          "---",
          section.context,
          "---"
        ]
      : []),
    "",
    "User question:",
    query,
    "",
    "Return a concise answer."
  ].join("\n");
}

export function isRetryableGeminiError(error: unknown): boolean {
  const status = getErrorStatus(error);
  if (
    status === 401 ||
    status === 403 ||
    status === 429 ||
    (typeof status === "number" && status >= 500 && status < 600)
  ) {
    return true;
  }

  const message = formatError(error).toLowerCase();
  return (
    message.includes("api key not valid") ||
    message.includes("invalid api key") ||
    message.includes("unauthorized") ||
    message.includes("permission denied") ||
    message.includes("forbidden") ||
    message.includes("banned") ||
    message.includes("quota") ||
    message.includes("rate limit") ||
    message.includes("too many requests") ||
    message.includes("resource exhausted") ||
    message.includes("temporarily unavailable")
  );
}

function dedupeApiKeys(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];

  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      keys.push(trimmed);
    }
  }

  return keys;
}

function getErrorStatus(error: unknown): number | undefined {
  const candidate = error as { status?: unknown; response?: { status?: unknown }; code?: unknown };
  if (typeof candidate.status === "number") {
    return candidate.status;
  }

  if (typeof candidate.response?.status === "number") {
    return candidate.response.status;
  }

  if (typeof candidate.code === "number") {
    return candidate.code;
  }

  return undefined;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
