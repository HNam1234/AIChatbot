import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import os from "node:os";
import path from "node:path";

export interface PipelineProcessOptions {
  inputFile: string;
  ocrLanguage: string;
  doclingThreads: number;
  exportAssets: boolean;
  uploadPageIndex: boolean;
  forcePageIndexUpload?: boolean;
  pageIndexApiKey?: string;
  geminiApiKey?: string;
  timeoutMs: number;
  onLog: (message: string) => void;
  onStep: (step: string) => void;
}

export interface PipelineProcessResult {
  exitCode: number | null;
  timedOut: boolean;
  command: string;
}

export async function runPipelineProcess(options: PipelineProcessOptions): Promise<PipelineProcessResult> {
  const command = os.platform() === "win32" ? "npm.cmd" : "npm";
  const args = buildParseArgs(options);
  const commandText = formatCommand(command, args);
  const spawnCommand = os.platform() === "win32" ? "cmd.exe" : command;
  const spawnArgs = os.platform() === "win32" ? ["/d", "/s", "/c", command, ...args] : args;

  options.onLog(`Command: ${commandText}`);
  console.log(`[UI Pipeline] ${commandText}`);

  return await new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    const child = spawn(spawnCommand, spawnArgs, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...(options.pageIndexApiKey ? { PAGEINDEX_API_KEY: options.pageIndexApiKey } : {}),
        ...(options.geminiApiKey ? { GEMINI_API_KEY: options.geminiApiKey } : {})
      },
      windowsHide: true
    });

    child.stdout.on("data", (chunk: Buffer) => {
      handleOutput(chunk.toString("utf8"), options);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      handleOutput(chunk.toString("utf8"), options);
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, timedOut, command: commandText });
    });

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      timedOut = true;
      options.onStep("timeout");
      options.onLog(`UI job exceeded timeout ${options.timeoutMs}ms. Killing process tree.`);
      void killProcessTree(child);
    }, options.timeoutMs);
  });
}

function buildParseArgs(options: PipelineProcessOptions): string[] {
  const args = [
    "run",
    "parse",
    "--",
    options.inputFile,
    "--ocr-lang",
    options.ocrLanguage,
    "--docling-threads",
    String(options.doclingThreads)
  ];

  if (options.exportAssets) {
    args.push("--export-assets");
  }
  if (options.uploadPageIndex) {
    args.push("--upload-pageindex");
  }
  if (options.forcePageIndexUpload) {
    args.push("--force-pageindex-upload");
  }

  return args;
}

function handleOutput(output: string, options: PipelineProcessOptions): void {
  for (const line of output.replace(/\r\n/g, "\n").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const safeLine = redactSecrets(trimmed);
    options.onLog(safeLine);
    const step = inferStep(safeLine);
    if (step) {
      options.onStep(step);
    }
  }
}

function inferStep(line: string): string | undefined {
  const normalized = line.toLowerCase();
  if (normalized.includes("layout analysis started")) {
    return "layout analysis started";
  }
  if (normalized.includes("layout/docling routing started")) {
    return "layout/docling started";
  }
  if (normalized.includes("export assets started")) {
    return "export assets started";
  }
  if (normalized.includes("validation started")) {
    return "validation started";
  }
  if (normalized.includes("section map started")) {
    return "section map started";
  }
  if (normalized.includes("section map done")) {
    return "section map done";
  }
  if (normalized.includes("pageindex upload started")) {
    return "pageindex upload started";
  }
  if (normalized.includes("pageindex cache hit")) {
    return "pageindex cache hit";
  }
  if (normalized.includes("pageindex cache miss")) {
    return "pageindex cache miss";
  }
  if (normalized.includes("pageindex cache bypassed")) {
    return "pageindex cache bypassed";
  }
  if (normalized.includes("pageindex polling started")) {
    return "pageindex polling started";
  }
  if (normalized.includes("pageindex upload skipped")) {
    return "pageindex upload skipped";
  }
  if (normalized.includes("pageindex polling skipped")) {
    return "pageindex polling skipped";
  }
  if (normalized.includes("tree validation started")) {
    return "tree validation started";
  }
  if (normalized.includes("tree validation done")) {
    return "tree validation done";
  }
  return undefined;
}

async function killProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!child.pid) {
    child.kill("SIGKILL");
    return;
  }

  if (os.platform() === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        windowsHide: true
      });
      killer.on("close", () => resolve());
      killer.on("error", () => resolve());
    });
    return;
  }

  child.kill("SIGKILL");
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...redactArgList(args)].map(shellQuote).join(" ");
}

function redactArgList(args: string[]): string[] {
  const redacted = [...args];
  for (let index = 0; index < redacted.length; index += 1) {
    if (redacted[index] === "--pageindex-api-key" && redacted[index + 1]) {
      redacted[index + 1] = "[redacted]";
      index += 1;
    }
  }
  return redacted;
}

function redactSecrets(value: string): string {
  return value.replace(/(--pageindex-api-key\s+)(\S+)/g, "$1[redacted]");
}

function shellQuote(value: string): string {
  return /\s/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}
