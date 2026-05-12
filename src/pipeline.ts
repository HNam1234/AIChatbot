import { copyToUploads, prepareForPageIndex } from "./documents.js";
import { buildMessages, enforceGrounding, IDK_ANSWER } from "./guardrails.js";
import { PageIndexGateway } from "./pageindexGateway.js";
import { ManifestStore, newDocumentRecord, type DocumentRecord } from "./state.js";
import type { Settings } from "./config.js";

export type IngestOptions = {
  wait?: boolean;
  originalName?: string;
};

export class GroundedChatbotPipeline {
  private readonly store: ManifestStore;
  private pageIndex?: PageIndexGateway;

  constructor(private readonly settings: Settings) {
    this.store = new ManifestStore(settings.manifestPath);
  }

  async ingest(inputPath: string, options: IngestOptions = {}): Promise<DocumentRecord> {
    const wait = options.wait ?? true;
    const originalName = options.originalName ?? inputPath.split(/[\\/]/).at(-1) ?? "document";
    const uploadedPath = await copyToUploads(inputPath, this.settings.uploadDir, originalName);
    const submittedPath = await prepareForPageIndex(uploadedPath, this.settings.convertedDir);
    const docId = await this.getPageIndex().submitDocument(submittedPath);

    const record = newDocumentRecord(docId, originalName, uploadedPath, submittedPath);
    await this.store.upsert(record);

    if (wait) {
      record.status = await this.getPageIndex().waitUntilComplete(
        docId,
        this.settings.processingTimeoutSeconds,
        this.settings.pollIntervalSeconds
      );
      await this.store.upsert(record);
    }

    return record;
  }

  async refreshStatus(docId: string): Promise<string> {
    const status = await this.getPageIndex().getDocumentStatus(docId);
    await this.store.updateStatus(docId, status);
    return status;
  }

  async ask(question: string, docIds?: string[]): Promise<string> {
    const scopedDocIds = docIds?.length ? docIds : await this.store.completedIds();
    if (!scopedDocIds.length) return IDK_ANSWER;

    const rawAnswer = await this.getPageIndex().chat(buildMessages(question), scopedDocIds);
    return enforceGrounding(rawAnswer, this.settings.requirePageIndexCitations);
  }

  async documents(): Promise<DocumentRecord[]> {
    return this.store.list();
  }

  private getPageIndex(): PageIndexGateway {
    this.pageIndex ??= new PageIndexGateway(this.settings.pageIndexApiKey);
    return this.pageIndex;
  }
}
