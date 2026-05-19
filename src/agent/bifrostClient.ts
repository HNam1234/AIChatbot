import type { LlmClient } from "./llmFactory";
import {
  buildComparisonAnswerPrompt,
  buildHsCodePrompt,
  buildSelectedSectionAnswerPrompt,
  type SelectedSectionAnswerContext
} from "./geminiClient";

export interface BifrostClientOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature?: number;
  maxOutputTokens?: number;
  maxRetries?: number;
  fetcher?: typeof fetch;
}

export interface BifrostSynthesisOptions {
  language?: string;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface BifrostQueryPlannerOptions {
  temperature?: number;
  maxOutputTokens?: number;
}

interface BifrostChatOptions {
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: "json_object" };
}

export class BifrostApiError extends Error {
  public constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "BifrostApiError";
  }
}

export class BifrostClient implements LlmClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly temperature: number;
  private readonly maxOutputTokens: number;
  private readonly maxRetries: number;
  private readonly fetcher: typeof fetch;

  public constructor(options: BifrostClientOptions) {
    const apiKey = options.apiKey.trim();
    const baseUrl = options.baseUrl.trim().replace(/\/+$/g, "");
    const model = options.model.trim();

    if (!apiKey) {
      throw new Error("BIFROST_API_KEY is missing.");
    }
    if (!baseUrl) {
      throw new Error("BIFROST_BASE_URL is missing.");
    }
    if (!model) {
      throw new Error("BIFROST_MODEL is missing.");
    }

    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.model = model;
    this.temperature = options.temperature ?? 0.2;
    this.maxOutputTokens = options.maxOutputTokens ?? 512;
    this.maxRetries = options.maxRetries ?? 2;
    this.fetcher = options.fetcher ?? fetch;
  }

  public async synthesizeAnswer(
    context: string,
    query: string,
    options: BifrostSynthesisOptions = {}
  ): Promise<string> {
    const prompt = buildHsCodePrompt(context, query, options.language ?? "Vietnamese");
    return await this.chat(prompt, {
      temperature: options.temperature ?? this.temperature,
      maxTokens: options.maxOutputTokens ?? this.maxOutputTokens
    });
  }

  public async synthesizeSectionAnswer(
    section: SelectedSectionAnswerContext,
    query: string,
    options: BifrostSynthesisOptions = {}
  ): Promise<string> {
    const prompt = buildSelectedSectionAnswerPrompt(section, query);
    return await this.chat(prompt, {
      temperature: options.temperature ?? this.temperature,
      maxTokens: options.maxOutputTokens ?? this.maxOutputTokens
    });
  }

  public async synthesizeComparisonAnswer(
    sections: SelectedSectionAnswerContext[],
    query: string,
    options: BifrostSynthesisOptions = {}
  ): Promise<string> {
    const prompt = buildComparisonAnswerPrompt(sections, query);
    return await this.chat(prompt, {
      temperature: options.temperature ?? this.temperature,
      maxTokens: options.maxOutputTokens ?? this.maxOutputTokens
    });
  }

  public async planQuery(prompt: string, options: BifrostQueryPlannerOptions = {}): Promise<string> {
    return await this.chat(prompt, {
      temperature: options.temperature ?? 0,
      maxTokens: options.maxOutputTokens ?? 384,
      responseFormat: { type: "json_object" }
    });
  }

  private async chat(prompt: string, options: BifrostChatOptions): Promise<string> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const response = await this.fetcher(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: this.model,
            messages: [{ role: "user", content: prompt }],
            temperature: options.temperature,
            max_tokens: options.maxTokens ?? this.maxOutputTokens,
            ...(options.responseFormat ? { response_format: options.responseFormat } : {})
          })
        });

        const bodyText = await response.text();
        if (!response.ok) {
          throw new BifrostApiError(formatBifrostError(response.status, bodyText), response.status);
        }

        const content = extractOpenAiContent(parseJsonBody(bodyText));
        if (!content) {
          throw new Error("Bifrost returned an empty answer.");
        }
        return content;
      } catch (error) {
        lastError = error;
        if (attempt >= this.maxRetries || !isRetryableBifrostError(error)) {
          throw error;
        }
        await delay(retryDelayMs(attempt));
      }
    }

    throw new Error(`Bifrost request failed. Last error: ${formatUnknownError(lastError)}`);
  }
}

export function isRetryableBifrostError(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status;
  return status === 429 || (typeof status === "number" && status >= 500 && status < 600);
}

function parseJsonBody(bodyText: string): unknown {
  try {
    return JSON.parse(bodyText) as unknown;
  } catch {
    throw new Error("Bifrost returned a non-JSON response.");
  }
}

function extractOpenAiContent(json: unknown): string {
  const choices = (json as { choices?: unknown })?.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return "";
  }

  const firstChoice = choices[0] as { message?: { content?: unknown }; text?: unknown };
  const content = firstChoice.message?.content ?? firstChoice.text;
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const candidate = part as { text?: unknown; type?: unknown };
        return typeof candidate.text === "string" ? candidate.text : "";
      })
      .join("")
      .trim();
  }

  return "";
}

function formatBifrostError(status: number, bodyText: string): string {
  const trimmed = bodyText.trim();
  if (!trimmed) {
    return `Bifrost request failed with HTTP ${status}.`;
  }

  try {
    const parsed = JSON.parse(trimmed) as { error?: { message?: unknown }; message?: unknown };
    const message = parsed.error?.message ?? parsed.message;
    if (typeof message === "string" && message.trim()) {
      return `Bifrost request failed with HTTP ${status}: ${message.trim()}`;
    }
  } catch {
    // Use the text body below.
  }

  return `Bifrost request failed with HTTP ${status}: ${trimmed.slice(0, 500)}`;
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function retryDelayMs(attempt: number): number {
  return 250 * 2 ** attempt;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
