/**
 * Public library API for the local PDF parser and QA server.
 *
 * Keep exports here intentionally small. Internal modules can stay deeply
 * organized, while callers import stable entry points from `src/index`.
 */

export {
  createAppApi,
  createPageIndexChatSession,
  createPageIndexClientFromEnv,
  type AppApi,
  type CreateChatSessionOptions,
  type CreatePageIndexClientOptions
} from "./appApi";
export {
  executePipeline,
  runParsingPipeline,
  type ParsingPipelineResult
} from "./mainFlow";
export type {
  LayoutAnalysis,
  ParsedBlock,
  PipelineOptions,
  PipelineResult,
  RoutingPlan,
  ValidationReport
} from "./types";

export {
  ChatSession,
  PageIndexClient,
  type ChatSessionOptions,
  type ChatSessionTurn,
  type PageIndexChatMessage,
  type PageIndexChatOptions,
  type PageIndexChatResult
} from "./api";
export * as Api from "./api";
export * as AgentApi from "./agent";
export * as ConfigApi from "./config";
export * as OrchestratorApi from "./orchestrator";

export {
  answerFromCachedTrees,
  answerQuestionForEval,
  buildMappingPayload,
  createApiRouter,
  listMappingDocuments,
  publicSectionCitation,
  renderSourceTextHtml,
  withPdfCitationLinks
} from "./server";
export type {
  MappingBlock,
  MappingDocumentSummary,
  MappingPayload,
  MappingSection,
  SourceCitationSection,
  SourceTextView
} from "./server";
