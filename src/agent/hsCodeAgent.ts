import { createLlmClient } from "./llmFactory";
import { PageIndexMCP } from "./mcpClient";
import { TokenValidator } from "../validators/tokenValidator";
import type { ValidationMarkerResult } from "../types";

export interface AgenticQueryOptions {
  pageIndexApiKey: string;
  pageIndexMcpUrl?: string;
  docId?: string;
  docName?: string;
  query: string;
  pages?: string;
  folderId?: string;
  mcpToolName?: string;
  geminiApiKeys?: string[];
  geminiModel?: string;
  maxContextChars?: number;
  maxAnswerWords?: number;
}

export interface AgenticQueryResult {
  answer: string;
  context: string;
  retrieval: {
    toolName: string;
    availableTools: string[];
    originalLength: number;
    truncated: boolean;
  };
  markers: ValidationMarkerResult[];
}

export async function runAgenticQuery(options: AgenticQueryOptions): Promise<AgenticQueryResult> {
  const mcp = new PageIndexMCP({
    apiKey: options.pageIndexApiKey,
    url: options.pageIndexMcpUrl
  });
  const llm = createLlmClient({
    apiKeys: options.geminiApiKeys,
    geminiModel: options.geminiModel
  });

  try {
    await mcp.connect();

    const targeted = await mcp.retrieveTargetedContext({
      query: options.query,
      docId: options.docId,
      docName: options.docName,
      pages: options.pages,
      folderId: options.folderId,
      toolName: options.mcpToolName,
      maxChars: options.maxContextChars,
      waitForCompletion: true
    });

    const marker12 = TokenValidator.validateContextSize(targeted.context, {
      maxChars: options.maxContextChars,
      originalLength: targeted.originalLength,
      truncated: targeted.truncated
    });
    const answer = await llm.synthesizeAnswer(targeted.context, options.query);
    const marker13 = TokenValidator.validateOutputSize(answer, {
      maxWords: options.maxAnswerWords
    });

    return {
      answer,
      context: targeted.context,
      retrieval: {
        toolName: targeted.toolName,
        availableTools: targeted.availableTools,
        originalLength: targeted.originalLength,
        truncated: targeted.truncated
      },
      markers: [marker12, marker13]
    };
  } finally {
    await mcp.close();
  }
}
