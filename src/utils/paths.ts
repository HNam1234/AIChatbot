import fs from "node:fs";
import { mkdir, mkdtemp, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function ensureDirectory(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

export async function createTempDirectory(prefix: string): Promise<string> {
  const baseDir = path.resolve(process.cwd(), "data", "tmp");
  await ensureDirectory(baseDir);
  return await mkdtemp(path.join(baseDir, `${prefix}-`));
}

export function resolvePythonCommand(explicitCommand?: string): string {
  if (explicitCommand) {
    return explicitCommand;
  }

  if (process.env.PDF_PIPELINE_PYTHON) {
    return process.env.PDF_PIPELINE_PYTHON;
  }

  const workspaceVenv =
    os.platform() === "win32"
      ? path.resolve(process.cwd(), ".venv", "Scripts", "python.exe")
      : path.resolve(process.cwd(), ".venv", "bin", "python");

  if (fs.existsSync(workspaceVenv)) {
    return workspaceVenv;
  }

  return os.platform() === "win32" ? "python" : "python3";
}

export function resolveDoclingCommand(explicitCommand?: string): string {
  if (explicitCommand) {
    return explicitCommand;
  }

  if (process.env.DOCLING_BIN) {
    return process.env.DOCLING_BIN;
  }

  const workspaceDocling =
    os.platform() === "win32"
      ? path.resolve(process.cwd(), ".venv", "Scripts", "docling.exe")
      : path.resolve(process.cwd(), ".venv", "bin", "docling");

  if (fs.existsSync(workspaceDocling)) {
    return workspaceDocling;
  }

  return "docling";
}

export async function findNewestFile(rootDir: string, extension: string): Promise<string | undefined> {
  const normalizedExtension = extension.startsWith(".") ? extension : `.${extension}`;
  const matches: Array<{ filePath: string; mtimeMs: number; size: number }> = [];

  async function walk(currentDir: string): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          await walk(entryPath);
          return;
        }

        if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== normalizedExtension.toLowerCase()) {
          return;
        }

        const fileStat = await stat(entryPath);
        matches.push({ filePath: entryPath, mtimeMs: fileStat.mtimeMs, size: fileStat.size });
      })
    );
  }

  await walk(rootDir);
  matches.sort((a, b) => b.mtimeMs - a.mtimeMs || b.size - a.size);
  return matches[0]?.filePath;
}

export function defaultOutputPath(pdfPath: string): string {
  const fileName = `${path.basename(pdfPath, path.extname(pdfPath))}.milestone1.md`;
  return path.resolve(process.cwd(), "data", "converted", fileName);
}

export function defaultBlocksPath(pdfPath: string): string {
  const fileName = `${path.basename(pdfPath, path.extname(pdfPath))}.milestone1.blocks.json`;
  return path.resolve(process.cwd(), "data", "converted", fileName);
}

export function defaultValidationReportPath(pdfPath: string): string {
  const fileName = `${path.basename(pdfPath, path.extname(pdfPath))}.milestone1.validation.json`;
  return path.resolve(process.cwd(), "data", "converted", fileName);
}

export function defaultSectionMapPath(pdfPath: string): string {
  const fileName = `${path.basename(pdfPath, path.extname(pdfPath))}.sections.json`;
  return path.resolve(process.cwd(), "data", "converted", fileName);
}

export function defaultTreePath(pdfPath: string): string {
  const fileName = `${path.basename(pdfPath, path.extname(pdfPath))}.tree.json`;
  return path.resolve(process.cwd(), "data", "converted", fileName);
}

export function defaultTreeValidationReportPath(pdfPath: string): string {
  const fileName = `${path.basename(pdfPath, path.extname(pdfPath))}.tree.validation.json`;
  return path.resolve(process.cwd(), "data", "converted", fileName);
}
