import { lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";

export interface TempCleanupResult {
  removedEntries: number;
  removedFiles: number;
  removedDirs: number;
  removedBytes: number;
  skippedEntries: number;
}

export async function cleanupTmpDirectory(options: {
  tmpDir?: string;
  retentionHours: number;
  now?: number;
}): Promise<TempCleanupResult> {
  const tmpDir = path.resolve(options.tmpDir ?? path.join(process.cwd(), "data", "tmp"));
  const cutoff = (options.now ?? Date.now()) - options.retentionHours * 60 * 60 * 1000;
  const result: TempCleanupResult = { removedEntries: 0, removedFiles: 0, removedDirs: 0, removedBytes: 0, skippedEntries: 0 };
  const entries = await readdir(tmpDir, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    if (entry.name === ".gitkeep") {
      result.skippedEntries += 1;
      continue;
    }
    const absolutePath = path.join(tmpDir, entry.name);
    if (!absolutePath.startsWith(`${tmpDir}${path.sep}`)) {
      result.skippedEntries += 1;
      continue;
    }
    const entryStat = await lstat(absolutePath).catch(() => undefined);
    if (!entryStat || entryStat.mtimeMs > cutoff) {
      result.skippedEntries += 1;
      continue;
    }
    const summary = await summarizePath(absolutePath);
    await rm(absolutePath, { recursive: true, force: true });
    result.removedEntries += 1;
    result.removedFiles += summary.files;
    result.removedDirs += summary.dirs;
    result.removedBytes += summary.bytes;
  }

  return result;
}

async function summarizePath(targetPath: string): Promise<{ files: number; dirs: number; bytes: number }> {
  const entryStat = await lstat(targetPath).catch(() => undefined);
  if (!entryStat) return { files: 0, dirs: 0, bytes: 0 };
  if (!entryStat.isDirectory()) {
    return { files: 1, dirs: 0, bytes: entryStat.size };
  }
  const entries = await readdir(targetPath, { withFileTypes: true }).catch(() => []);
  const summary = { files: 0, dirs: 1, bytes: 0 };
  for (const entry of entries) {
    const child = await summarizePath(path.join(targetPath, entry.name));
    summary.files += child.files;
    summary.dirs += child.dirs;
    summary.bytes += child.bytes;
  }
  return summary;
}
