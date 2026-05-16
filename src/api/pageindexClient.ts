import { readFile } from "node:fs/promises";
import path from "node:path";
import { Blob } from "node:buffer";

export type PageIndexJson = Record<string, unknown>;

export interface PageIndexClientOptions {
  baseUrl?: string;
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
