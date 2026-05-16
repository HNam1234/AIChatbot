import { readFile } from "node:fs/promises";
import path from "node:path";
import { Blob } from "node:buffer";

export type PageIndexJson = Record<string, unknown>;

export interface PageIndexClientOptions {
  baseUrl?: string;
}

export type PageIndexChatRole = "system" | "user" | "assistant";

export interface PageIndexChatMessage {
  role: PageIndexChatRole;
  content: string;
}

export interface PageIndexChatOptions {
  messages: PageIndexChatMessage[];
  docId?: string | string[];
  temperature?: number;
  enableCitations?: boolean;
}

export interface PageIndexChatResult {
  answer: string;
  rawResponse: PageIndexJson;
}

export class PageIndexClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  public constructor(apiKey: string, options: PageIndexClientOptions = {}) {
    if (!apiKey.trim()) {
      throw new Error("PAGEINDEX_API_KEY is required.");
    }

    this.apiKey = apiKey;
    this.baseUrl = options.baseUrl ?? "https://api.pageindex.ai";
  }

  public async uploadMarkdown(markdownPath: string): Promise<PageIndexJson> {
    const body = new FormData();
    const fileBuffer = await readFile(markdownPath);
    const fileBlob = new Blob([fileBuffer], { type: "text/markdown" });

    body.append("file", fileBlob, path.basename(markdownPath));
    body.append("if_add_node_id", "yes");
    body.append("if_add_node_summary", "yes");
    body.append("if_add_node_text", "yes");

    return await this.requestJson(new URL("/markdown/", this.baseUrl), {
      method: "POST",
      headers: { api_key: this.apiKey },
      body
    });
  }

  public async getTreeStatus(docId: string): Promise<PageIndexJson> {
    const url = new URL(`/doc/${encodeURIComponent(docId)}/`, this.baseUrl);
    url.searchParams.set("type", "tree");
    url.searchParams.set("summary", "true");

    return await this.requestJson(url, {
      method: "GET",
      headers: { api_key: this.apiKey }
    });
  }

  public async chatCompletion(options: PageIndexChatOptions): Promise<PageIndexChatResult> {
    if (options.messages.length === 0) {
      throw new Error("[PageIndex Chat] At least one message is required.");
    }

    const payload: Record<string, unknown> = {
      messages: options.messages,
      stream: false,
      temperature: options.temperature ?? 0.1,
      enable_citations: options.enableCitations ?? true
    };

    if (options.docId) {
      payload.doc_id = options.docId;
    }

    const rawResponse = await this.requestJson(new URL("/chat/completions", this.baseUrl), {
      method: "POST",
      headers: {
        api_key: this.apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    return {
      answer: extractChatAnswer(rawResponse),
      rawResponse
    };
  }

  private async requestJson(url: URL, init: RequestInit): Promise<PageIndexJson> {
    const response = await fetch(url, init);
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`[PageIndex] HTTP ${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
    }

    try {
      return JSON.parse(text) as PageIndexJson;
    } catch (error) {
      throw new Error(`[PageIndex] Response is not valid JSON: ${text.slice(0, 500)}`);
    }
  }
}

function extractChatAnswer(payload: PageIndexJson): string {
  const choices = payload.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as { message?: { content?: unknown }; text?: unknown };
    const content = first.message?.content ?? first.text;
    if (typeof content === "string") {
      return content.trim();
    }
  }

  const directChoice = choices as { message?: { content?: unknown } } | undefined;
  if (typeof directChoice?.message?.content === "string") {
    return directChoice.message.content.trim();
  }

  if (typeof payload.content === "string") {
    return payload.content.trim();
  }

  throw new Error("[PageIndex Chat] Response does not contain choices[0].message.content.");
}
