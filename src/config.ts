import "dotenv/config";

import { mkdir } from "node:fs/promises";
import path from "node:path";

export type Settings = {
  pageIndexApiKey: string;
  dataDir: string;
  uploadDir: string;
  convertedDir: string;
  stateDir: string;
  tmpDir: string;
  manifestPath: string;
  pollIntervalSeconds: number;
  processingTimeoutSeconds: number;
  requirePageIndexCitations: boolean;
  port: number;
};

function envBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`${name} must be a number`);
  }
  return parsed;
}

export async function loadSettings(): Promise<Settings> {
  const dataDir = path.resolve(process.env.DATA_DIR ?? "data");
  const settings: Settings = {
    pageIndexApiKey: (process.env.PAGEINDEX_API_KEY ?? "").trim(),
    dataDir,
    uploadDir: path.join(dataDir, "uploads"),
    convertedDir: path.join(dataDir, "converted"),
    stateDir: path.join(dataDir, "state"),
    tmpDir: path.join(dataDir, "tmp"),
    manifestPath: path.join(dataDir, "state", "documents.json"),
    pollIntervalSeconds: envNumber("PAGEINDEX_POLL_INTERVAL_SECONDS", 3),
    processingTimeoutSeconds: envNumber("PAGEINDEX_PROCESSING_TIMEOUT_SECONDS", 900),
    requirePageIndexCitations: envBoolean("REQUIRE_PAGEINDEX_CITATIONS", true),
    port: envNumber("PORT", 8000)
  };

  await Promise.all([
    mkdir(settings.uploadDir, { recursive: true }),
    mkdir(settings.convertedDir, { recursive: true }),
    mkdir(settings.stateDir, { recursive: true }),
    mkdir(settings.tmpDir, { recursive: true })
  ]);

  return settings;
}
