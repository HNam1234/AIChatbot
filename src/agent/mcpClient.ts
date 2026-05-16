import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface PageIndexMCPOptions {
  apiKey: string;
  url?: string;
  clientName?: string;
  clientVersion?: string;
}

export interface TargetedContextRequest {
  query: string;
  docId?: string;
  docName?: string;
  pages?: string;
  folderId?: string;
  toolName?: string;
  maxChars?: number;
  waitForCompletion?: boolean;
}

export interface TargetedContextResult {
  context: string;
  toolName: string;
  availableTools: string[];
  originalLength: number;
  truncated: boolean;
}

type ToolInfo = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

const DEFAULT_MCP_URL = "https://api.pageindex.ai/mcp";

export class PageIndexMCP {
  private readonly client: Client;
  private readonly transport: StreamableHTTPClientTransport;
  private connected = false;

  public constructor(options: PageIndexMCPOptions) {
    if (!options.apiKey.trim()) {
      throw new Error("PAGEINDEX_API_KEY is required for PageIndex MCP.");
    }

    this.client = new Client({
      name: options.clientName ?? "HSCode-MCP-Agent",
      version: options.clientVersion ?? "1.0.0"
    });
    this.transport = new StreamableHTTPClientTransport(new URL(options.url ?? DEFAULT_MCP_URL), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${options.apiKey}`
        }
      }
    });
  }

  public async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    await this.client.connect(this.transport);
    this.connected = true;
  }

  public async close(): Promise<void> {
    if (!this.connected) {
      return;
    }

    await this.client.close();
    this.connected = false;
  }

  public async listToolNames(): Promise<string[]> {
    const result = await this.client.listTools();
    return result.tools.map((tool) => tool.name);
  }

  public async retrieveTargetedContext(request: TargetedContextRequest): Promise<TargetedContextResult> {
    const tools = (await this.client.listTools()).tools;
    const tool = selectTool(tools, request.toolName);
    if (!tool) {
      const availableTools = tools.map((candidate) => candidate.name);
      throw new Error(
        `No compatible PageIndex MCP tool found. Available tools: ${availableTools.join(", ") || "none"}.`
      );
    }

    const raw = await this.callToolForContext(tool, request);
    const maxChars = request.maxChars ?? 1500;
    const context = extractRelevantSnippet(raw, request.query, maxChars);

    return {
      context,
      toolName: tool.name,
      availableTools: tools.map((candidate) => candidate.name),
      originalLength: raw.length,
      truncated: context.length < raw.length
    };
  }

  private async callToolForContext(tool: ToolInfo, request: TargetedContextRequest): Promise<string> {
    const args = buildToolArguments(tool, request);
    const result = await this.client.callTool({
      name: tool.name,
      arguments: args
    });

    return extractToolText(result);
  }
}

export function selectTool(tools: ToolInfo[], explicitToolName?: string): ToolInfo | undefined {
  if (explicitToolName) {
    return tools.find((tool) => tool.name === explicitToolName);
  }

  const preferredNames = [
    "pageindex_tree_search",
    "pageindex_search_tree",
    "pageindex_find_relevant_documents",
    "pageindex_get_document_structure",
    "pageindex_get_page_content"
  ];

  for (const name of preferredNames) {
    const match = tools.find((tool) => tool.name === name);
    if (match) {
      return match;
    }
  }

  return tools.find((tool) => /search|structure|content/i.test(tool.name));
}

export function buildToolArguments(tool: ToolInfo, request: TargetedContextRequest): Record<string, unknown> {
  const properties = getInputProperties(tool);
  const propertyNames = Object.keys(properties);
  const args: Record<string, unknown> = {};
  const docRef = request.docName ?? request.docId;

  setIfSupported(args, propertyNames, ["query", "q", "search"], request.query);
  setIfSupported(args, propertyNames, ["doc_id", "docId"], request.docId ?? request.docName);
  setIfSupported(args, propertyNames, ["docName", "doc_name", "documentName", "document"], request.docName ?? request.docId);
  setIfSupported(args, propertyNames, ["pages", "page"], request.pages);
  setIfSupported(args, propertyNames, ["folderId", "folder_id"], request.folderId);
  setIfSupported(args, propertyNames, ["waitForCompletion", "wait_for_completion"], request.waitForCompletion ?? true);

  for (const required of getRequiredProperties(tool)) {
    if (args[required] !== undefined) {
      continue;
    }

    if (/doc|document/i.test(required) && docRef) {
      args[required] = docRef;
    } else if (/query|search|keyword/i.test(required)) {
      args[required] = request.query;
    } else if (/page/i.test(required) && request.pages) {
      args[required] = request.pages;
    }
  }

  return args;
}

export function extractToolText(result: CallToolResult | unknown): string {
  const payload = result as {
    content?: Array<unknown>;
    structuredContent?: unknown;
  };
  const parts: string[] = [];

  for (const item of payload.content ?? []) {
    const content = item as {
      type?: string;
      text?: unknown;
      resource?: { text?: unknown };
      data?: unknown;
      mimeType?: unknown;
    };

    if (typeof content.text === "string") {
      parts.push(content.text);
    } else if (typeof content.resource?.text === "string") {
      parts.push(content.resource.text);
    }
  }

  if (parts.length > 0) {
    return parts.join("\n").trim();
  }

  if (payload.structuredContent !== undefined) {
    return JSON.stringify(payload.structuredContent, null, 2);
  }

  return JSON.stringify(result, null, 2);
}

export function extractRelevantSnippet(text: string, query: string, maxChars: number): string {
  const normalized = text.trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  const queryTokens = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}.]+/u)
    .filter((token) => token.length >= 3)
    .sort((left, right) => right.length - left.length);
  const lower = normalized.toLowerCase();
  const matchIndex = queryTokens
    .map((token) => lower.indexOf(token))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];

  if (matchIndex === undefined) {
    return `${normalized.slice(0, Math.max(0, maxChars - 40)).trimEnd()}\n[Context truncated]`;
  }

  const halfWindow = Math.floor((maxChars - 60) / 2);
  const start = Math.max(0, matchIndex - halfWindow);
  const end = Math.min(normalized.length, start + maxChars - 40);
  const prefix = start > 0 ? "[Context truncated]\n" : "";
  const suffix = end < normalized.length ? "\n[Context truncated]" : "";

  return `${prefix}${normalized.slice(start, end).trim()}${suffix}`;
}

function getInputProperties(tool: ToolInfo): Record<string, object> {
  return tool.inputSchema.properties ?? {};
}

function getRequiredProperties(tool: ToolInfo): string[] {
  return Array.isArray(tool.inputSchema.required) ? tool.inputSchema.required : [];
}

function setIfSupported(
  args: Record<string, unknown>,
  propertyNames: string[],
  candidates: string[],
  value: unknown
): void {
  if (value === undefined) {
    return;
  }

  const key = candidates.find((candidate) => propertyNames.includes(candidate));
  if (key) {
    args[key] = value;
  }
}
