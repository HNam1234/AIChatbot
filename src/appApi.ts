import { ChatSession, PageIndexClient, type ChatSessionOptions, type PageIndexClientOptions } from "./api";
import {
  getApiSettingsStatus,
  loadEnvConfig,
  resolvePageIndexSettings,
  type AppConfig
} from "./config";
import {
  executePipeline,
  runParsingPipeline,
  type ParsingPipelineResult
} from "./mainFlow";
import {
  answerFromCachedTrees,
  answerQuestionForEval,
  buildMappingPayload,
  createApiRouter,
  listMappingDocuments
} from "./server";

export interface CreatePageIndexClientOptions extends PageIndexClientOptions {
  apiKey?: string;
}

export type CreateChatSessionOptions =
  Omit<ChatSessionOptions, "client"> &
  CreatePageIndexClientOptions & {
    client?: PageIndexClient;
  };

export interface AppApi {
  loadConfig: () => AppConfig;
  getSettingsStatus: typeof getApiSettingsStatus;
  createPageIndexClient: typeof createPageIndexClientFromEnv;
  createChatSession: typeof createPageIndexChatSession;
  executePipeline: typeof executePipeline;
  runParsingPipeline: typeof runParsingPipeline;
  createApiRouter: typeof createApiRouter;
  listMappingDocuments: typeof listMappingDocuments;
  buildMappingPayload: typeof buildMappingPayload;
  answerFromCachedTrees: typeof answerFromCachedTrees;
  answerQuestionForEval: typeof answerQuestionForEval;
}

/**
 * Creates a PageIndex client using env defaults plus optional overrides.
 *
 * This is the simple application-facing factory. Lower-level code can still
 * instantiate `PageIndexClient` directly from `src/api`.
 */
export function createPageIndexClientFromEnv(options: CreatePageIndexClientOptions = {}): PageIndexClient {
  const settings = resolvePageIndexSettings({
    apiKey: options.apiKey,
    baseUrl: options.baseUrl
  });
  return new PageIndexClient(settings.pageIndexApiKey, {
    baseUrl: settings.pageIndexBaseUrl
  });
}

export function createPageIndexChatSession(options: CreateChatSessionOptions = {}): ChatSession {
  const client = options.client ?? createPageIndexClientFromEnv({
    apiKey: options.apiKey,
    baseUrl: options.baseUrl
  });
  return new ChatSession({
    client,
    docId: options.docId,
    temperature: options.temperature,
    enableCitations: options.enableCitations,
    systemPrompt: options.systemPrompt
  });
}

/**
 * Single facade for the app's public operations.
 *
 * Callers can import this one factory when they want a compact API surface
 * instead of importing from `api`, `config`, `server`, and `mainFlow` directly.
 */
export function createAppApi(): AppApi {
  return {
    loadConfig: loadEnvConfig,
    getSettingsStatus: getApiSettingsStatus,
    createPageIndexClient: createPageIndexClientFromEnv,
    createChatSession: createPageIndexChatSession,
    executePipeline,
    runParsingPipeline,
    createApiRouter,
    listMappingDocuments,
    buildMappingPayload,
    answerFromCachedTrees,
    answerQuestionForEval
  };
}

export type { ParsingPipelineResult };
