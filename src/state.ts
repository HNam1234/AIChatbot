import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type DocumentStatus = "submitted" | "completed" | "failed" | "processing" | "unknown" | string;

export type DocumentRecord = {
  docId: string;
  originalName: string;
  uploadedPath: string;
  submittedPath: string;
  status: DocumentStatus;
  createdAt: string;
};

type Manifest = {
  documents: DocumentRecord[];
};

export function newDocumentRecord(
  docId: string,
  originalName: string,
  uploadedPath: string,
  submittedPath: string
): DocumentRecord {
  return {
    docId,
    originalName,
    uploadedPath,
    submittedPath,
    status: "submitted",
    createdAt: new Date().toISOString()
  };
}

export class ManifestStore {
  constructor(private readonly manifestPath: string) {}

  async list(): Promise<DocumentRecord[]> {
    try {
      const raw = await readFile(this.manifestPath, "utf8");
      const parsed = JSON.parse(raw) as Manifest;
      return parsed.documents ?? [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  async get(docId: string): Promise<DocumentRecord | undefined> {
    return (await this.list()).find((record) => record.docId === docId);
  }

  async upsert(record: DocumentRecord): Promise<void> {
    const records = (await this.list()).filter((item) => item.docId !== record.docId);
    records.push(record);
    await this.write(records);
  }

  async updateStatus(docId: string, status: DocumentStatus): Promise<void> {
    const records = await this.list();
    const record = records.find((item) => item.docId === docId);
    if (record) {
      record.status = status;
      await this.write(records);
    }
  }

  async completedIds(): Promise<string[]> {
    return (await this.list()).filter((record) => record.status === "completed").map((record) => record.docId);
  }

  private async write(records: DocumentRecord[]): Promise<void> {
    await mkdir(path.dirname(this.manifestPath), { recursive: true });
    const tmpPath = `${this.manifestPath}.tmp`;
    await writeFile(tmpPath, JSON.stringify({ documents: records }, null, 2), "utf8");
    await rename(tmpPath, this.manifestPath);
  }
}
