export const IDK_ANSWER = "I don't know";

const PAGEINDEX_CITATION_RE = /<doc=[^>]+;page=\d+>/i;

export const SYSTEM_PROMPT = `You are a document-grounded assistant.
Use only the PageIndex-processed document content available through the scoped doc_id values.
Do not use outside knowledge, guesses, memory, assumptions, or general web knowledge.
If the answer is missing, ambiguous, or not directly supported by the documents, respond exactly:
${IDK_ANSWER}
For every factual claim that is supported, include PageIndex page citations when available.
Keep answers concise.`;

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export function buildMessages(question: string): ChatMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: question.trim() }
  ];
}

export function enforceGrounding(answer: string | undefined | null, requireCitation: boolean): string {
  const cleaned = (answer ?? "").trim();
  if (cleaned.length === 0) return IDK_ANSWER;
  if (cleaned.toLowerCase().replace(/[.\s]+$/g, "") === IDK_ANSWER.toLowerCase()) {
    return IDK_ANSWER;
  }
  if (requireCitation && !PAGEINDEX_CITATION_RE.test(cleaned)) {
    return IDK_ANSWER;
  }
  return cleaned;
}
