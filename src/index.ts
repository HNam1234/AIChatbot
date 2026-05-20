/**
 * Package entrypoint.
 *
 * Read `src/main.ts` first. It is the linear composition root that wires
 * config, clients, pipeline, QA, mapping, source citation, and server APIs.
 */

export {
  createAppApi,
  createMainApi,
  createPageIndexChatSession,
  createPageIndexClientFromEnv,
  createServerRouter,
  getApplicationSettings,
  listParsedDocuments,
  loadApplicationConfig,
  openMappingPayload,
  runPdfParsingOnly,
  runPdfPipeline,
  type AppApi,
  type CreateChatSessionOptions,
  type CreatePageIndexClientOptions,
  type MainApi,
  type ParsingPipelineResult
} from "./main";

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
