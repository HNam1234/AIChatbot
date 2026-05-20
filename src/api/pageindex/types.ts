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
