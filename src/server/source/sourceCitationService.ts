import path from "node:path";
import type { SourceCitationSection, SourceTextView } from "./types";

const SOURCE_EXCERPT_MAX_CHARS = 520;
const SOURCE_LINK_QUERY_MAX_CHARS = 360;
const SOURCE_SEARCH_STOPWORDS = new Set([
  "the",
  "and",
  "are",
  "for",
  "with",
  "what",
  "which",
  "define",
  "defined",
  "definition",
  "duoc",
  "dinh",
  "nghia",
  "gi",
  "la",
  "loai",
  "co",
  "ca",
  "phe",
  "more",
  "less",
  "than",
  "has",
  "have",
  "having",
  "compared",
  "compare",
  "cua",
  "cho",
  "thuoc",
  "trong",
  "mot",
  "cac"
]);

/**
 * Converts an internal retrieved section into the citation shape sent to the UI.
 *
 * The UI should not receive long raw section text by default. It only needs a
 * precise excerpt, a source URL that can highlight that excerpt, and PDF links.
 */
export function publicSectionCitation(section: SourceCitationSection): Record<string, unknown> {
  const sourceText = sourceTextFromSection(section);
  return {
    document: section.document,
    chapter: section.chapter,
    hsCode: section.hsCode ?? null,
    groupedHsCodes: section.groupedHsCodes ?? [],
    title: section.title ?? null,
    section: section.section ?? null,
    pageStart: section.pageStart ?? null,
    pageEnd: section.pageEnd ?? null,
    source: section.source ?? null,
    captions: section.captions,
    score: section.score,
    metadataWarnings: section.metadataWarnings,
    sourceExcerpt: bestSourceExcerpt(sourceText),
    ...pdfLinksForCitation(section.document, section.pageStart, section.pageEnd)
  };
}

/**
 * Adds PDF and exact-source links to a citation-like object.
 *
 * This keeps route handlers simple: they can pass selected candidates through
 * this function without knowing how source URLs or excerpts are constructed.
 */
export function withPdfCitationLinks<T extends Record<string, unknown> | null>(citation: T, answer?: string): T {
  if (!citation) {
    return citation;
  }
  const sourceText = sourceTextFromCitation(citation);
  const sourceExcerpt = bestSourceExcerpt(sourceText, answer);
  const publicCitation: Record<string, unknown> = { ...citation };
  delete publicCitation.sourceText;

  return {
    ...publicCitation,
    ...(sourceExcerpt ? { sourceExcerpt, sourceUrl: sourceUrlForCitation(citation, sourceExcerpt) } : {}),
    ...pdfLinksForCitation(citation.document, citation.pageStart, citation.pageEnd)
  } as T;
}

export function withPdfCitationLinksList(citations: Record<string, unknown>[], answer?: string): Record<string, unknown>[] {
  return citations.map((citation) => withPdfCitationLinks(citation, answer));
}

export function renderSourceTextHtml(view: SourceTextView): string {
  const page = view.page ? `Page ${view.page}` : "Page n/a";
  const sourceHeading = [view.hsCode, view.title || view.section].filter(Boolean).join(" - ") || "Source text";
  const pdfLink = view.page ? `${view.pdfUrl}#page=${view.page}` : view.pdfUrl;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(`${view.document} source`)}</title>
    <style>
      :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #17202a; background: #edf1f7; }
      body { margin: 0; padding: 24px; }
      main { max-width: 960px; margin: 0 auto; border: 1px solid #d7dee9; border-radius: 14px; background: #fff; box-shadow: 0 12px 28px rgba(39, 52, 68, 0.08); }
      header { display: grid; gap: 8px; padding: 18px 20px; border-bottom: 1px solid #d7dee9; }
      h1 { margin: 0; font-size: 20px; line-height: 1.25; }
      p { margin: 0; color: #627084; }
      a { color: #075850; font-weight: 800; }
      .meta { display: flex; flex-wrap: wrap; gap: 8px; font-size: 13px; }
      .meta span { border: 1px solid #d7dee9; border-radius: 999px; padding: 4px 9px; background: #f7f9fc; }
      pre { margin: 0; padding: 20px; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.6; font-size: 14px; }
      mark { background: #fff0a8; color: inherit; padding: 1px 2px; border-radius: 4px; }
      .notice { padding: 10px 20px; border-bottom: 1px solid #d7dee9; background: #fff8df; color: #664500; font-size: 13px; }
    </style>
  </head>
  <body>
    <main>
      <header>
        <h1>${escapeHtml(sourceHeading)}</h1>
        <div class="meta">
          <span>${escapeHtml(view.document)}</span>
          <span>${escapeHtml(page)}</span>
          ${view.section ? `<span>${escapeHtml(view.section)}</span>` : ""}
        </div>
        <p><a href="${escapeHtml(pdfLink)}" target="_blank" rel="noreferrer">Open PDF page</a></p>
      </header>
      ${view.query && !view.matchFound ? `<div class="notice">Exact source phrase was not found verbatim after normalization; showing the closest source section.</div>` : ""}
      <pre>${renderHighlightedSourceText(view.sourceText, view.query)}</pre>
    </main>
    <script>
      const hit = document.getElementById("source-hit");
      if (hit) hit.scrollIntoView({ block: "center" });
    </script>
  </body>
</html>`;
}

export function renderSourceErrorHtml(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>Source unavailable</title></head><body><h1>Source unavailable</h1><p>${escapeHtml(message)}</p></body></html>`;
}

export function renderHighlightedSourceText(sourceText: string, query: string): string {
  const normalizedQuery = normalizeSourceWhitespace(query).replace(/\.\.\.$/, "").trim();
  if (!normalizedQuery) {
    return escapeHtml(sourceText);
  }
  const exact = sourceText.toLowerCase().indexOf(normalizedQuery.toLowerCase());
  if (exact >= 0) {
    return [
      escapeHtml(sourceText.slice(0, exact)),
      `<mark id="source-hit">${escapeHtml(sourceText.slice(exact, exact + normalizedQuery.length))}</mark>`,
      escapeHtml(sourceText.slice(exact + normalizedQuery.length))
    ].join("");
  }
  const best = bestSourceExcerpt(sourceText, normalizedQuery);
  const bestIndex = best ? sourceText.toLowerCase().indexOf(best.replace(/\.\.\.$/, "").toLowerCase()) : -1;
  if (bestIndex >= 0) {
    return [
      escapeHtml(sourceText.slice(0, bestIndex)),
      `<mark id="source-hit">${escapeHtml(sourceText.slice(bestIndex, bestIndex + best.length))}</mark>`,
      escapeHtml(sourceText.slice(bestIndex + best.length))
    ].join("");
  }
  return `<mark id="source-hit">${escapeHtml(sourceText)}</mark>`;
}

export function sourceTextIncludesQuery(sourceText: string, query: string): boolean {
  return sourceText.toLowerCase().includes(normalizeSourceWhitespace(query).replace(/\.\.\.$/, "").trim().toLowerCase());
}

export function sourceTextFromSection(section: SourceCitationSection): string {
  return [
    section.section,
    section.title,
    section.text,
    section.textPreview,
    section.captions?.join(" ")
  ].filter(Boolean).join("\n\n").trim();
}

export function sourceScoringTokens(text: string): string[] {
  return uniqueStrings(normalizeSearchText(text)
    .split(/[^a-z0-9.]+/g)
    .map(normalizeSearchToken)
    .filter((token) => token.length >= 3 && !SOURCE_SEARCH_STOPWORDS.has(token)));
}

export function normalizeSourceWhitespace(value: string): string {
  return String(value || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/!\[([^\]]*)]\([^)]+\)/g, "$1")
    .replace(/\*Caption:\s*([^*]+)\*/gi, "Caption: $1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function pdfUrlForDocument(documentValue: unknown): string | undefined {
  const document = stringValue(documentValue);
  if (!document) {
    return undefined;
  }
  const fileName = safeRequestedPdfName(path.basename(document));
  return fileName ? `/api/uploads/${encodeURIComponent(fileName)}` : undefined;
}

function sourceTextFromCitation(citation: Record<string, unknown>): string {
  const captions = Array.isArray(citation.captions) ? citation.captions.map(String).join(" ") : "";
  return [
    stringValue(citation.sourceText),
    stringValue(citation.sourceExcerpt),
    stringValue(citation.section),
    stringValue(citation.title),
    stringValue(citation.text),
    stringValue(citation.textPreview),
    captions
  ].filter(Boolean).join("\n\n").trim();
}

function sourceUrlForCitation(citation: Record<string, unknown>, sourceExcerpt: string): string | undefined {
  const document = stringValue(citation.document);
  const fileName = document ? safeRequestedPdfName(path.basename(document)) : undefined;
  if (!fileName) {
    return undefined;
  }
  const params = new URLSearchParams();
  const page = citationPageNumber(citation.pageStart, citation.pageEnd);
  const hsCode = stringValue(citation.hsCode);
  const section = stringValue(citation.section);
  if (page) params.set("page", String(page));
  if (hsCode) params.set("hsCode", hsCode);
  if (section) params.set("section", truncateSourceText(section, 180));
  if (sourceExcerpt) params.set("q", truncateSourceText(sourceExcerpt, SOURCE_LINK_QUERY_MAX_CHARS));
  const query = params.toString();
  return `/api/source/${encodeURIComponent(fileName)}${query ? `?${query}` : ""}#source-hit`;
}

function bestSourceExcerpt(sourceText: string, answer?: string): string {
  const cleaned = normalizeSourceWhitespace(sourceText);
  if (!cleaned) {
    return "";
  }
  const exactAnswerPhrase = answer ? bestExactAnswerPhrase(cleaned, answer) : "";
  if (exactAnswerPhrase) {
    return truncateSourceText(exactAnswerPhrase, SOURCE_EXCERPT_MAX_CHARS);
  }
  const chunks = splitSourceChunks(cleaned);
  if (!answer?.trim() || chunks.length === 0) {
    return truncateSourceText(chunks[0] ?? cleaned, SOURCE_EXCERPT_MAX_CHARS);
  }
  const answerTokens = sourceScoringTokens(answer);
  if (answerTokens.length === 0) {
    return truncateSourceText(chunks[0] ?? cleaned, SOURCE_EXCERPT_MAX_CHARS);
  }
  const best = chunks
    .map((text, index) => ({
      text,
      index,
      score: sourceScoringTokens(text).filter((token) => answerTokens.includes(token)).length
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)[0];
  return truncateSourceText(best?.text || chunks[0] || cleaned, SOURCE_EXCERPT_MAX_CHARS);
}

function bestExactAnswerPhrase(sourceText: string, answer: string): string {
  const source = sourceText.toLowerCase();
  return splitSourceChunks(answer)
    .map((chunk) => normalizeSourceWhitespace(chunk))
    .filter((chunk) => chunk.length >= 24 && source.includes(chunk.toLowerCase()))
    .sort((left, right) => right.length - left.length)[0] ?? "";
}

function splitSourceChunks(text: string): string[] {
  const chunks = text
    .replace(/\s+(?=(?:Appearance|Usage|Definition|General requirements|Activeness|Weight and size|Source|HS Code)\s*:)/gi, "\n")
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9])/g)
    .map((chunk) => normalizeSourceWhitespace(chunk))
    .filter((chunk) => chunk.length >= 12);
  return chunks.length > 0 ? chunks : [text];
}

function truncateSourceText(value: string, maxChars: number): string {
  const text = normalizeSourceWhitespace(value);
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars).replace(/\s+\S*$/g, "").trim()}...`;
}

function pdfLinksForCitation(documentValue: unknown, pageStartValue?: unknown, pageEndValue?: unknown): Record<string, unknown> {
  const pdfUrl = pdfUrlForDocument(documentValue);
  if (!pdfUrl) {
    return {};
  }
  const page = citationPageNumber(pageStartValue, pageEndValue);
  return {
    pdfUrl,
    ...(page ? { pdfPageUrl: `${pdfUrl}#page=${page}` } : {})
  };
}

function citationPageNumber(pageStartValue: unknown, pageEndValue?: unknown): number | undefined {
  const pageStart = Number(pageStartValue);
  if (Number.isFinite(pageStart) && pageStart > 0) {
    return pageStart;
  }
  const pageEnd = Number(pageEndValue);
  return Number.isFinite(pageEnd) && pageEnd > 0 ? pageEnd : undefined;
}

function safeRequestedPdfName(fileName: string): string | undefined {
  if (fileName !== path.basename(fileName) || path.extname(fileName).toLowerCase() !== ".pdf") {
    return undefined;
  }
  return fileName;
}

function normalizeSearchText(text: string): string {
  return text
    .replace(/[\u0111\u0110]/g, "d")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\bca\s+phe\b/g, "coffee")
    .replace(/\bwoodchips\b/g, "wood chips");
}

function normalizeSearchToken(token: string): string {
  if (token === "higher" || token === "highest") return "high";
  if (token === "lower" || token === "lowest") return "low";
  if (token === "larger" || token === "largest") return "large";
  if (token === "longer" || token === "longest") return "long";
  if (token === "rounder") return "round";
  if (token === "coarser") return "coarse";
  if (token === "smoother") return "smooth";
  if (token === "dried" || token === "drier") return "dry";
  return token;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
