#!/usr/bin/env node

import { loadSettings } from "./config.js";
import { GroundedChatbotPipeline } from "./pipeline.js";

function usage(): string {
  return `PageIndex grounded chatbot

Usage:
  grounded-chatbot ingest <file...> [--no-wait]
  grounded-chatbot ask <question> [--doc-id <doc_id>]...
  grounded-chatbot docs
`;
}

function valuesAfterFlag(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag && args[index + 1]) {
      values.push(args[index + 1]);
      index += 1;
    }
  }
  return values;
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  if (!command || command === "--help" || command === "-h") {
    console.log(usage());
    return;
  }

  const pipeline = new GroundedChatbotPipeline(await loadSettings());

  if (command === "ingest") {
    const wait = !args.includes("--no-wait");
    const paths = args.filter((arg) => arg !== "--no-wait");
    if (!paths.length) {
      throw new Error("ingest requires at least one file path");
    }

    for (const filePath of paths) {
      const record = await pipeline.ingest(filePath, { wait });
      console.log(`${record.docId}\t${record.status}\t${record.originalName}`);
    }
    return;
  }

  if (command === "ask") {
    const docIds = valuesAfterFlag(args, "--doc-id");
    const questionParts: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === "--doc-id") {
        index += 1;
        continue;
      }
      questionParts.push(args[index]);
    }
    const question = questionParts.join(" ").trim();
    if (!question) {
      throw new Error("ask requires a question");
    }
    console.log(await pipeline.ask(question, docIds));
    return;
  }

  if (command === "docs") {
    for (const record of await pipeline.documents()) {
      console.log(`${record.docId}\t${record.status}\t${record.originalName}`);
    }
    return;
  }

  throw new Error(`Unknown command '${command}'\n\n${usage()}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
