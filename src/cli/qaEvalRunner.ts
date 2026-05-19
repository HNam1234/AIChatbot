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
  expectedHsCodes?: string[];
  expectedDocument?: string | null;
  expectedTitleContains?: string | null;
}

interface EvalResult {
  item: QaEvalItem;
  passed: boolean;
  reasons: string[];
  response: Record<string, unknown>;
}

async function main(): Promise<void> {
  process.env.QA_EVAL_QUIET = "1";
  const fixturePath = path.resolve(process.cwd(), "tests", "fixtures", "qa-eval.json");
  const items = JSON.parse(await readFile(fixturePath, "utf8")) as QaEvalItem[];
  const results: EvalResult[] = [];

  for (const item of items) {
    const response = await answerQuestionForEval(item.question, {
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
  console.log(`\nQA eval summary: ${passed}/${results.length} passed, ${failed} failed.`);
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

  return { item, passed: reasons.length === 0, reasons, response };
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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
