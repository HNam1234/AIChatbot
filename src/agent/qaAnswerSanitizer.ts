import { HS_CODE_PATTERN } from "./qaAnswerFormatter";

export function sanitizeFinalAnswer(answer: string, options: { stripHsCode?: boolean; maxWords?: number } = {}): string {
  const stripHsCode = options.stripHsCode ?? false;
  const lines = answer
    .replace(/<doc=[^>]+>/gi, " ")
    .replace(/```(?:json)?[\s\S]*?```/gi, " ")
    .split(/\r?\n/g)
    .filter((line) => !/^\s*(?:Index source|PageIndex(?: tree result)?|cache freshness|cache status|final score|candidate debug|raw JSON|backend logs?|Primary citation|Related citation|Citation card|Retrieval|Marker\s+\d+)\b/i.test(line))
    .join("\n");
  let cleaned = lines
    .replace(/\b(Index source|PageIndex(?: tree result)?|cache freshness|cache status|final score|candidate debug|raw JSON|backend logs?|Primary citation|Related citation|Citation card labels?|Retrieval):[\s\S]*$/gi, " ")
    .replace(/\{[\s\S]*"[^"]+"\s*:[\s\S]*\}/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (stripHsCode) {
    cleaned = cleaned.replace(/(?:^|\s)HS Code:\s*\d{4}\.\d{2}\.\d{2}\.?/gi, " ");
  }
  cleaned = removeDuplicateHsCodeSentences(cleaned)
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
  if (options.maxWords && cleaned.split(/\s+/).filter(Boolean).length > options.maxWords) {
    cleaned = cleaned.split(/\s+/).slice(0, options.maxWords).join(" ").replace(/[,\s]+$/g, "");
    cleaned = ensureSentence(cleaned);
  }
  return cleaned;
}

function removeDuplicateHsCodeSentences(answer: string): string {
  let collapsed = answer;
  const duplicateCodePattern = /\bHS Code:\s*(\d{4}\.\d{2}\.\d{2})\.\s+HS Code:\s*\1\./gi;
  while (duplicateCodePattern.test(collapsed)) {
    collapsed = collapsed.replace(duplicateCodePattern, "HS Code: $1.");
    duplicateCodePattern.lastIndex = 0;
  }
  const sentences = collapsed.match(/[^.!?\n]+[.!?]?|\n+/g) ?? [collapsed];
  const seenHsCodeSentences = new Set<string>();
  const kept: string[] = [];
  for (const sentence of sentences) {
    const codes = sentence.match(new RegExp(HS_CODE_PATTERN.source, "g")) ?? [];
    if (codes.length > 0 && /\bHS Code:/i.test(sentence)) {
      const key = uniqueStrings(codes).join("|");
      if (seenHsCodeSentences.has(key)) {
        continue;
      }
      seenHsCodeSentences.add(key);
    }
    kept.push(sentence);
  }
  return kept.join("").trim();
}

function ensureSentence(value: string): string {
  return /[.!?]$/.test(value.trim()) ? value.trim() : `${value.trim()}.`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
