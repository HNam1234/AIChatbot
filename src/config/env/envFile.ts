import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WritableEnvKeyName } from "./types";

export async function saveEnvValueToEnv(keyName: WritableEnvKeyName, value: string): Promise<void> {
  const envPath = path.resolve(process.cwd(), ".env");
  const current = await readFile(envPath, "utf8").catch(() => "");
  const next = upsertEnvValue(current, keyName, value);
  await writeFile(envPath, next, "utf8");
  process.env[keyName] = value;
}

function upsertEnvValue(envText: string, key: string, value: string): string {
  const normalized = envText.replace(/\r\n/g, "\n");
  const lines = normalized ? normalized.split("\n") : [];
  const escaped = `${key}=${quoteEnvValue(value)}`;
  let replaced = false;

  const nextLines = lines.map((line) => {
    if (line.match(new RegExp(`^\\s*${key}\\s*=`))) {
      replaced = true;
      return escaped;
    }
    return line;
  });

  if (!replaced) {
    if (nextLines.length > 0 && nextLines[nextLines.length - 1] !== "") {
      nextLines.push(escaped);
    } else if (nextLines.length > 0) {
      nextLines[nextLines.length - 1] = escaped;
      nextLines.push("");
    } else {
      nextLines.push(escaped);
    }
  }

  return `${nextLines.join("\n").replace(/\n*$/g, "")}\n`;
}

function quoteEnvValue(value: string): string {
  if (/[\s"'#]/.test(value)) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}
