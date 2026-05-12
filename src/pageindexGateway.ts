import { readFile } from "node:fs/promises";
import path from "node:path";

import { PageIndexClient } from "@pageindex/sdk";

import type { ChatMessage } from "./guardrails.js";

type PageIndexResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class PageIndexGateway {
  private readonly client: any;

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error("PAGEINDEX_API_KEY is required. Add it to .env or your shell environment.");
    }
    this.client = new PageIndexClient({ apiKey });
  }

  async submitDocument(pdfPath: string): Promise<string> {
    const file = await readFile(pdfPath);
    const result = await this.client.api.submitDocument(file, path.basename(pdfPath));
    const docId = result?.doc_id;
    if (!docId) {
      throw new Error(`PageIndex did not return a doc_id: ${JSON.stringify(result)}`);
    }
    return String(docId);
  }

  async getDocumentStatus(docId: string): Promise<string> {
    const result = await this.client.api.getDocument(docId);
    return String(result?.status ?? "unknown");
  }

  async waitUntilComplete(
    docId: string,
    timeoutSeconds: number,
    pollIntervalSeconds: number
  ): Promise<string> {
    const deadline = Date.now() + timeoutSeconds * 1000;
    let lastStatus = "unknown";

    while (Date.now() < deadline) {
      lastStatus = await this.getDocumentStatus(docId);
      if (lastStatus === "completed") return lastStatus;
      if (lastStatus === "failed") {
        throw new Error(`PageIndex processing failed for ${docId}`);
      }
      await sleep(pollIntervalSeconds * 1000);
    }

    throw new Error(`Timed out waiting for ${docId}; last status was '${lastStatus}'`);
  }

  async getTree(docId: string): Promise<unknown> {
    return this.client.api.getTree(docId);
  }

  async chat(messages: ChatMessage[], docIds: string | string[]): Promise<string> {
    const response = (await this.client.api.chatCompletions({
      messages,
      doc_id: docIds,
      temperature: 0,
      enable_citations: true
    })) as PageIndexResponse;

    return String(response.choices?.[0]?.message?.content ?? "");
  }
}
