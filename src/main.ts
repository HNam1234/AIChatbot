import {
  ChatSession,
  PageIndexClient,
  type ChatSessionOptions,
  type PageIndexClientOptions
} from "./api";
import {
  canWriteSecretsFromUi,
  getApiSettingsStatus,
  isGeminiKeySlotName,
  loadEnvConfig,
  maskSecret,
  resolvePageIndexSettings,
  saveBifrostSettingsToEnv,
  saveGeminiApiKeyToEnv,
  saveGeminiKeySlotEnabledToEnv,
  saveGeminiKeySlotToEnv,
  savePageIndexApiKeyToEnv,
  type AppConfig
} from "./config";
import {
  createLlmClient,
  expandQueryForRetrievalWithDebug,
  getLlmAvailability,
  planQuery,
  runAgenticQuery
} from "./agent";
import {
  executePipeline,
  runParsingPipeline,
  type ParsingPipelineResult
} from "./mainFlow";
import {
  ArtifactFilter,
  HSCodeReconstructor,
  ImageAssetExporter,
  LayoutAnalyzer,
  SectionMapBuilder,
  SemanticFusion,
  SmartRouter,
  TreeBuilder
} from "./orchestrator";
import {
  answerFromCachedTrees,
  answerQuestionForEval,
  buildMappingPayload,
  createApiRouter,
  listMappingDocuments,
  publicSectionCitation,
  renderSourceTextHtml,
  withPdfCitationLinks
} from "./server";

// 1. Configuration: all workflows start by reading env and settings.
export function loadApplicationConfig(): AppConfig {
  return loadEnvConfig();
}

export function getApplicationSettings() {
  return getApiSettingsStatus();
}

// 2. Clients: construct external clients from config, with optional overrides.
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

// 3. Pipeline: parse a PDF or run the complete parse/validate/upload flow.
export const runPdfParsingOnly = runParsingPipeline;
export const runPdfPipeline = executePipeline;

// 4. Mapping/source: read parsed artifacts for the UI panels.
export const listParsedDocuments = listMappingDocuments;
export const openMappingPayload = buildMappingPayload;

// 5. Server: create the local HTTP API router.
export const createServerRouter = createApiRouter;

// 6. Composition: expose a single object for callers that prefer one API handle.
export function createMainApi(): MainApi {
  return {
    config: {
      load: loadApplicationConfig,
      status: getApplicationSettings,
      canWriteSecretsFromUi,
      maskSecret,
      isGeminiKeySlotName,
      savePageIndexApiKey: savePageIndexApiKeyToEnv,
      saveGeminiApiKey: saveGeminiApiKeyToEnv,
      saveGeminiKeySlot: saveGeminiKeySlotToEnv,
      saveGeminiKeySlotEnabled: saveGeminiKeySlotEnabledToEnv,
      saveBifrostSettings: saveBifrostSettingsToEnv
    },
    clients: {
      pageIndex: createPageIndexClientFromEnv,
      chatSession: createPageIndexChatSession,
      llm: createLlmClient
    },
    pipeline: {
      parse: runPdfParsingOnly,
      execute: runPdfPipeline
    },
    qa: {
      answerFromCache: answerFromCachedTrees,
      answerForEval: answerQuestionForEval,
      planQuery,
      expandQuery: expandQueryForRetrievalWithDebug,
      runAgenticQuery,
      llmAvailability: getLlmAvailability
    },
    mapping: {
      listDocuments: listParsedDocuments,
      payload: openMappingPayload
    },
    source: {
      citation: publicSectionCitation,
      withPdfLinks: withPdfCitationLinks,
      renderHtml: renderSourceTextHtml
    },
    server: {
      router: createServerRouter
    },
    orchestrator: {
      ArtifactFilter,
      HSCodeReconstructor,
      ImageAssetExporter,
      LayoutAnalyzer,
      SectionMapBuilder,
      SemanticFusion,
      SmartRouter,
      TreeBuilder
    }
  };
}

export const createAppApi = createMainApi;

export interface CreatePageIndexClientOptions extends PageIndexClientOptions {
  apiKey?: string;
}

export type CreateChatSessionOptions =
  Omit<ChatSessionOptions, "client"> &
  CreatePageIndexClientOptions & {
    client?: PageIndexClient;
  };

export interface MainApi {
  config: {
    load: typeof loadApplicationConfig;
    status: typeof getApplicationSettings;
    canWriteSecretsFromUi: typeof canWriteSecretsFromUi;
    maskSecret: typeof maskSecret;
    isGeminiKeySlotName: typeof isGeminiKeySlotName;
    savePageIndexApiKey: typeof savePageIndexApiKeyToEnv;
    saveGeminiApiKey: typeof saveGeminiApiKeyToEnv;
    saveGeminiKeySlot: typeof saveGeminiKeySlotToEnv;
    saveGeminiKeySlotEnabled: typeof saveGeminiKeySlotEnabledToEnv;
    saveBifrostSettings: typeof saveBifrostSettingsToEnv;
  };
  clients: {
    pageIndex: typeof createPageIndexClientFromEnv;
    chatSession: typeof createPageIndexChatSession;
    llm: typeof createLlmClient;
  };
  pipeline: {
    parse: typeof runPdfParsingOnly;
    execute: typeof runPdfPipeline;
  };
  qa: {
    answerFromCache: typeof answerFromCachedTrees;
    answerForEval: typeof answerQuestionForEval;
    planQuery: typeof planQuery;
    expandQuery: typeof expandQueryForRetrievalWithDebug;
    runAgenticQuery: typeof runAgenticQuery;
    llmAvailability: typeof getLlmAvailability;
  };
  mapping: {
    listDocuments: typeof listParsedDocuments;
    payload: typeof openMappingPayload;
  };
  source: {
    citation: typeof publicSectionCitation;
    withPdfLinks: typeof withPdfCitationLinks;
    renderHtml: typeof renderSourceTextHtml;
  };
  server: {
    router: typeof createServerRouter;
  };
  orchestrator: {
    ArtifactFilter: typeof ArtifactFilter;
    HSCodeReconstructor: typeof HSCodeReconstructor;
    ImageAssetExporter: typeof ImageAssetExporter;
    LayoutAnalyzer: typeof LayoutAnalyzer;
    SectionMapBuilder: typeof SectionMapBuilder;
    SemanticFusion: typeof SemanticFusion;
    SmartRouter: typeof SmartRouter;
    TreeBuilder: typeof TreeBuilder;
  };
}

export type AppApi = MainApi;
export type { ParsingPipelineResult };
