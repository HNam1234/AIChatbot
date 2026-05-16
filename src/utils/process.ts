import { spawn } from "node:child_process";

export interface ProcessResult {
  command: string;
  args: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface ProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBufferBytes?: number;
  check?: boolean;
}

export async function runProcess(
  command: string,
  args: string[],
  options: ProcessOptions = {}
): Promise<ProcessResult> {
  const maxBufferBytes = options.maxBufferBytes ?? 128 * 1024 * 1024;

  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
        ...options.env
      },
      shell: false,
      windowsHide: true
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const timeout =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            if (settled) {
              return;
            }
            settled = true;
            child.kill("SIGTERM");
            reject(new Error(`Process timed out after ${options.timeoutMs}ms: ${formatCommand(command, args)}`));
          }, options.timeoutMs)
        : undefined;

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBufferBytes) {
        if (settled) {
          return;
        }
        settled = true;
        child.kill("SIGTERM");
        reject(new Error(`Process stdout exceeded ${maxBufferBytes} bytes: ${formatCommand(command, args)}`));
        return;
      }

      stdoutChunks.push(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxBufferBytes) {
        if (settled) {
          return;
        }
        settled = true;
        child.kill("SIGTERM");
        reject(new Error(`Process stderr exceeded ${maxBufferBytes} bytes: ${formatCommand(command, args)}`));
        return;
      }

      stderrChunks.push(chunk);
    });

    child.on("error", (error) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (!settled) {
        settled = true;
        reject(error);
      }
    });

    child.on("close", (exitCode) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (settled) {
        return;
      }

      settled = true;
      const result: ProcessResult = {
        command,
        args,
        exitCode,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8")
      };

      if (options.check && exitCode !== 0) {
        reject(
          new Error(
            `Process failed with exit code ${exitCode}: ${formatCommand(command, args)}\n${result.stderr.trim()}`
          )
        );
        return;
      }

      resolve(result);
    });
  });
}

export function formatCommand(command: string, args: string[]): string {
  return [command, ...args].map(quoteArg).join(" ");
}

function quoteArg(arg: string): string {
  if (/^[A-Za-z0-9_./:=,-]+$/.test(arg)) {
    return arg;
  }

  return `"${arg.replace(/"/g, '\\"')}"`;
}
