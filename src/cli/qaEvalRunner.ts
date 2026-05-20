import { readFile } from "node:fs/promises";
import path from "node:path";
import { answerQuestionForEval } from "../server/routes";

interface QaEvalItem {
  id: string;
  question: string;
  expectedIntent: string;
  expectedAnswerMode?: string;
  mustContainAll?: string[];
  mustContainAny?: string[];
  mustNotContain?: string[];
  scopeDocuments?: string[];
  shouldNotCallLlm?: boolean;
  fallbackForbidden?: boolean;
  expectedHsCodes?: string[];
  expectedDocument?: string | null;
  expectedTitleContains?: string | null;
}

type QaMode = "fast" | "accuracy";

interface CliOptions {
  fixturePath: string;
  qaMode: QaMode;
}

interface EvalResult {
  item: QaEvalItem;
  passed: boolean;
  reasons: string[];
  response: Record<string, unknown>;
}

async function main(): Promise<void> {
  process.env.QA_EVAL_QUIET = "1";
  const cliOptions = parseCliOptions(process.argv.slice(2));
  const fixturePath = cliOptions.fixturePath;
  const items = JSON.parse(await readFile(fixturePath, "utf8")) as QaEvalItem[];
  const results: EvalResult[] = [];

  for (const item of items) {
    const response = await answerQuestionForEval(item.question, {
      qaMode: cliOptions.qaMode,
      enableLlmQa: cliOptions.qaMode === "accuracy" ? true : undefined,
      queryExpansionConfig: cliOptions.qaMode === "accuracy"
        ? { enabled: true, timeoutMs: 12000, retryCount: 1, cacheEnabled: true }
        : undefined,
      debug: true,
      localSectionDocuments: item.scopeDocuments
    });
    results.push(evaluateItem(item, response));
  }

  for (const result of results) {
    printResult(result);
  }

  const passed = results.filter((result) => result.passed).length;
  const failed = results.length - passed;
  const passRate = results.length > 0 ? Math.round((passed / results.length) * 1000) / 10 : 0;
  const stats = summarizeEvalStats(results);
  console.log(`\nQA eval summary: ${passed}/${results.length} passed (${passRate}%), ${failed} failed.`);
  console.log(`mode: ${cliOptions.qaMode}`);
  console.log(`LLM coverage: ${stats.llmCoverage}/${results.length}; rerank: ${stats.rerankCount}; verifier: ${stats.verifierCount}; timeouts: ${stats.timeoutCount}.`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

function evaluateItem(item: QaEvalItem, response: Record<string, unknown>): EvalResult {
  const reasons: string[] = [];
  const answer = String(response.answer ?? "");
  const selected = selectedRecord(response);
  const codes = selectedHsCodes(response, selected);

  if (response.intent !== item.expectedIntent) {
    reasons.push(`expected intent ${item.expectedIntent}, got ${String(response.intent)}`);
  }
  if (item.expectedAnswerMode && response.answerMode !== item.expectedAnswerMode) {
    reasons.push(`expected answer mode ${item.expectedAnswerMode}, got ${String(response.answerMode)}`);
  }
  for (const expected of item.mustContainAll ?? []) {
    if (!answerIncludes(answer, expected)) {
      reasons.push(`answer must contain "${expected}"`);
    }
  }
  const any = item.mustContainAny ?? [];
  if (any.length > 0 && !any.some((expected) => answerIncludes(answer, expected))) {
    reasons.push(`answer must contain one of: ${any.join(", ")}`);
  }
  for (const forbidden of item.mustNotContain ?? []) {
    if (answerIncludes(answer, forbidden)) {
      reasons.push(`answer must not contain "${forbidden}"`);
    }
  }
  for (const code of item.expectedHsCodes ?? []) {
    if (!codes.includes(code) && !answer.includes(code)) {
      reasons.push(`expected HS code ${code}`);
    }
  }
  if (item.expectedDocument && selectedDocument(response, selected) !== item.expectedDocument) {
    reasons.push(`expected document ${item.expectedDocument}, got ${selectedDocument(response, selected) || "n/a"}`);
  }
  if (item.expectedTitleContains) {
    const title = String(selected?.title ?? "");
    if (!answerIncludes(title, item.expectedTitleContains) && !answerIncludes(answer, item.expectedTitleContains)) {
      reasons.push(`expected selected title/answer to contain ${item.expectedTitleContains}`);
    }
  }
  if (item.shouldNotCallLlm && response.llmCalled === true) {
    reasons.push("expected no LLM call");
  }
  if (item.fallbackForbidden && isFallbackAnswer(answer, response)) {
    reasons.push("answer must not be a generic fallback");
  }

  return { item, passed: reasons.length === 0, reasons, response };
}

function parseCliOptions(args: string[]): CliOptions {
  return {
    fixturePath: resolveFixturePath(args),
    qaMode: parseQaMode(args)
  };
}

function resolveFixturePath(args: string[]): string {
  const fixtureFlagIndex = args.findIndex((arg) => arg === "--fixture" || arg === "-f");
  const fixtureValue = fixtureFlagIndex >= 0 ? args[fixtureFlagIndex + 1] : undefined;
  const inlineFixture = args.find((arg) => arg.startsWith("--fixture="))?.slice("--fixture=".length);
  const requested = fixtureValue || inlineFixture || path.join("tests", "fixtures", "qa-eval.json");
  return path.resolve(process.cwd(), requested);
}

function parseQaMode(args: string[]): QaMode {
  const modeFlagIndex = args.findIndex((arg) => arg === "--qa-mode");
  const modeValue = modeFlagIndex >= 0 ? args[modeFlagIndex + 1] : undefined;
  const inlineMode = args.find((arg) => arg.startsWith("--qa-mode="))?.slice("--qa-mode=".length);
  const value = inlineMode || modeValue || "fast";
  if (value === "fast" || value === "accuracy") {
    return value;
  }
  throw new Error(`Invalid --qa-mode '${value}'. Expected fast or accuracy.`);
}

function summarizeEvalStats(results: EvalResult[]): {
  llmCoverage: number;
  rerankCount: number;
  verifierCount: number;
  timeoutCount: number;
} {
  let llmCoverage = 0;
  let rerankCount = 0;
  let verifierCount = 0;
  let timeoutCount = 0;
  for (const result of results) {
    const debug = debugRecord(result.response);
    const queryExpansion = typeof debug.queryExpansion === "object" && debug.queryExpansion !== null
      ? debug.queryExpansion as Record<string, unknown>
      : {};
    const usedLlm = result.response.llmCalled === true ||
      debug.llmRerankCalled === true ||
      debug.llmVerifierCalled === true ||
      queryExpansion.expansionSource === "llm";
    if (usedLlm) llmCoverage += 1;
    if (debug.llmRerankCalled === true) rerankCount += 1;
    if (debug.llmVerifierCalled === true) verifierCount += 1;
    if (
      result.response.llmErrorType === "timeout" ||
      debug.llmRerankErrorType === "timeout" ||
      debug.llmVerifierErrorType === "timeout" ||
      queryExpansion.timedOut === true
    ) {
      timeoutCount += 1;
    }
  }
  return { llmCoverage, rerankCount, verifierCount, timeoutCount };
}

function printResult(result: EvalResult): void {
  const selected = selectedRecord(result.response);
  const codes = selectedHsCodes(result.response, selected);
  console.log(`\n${result.passed ? "PASS" : "FAIL"} ${result.item.id}`);
  console.log(`question: ${result.item.question}`);
  console.log(`detected intent: ${String(result.response.intent ?? "unknown")}`);
  console.log(`answer: ${String(result.response.answer ?? "")}`);
  console.log(`selected document: ${selectedDocument(result.response, selected) || "n/a"}`);
  console.log(`selected title: ${String(selected?.title ?? "n/a")}`);
  console.log(`selected HS code(s): ${codes.join(", ") || "n/a"}`);
  if (result.reasons.length > 0) {
    console.log(`failure reason: ${result.reasons.join("; ")}`);
  }
}

function selectedRecord(response: Record<string, unknown>): Record<string, unknown> | null {
  const selectedPrimary = response.selectedPrimary;
  if (typeof selectedPrimary === "object" && selectedPrimary !== null) {
    return selectedPrimary as Record<string, unknown>;
  }
  const documentSummary = response.documentSummary;
  if (typeof documentSummary === "object" && documentSummary !== null) {
    return documentSummary as Record<string, unknown>;
  }
  return null;
}

function debugRecord(response: Record<string, unknown>): Record<string, unknown> {
  return typeof response.debug === "object" && response.debug !== null
    ? response.debug as Record<string, unknown>
    : {};
}

function selectedDocument(response: Record<string, unknown>, selected: Record<string, unknown> | null): string | null {
  if (typeof selected?.document === "string") return selected.document;
  if (!selected) return null;
  const documents = response.documents;
  return Array.isArray(documents) && typeof documents[0] === "string" ? documents[0] : null;
}

function selectedHsCodes(response: Record<string, unknown>, selected: Record<string, unknown> | null): string[] {
  const values = [
    ...(Array.isArray(selected?.groupedHsCodes) ? selected.groupedHsCodes : []),
    selected?.hsCode,
    ...retrievalCodes(response)
  ];
  return [...new Set(values.map((value) => typeof value === "string" ? value : "").filter(Boolean))];
}

function retrievalCodes(response: Record<string, unknown>): unknown[] {
  const retrieval = response.retrieval;
  if (typeof retrieval !== "object" || retrieval === null) return [];
  const finalHsCodes = (retrieval as { finalHsCodes?: unknown }).finalHsCodes;
  return Array.isArray(finalHsCodes) ? finalHsCodes : [];
}

function answerIncludes(value: string, expected: string): boolean {
  return value.toLowerCase().includes(expected.toLowerCase());
}

function isFallbackAnswer(answer: string, response: Record<string, unknown>): boolean {
  const fallbackReason = response.fallbackReason;
  return /chưa thể trích xuất|vui lòng thử lại|bật api key|thiếu nội dung chi tiết|not enough context/i.test(answer) ||
    (typeof fallbackReason === "string" && fallbackReason.trim().length > 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
