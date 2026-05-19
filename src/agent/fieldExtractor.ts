export type FieldExtractionConfidence = "high" | "medium" | "low";

export interface FieldExtractionResult {
  extractedText: string;
  matchedHeading: string | null;
  confidence: FieldExtractionConfidence;
  fallbackUsed: boolean;
}

interface FieldSynonymGroup {
  canonical: string;
  labels: string[];
}

export const FIELD_SYNONYM_GROUPS: FieldSynonymGroup[] = [
  {
    canonical: "appearance",
    labels: [
      "appearance",
      "external appearance",
      "visual appearance",
      "ngoai quan",
      "nhin ngoai",
      "trong nhu",
      "trong nhu nao",
      "look",
      "looks"
    ]
  },
  {
    canonical: "requirements",
    labels: [
      "requirement",
      "requirements",
      "required",
      "must",
      "need",
      "needs",
      "yeu cau",
      "can dap ung",
      "phai",
      "can gi"
    ]
  },
  {
    canonical: "activeness",
    labels: ["activeness", "activity", "active", "liveliness", "hoat dong", "linh hoat"]
  },
  {
    canonical: "weight and size",
    labels: ["weight and size", "weight", "size", "dimension", "dimensions", "trong luong", "kich thuoc"]
  },
  {
    canonical: "usage",
    labels: ["usage", "use", "uses", "purpose", "function", "cong dung", "muc dich", "su dung"]
  },
  {
    canonical: "definition",
    labels: ["definition", "define", "meaning", "means", "dinh nghia", "la gi"]
  },
  {
    canonical: "characteristics",
    labels: ["characteristic", "characteristics", "feature", "features", "dac diem", "tinh chat"]
  },
  {
    canonical: "condition",
    labels: ["condition", "state", "status", "quality", "dieu kien", "tinh trang", "trang thai"]
  },
  {
    canonical: "note",
    labels: ["note", "notes", "remark", "remarks", "chu thich", "ghi chu", "luu y"]
  },
  {
    canonical: "origin",
    labels: ["origin", "country of origin", "provenance", "xuat xu", "nguon goc", "nuoc xuat xu"]
  },
  {
    canonical: "composition",
    labels: ["composition", "ingredient", "ingredients", "material", "thanh phan", "chat lieu", "nguyen lieu"]
  },
  {
    canonical: "packaging",
    labels: ["packaging", "package", "container", "wrapping", "dong goi", "bao bi", "bao goi"]
  },
  {
    canonical: "color",
    labels: ["color", "colour", "hue", "shade", "mau sac", "mau"]
  },
  {
    canonical: "processing",
    labels: ["processing", "process", "method", "technique", "preparation", "che bien", "phuong phap", "ky thuat", "xu ly"]
  },
  {
    canonical: "classification",
    labels: ["classification", "category", "phan loai", "loai", "nhom"]
  }
];

const FIELD_STOPWORDS = new Set([
  "the",
  "and",
  "or",
  "on",
  "of",
  "for",
  "to",
  "a",
  "an",
  "general",
  "which",
  "what",
  "how",
  "nao",
  "gi",
  "nhung",
  "cac",
  "ve",
  "la",
  "co"
]);

interface HeadingBlock {
  heading: string;
  body: string;
}

export function extractRequestedField(sectionText: string, requestedField: string | null | undefined): FieldExtractionResult {
  const cleaned = normalizeSectionText(sectionText);
  const field = canonicalRequestedFieldFromText(requestedField ?? "") ?? normalizeDisplayText(requestedField ?? "");
  if (!cleaned || !field) {
    return {
      extractedText: "",
      matchedHeading: null,
      confidence: "low",
      fallbackUsed: true
    };
  }

  const headings = extractHeadingBlocks(cleaned);
  const bestHeading = bestScoredBlock(headings, field);
  if (bestHeading && bestHeading.score >= 0.58) {
    return {
      extractedText: normalizeDisplayText(bestHeading.block.body || bestHeading.block.heading),
      matchedHeading: bestHeading.block.heading,
      confidence: bestHeading.score >= 0.82 ? "high" : "medium",
      fallbackUsed: false
    };
  }

  const paragraphs = splitParagraphs(cleaned);
  const bestParagraph = bestScoredText(paragraphs, field);
  if (bestParagraph && bestParagraph.score >= 0.4) {
    return {
      extractedText: normalizeDisplayText(bestParagraph.text),
      matchedHeading: null,
      confidence: bestParagraph.score >= 0.72 ? "medium" : "low",
      fallbackUsed: true
    };
  }

  return {
    extractedText: "",
    matchedHeading: bestHeading?.block.heading ?? null,
    confidence: "low",
    fallbackUsed: true
  };
}

export function canonicalRequestedFieldFromText(value: string): string | null {
  const groups = detectFieldGroups(value);
  if (groups.includes("appearance") && groups.includes("requirements")) return "appearance requirements";
  if (groups.includes("weight and size")) return "weight and size";
  if (groups.includes("activeness")) return "activeness";
  if (groups.includes("usage")) return "usage";
  if (groups.includes("definition")) return "definition";
  if (groups.includes("characteristics")) return "characteristics";
  if (groups.includes("appearance")) return "appearance";
  if (groups.includes("requirements")) return "requirements";
  if (groups.includes("condition")) return "condition";
  if (groups.includes("note")) return "note";
  return null;
}

export function normalizeFieldText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractHeadingBlocks(sectionText: string): HeadingBlock[] {
  const blocks: HeadingBlock[] = [];
  let current: HeadingBlock | null = null;
  const headingReadyText = sectionText.includes("\n") ? sectionText : expandInlineFieldLabels(sectionText);
  const lines = headingReadyText
    .split(/\n+/g)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (isBoundaryLine(line)) {
      if (current) {
        blocks.push(current);
        current = null;
      }
      continue;
    }

    const heading = parseHeadingLine(line);
    if (heading) {
      if (current) {
        blocks.push(current);
      }
      current = {
        heading: heading.heading,
        body: heading.inlineText
      };
      continue;
    }

    if (current) {
      current.body = [current.body, normalizeBodyLine(line)].filter(Boolean).join(" ");
    }
  }

  if (current) {
    blocks.push(current);
  }
  return blocks;
}

function bestScoredBlock(blocks: HeadingBlock[], requestedField: string): { block: HeadingBlock; score: number } | null {
  let best: { block: HeadingBlock; score: number } | null = null;
  for (const block of blocks) {
    const score = scoreFieldMatch(block.heading, requestedField);
    if (!best || score > best.score) {
      best = { block, score };
    }
  }
  return best;
}

function bestScoredText(values: string[], requestedField: string): { text: string; score: number } | null {
  let best: { text: string; score: number } | null = null;
  for (const text of values) {
    const score = scoreFieldMatch(text, requestedField);
    if (!best || score > best.score) {
      best = { text, score };
    }
  }
  return best;
}

function scoreFieldMatch(candidateText: string, requestedField: string): number {
  const requestedGroups = detectFieldGroups(requestedField);
  const candidateGroups = detectFieldGroups(candidateText);
  const requestedTokens = meaningfulFieldTokens(requestedField);
  const candidateTokens = meaningfulFieldTokens(candidateText);
  const groupOverlap = requestedGroups.filter((group) => candidateGroups.includes(group)).length;
  const tokenOverlap = requestedTokens.filter((token) => candidateTokens.includes(token)).length;
  const groupScore = requestedGroups.length > 0 ? groupOverlap / requestedGroups.length : 0;
  const tokenScore = requestedTokens.length > 0 ? tokenOverlap / Math.min(requestedTokens.length, 4) : 0;
  return Math.min(1, groupScore * 0.78 + tokenScore * 0.22);
}

function detectFieldGroups(value: string): string[] {
  const normalized = normalizeFieldText(value);
  const tokens = new Set(meaningfulFieldTokens(value));
  const groups: string[] = [];

  for (const group of FIELD_SYNONYM_GROUPS) {
    if (group.labels.some((label) => phraseOrTokensMatch(normalized, tokens, label))) {
      groups.push(group.canonical);
    }
  }
  return uniqueStrings(groups);
}

function phraseOrTokensMatch(normalizedText: string, tokens: Set<string>, label: string): boolean {
  const normalizedLabel = normalizeFieldText(label);
  if (!normalizedLabel) return false;
  if (normalizedText.includes(normalizedLabel)) return true;
  const labelTokens = normalizedLabel.split(/[^a-z0-9]+/g).filter((token) => token.length >= 3);
  return labelTokens.length > 0 && labelTokens.every((token) => tokens.has(token));
}

function meaningfulFieldTokens(value: string): string[] {
  return uniqueStrings(normalizeFieldText(value)
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length >= 3)
    .filter((token) => !FIELD_STOPWORDS.has(token)));
}

function parseHeadingLine(line: string): { heading: string; inlineText: string } | null {
  const markdown = line.match(/^#{1,6}\s+(.+)$/);
  if (markdown) {
    return { heading: normalizeDisplayText(markdown[1]), inlineText: "" };
  }

  const numbered = line.match(/^(?:\d+(?:\.\d+)*[.)]?\s+)([^:]{3,100}):?\s*(.*)$/);
  if (numbered && isCompactLabel(numbered[1])) {
    return { heading: normalizeDisplayText(numbered[1]), inlineText: normalizeDisplayText(numbered[2] ?? "") };
  }

  const colon = line.match(/^([^:]{3,100}):\s*(.*)$/);
  if (colon && isCompactLabel(colon[1])) {
    return { heading: normalizeDisplayText(colon[1]), inlineText: normalizeDisplayText(colon[2] ?? "") };
  }

  if (isCompactLabel(line) && line.split(/\s+/g).length <= 6 && detectFieldGroups(line).length > 0) {
    return { heading: normalizeDisplayText(line), inlineText: "" };
  }

  return null;
}

function expandInlineFieldLabels(sectionText: string): string {
  const labels = FIELD_SYNONYM_GROUPS
    .flatMap((group) => group.labels)
    .filter((label) => label.length >= 5)
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExp)
    .join("|");
  if (!labels) {
    return sectionText;
  }
  const pattern = new RegExp(`\\b((?:general\\s+)?(?:${labels})(?:\\s+(?:requirements?|characteristics?|notes?))?)\\s*:`, "gi");
  return sectionText.replace(pattern, "\n$1:\n");
}

function splitParagraphs(sectionText: string): string[] {
  const paragraphs = sectionText
    .split(/\n{2,}|(?<=[.!?])\s+(?=[A-Z])/g)
    .map((part) => normalizeDisplayText(part))
    .filter((part) => part.length >= 12);
  return paragraphs.length > 0 ? paragraphs : [sectionText];
}

function normalizeSectionText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/!\[[^\]]*]\([^)]+\)/g, "")
    .replace(/^\*Caption:\s*[^*]+\*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeDisplayText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeBodyLine(value: string): string {
  return normalizeDisplayText(value.replace(/^[-*]\s+/, ""));
}

function isCompactLabel(value: string): boolean {
  const words = normalizeDisplayText(value).split(/\s+/g).filter(Boolean);
  return words.length > 0 && words.length <= 14 && value.length <= 100;
}

function isBoundaryLine(value: string): boolean {
  return /^(source|citation|page|section|chapter|hs\s*code)\b/i.test(value) ||
    /^#{1,6}\s*\d{4}\.\d{2}\.\d{2}\b/.test(value);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
