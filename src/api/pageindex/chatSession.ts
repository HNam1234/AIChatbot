import { PageIndexClient } from "./client";
import type { PageIndexChatMessage } from "./types";

export interface ChatSessionOptions {
  client: PageIndexClient;
  docId?: string | string[];
  temperature?: number;
  enableCitations?: boolean;
  systemPrompt?: string;
}

export interface ChatSessionTurn {
  question: string;
  answer: string;
  messages: PageIndexChatMessage[];
}

/**
 * Stateful convenience wrapper around PageIndex chat completions.
 *
 * The raw HTTP client stays stateless; this class owns message history for REPL
 * and other interactive flows.
 */
export class ChatSession {
  private readonly client: PageIndexClient;
  private readonly docId?: string | string[];
  private readonly temperature: number;
  private readonly enableCitations: boolean;
  private readonly messages: PageIndexChatMessage[] = [];

  public constructor(options: ChatSessionOptions) {
    this.client = options.client;
    this.docId = options.docId;
    this.temperature = options.temperature ?? 0.1;
    this.enableCitations = options.enableCitations ?? true;

    const systemPrompt = options.systemPrompt?.trim();
    if (systemPrompt) {
      this.messages.push({ role: "system", content: systemPrompt });
    }
  }

  public getHistory(): PageIndexChatMessage[] {
    return [...this.messages];
  }

  public async ask(question: string): Promise<ChatSessionTurn> {
    const trimmedQuestion = question.trim();
    if (!trimmedQuestion) {
      throw new Error("Question cannot be empty.");
    }

    this.messages.push({ role: "user", content: trimmedQuestion });

    const result = await this.client.chatCompletion({
      messages: this.messages,
      docId: this.docId,
      temperature: this.temperature,
      enableCitations: this.enableCitations
    });

    this.messages.push({ role: "assistant", content: result.answer });

    return {
      question: trimmedQuestion,
      answer: result.answer,
      messages: this.getHistory()
    };
  }
}
