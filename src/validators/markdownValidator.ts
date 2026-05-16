import { existsSync } from "node:fs";

import type { ParsedBlock, ValidationMarkerResult, ValidationReport } from "../types";

export class MarkdownValidator {
  /**
   * Gatekeeper for Milestone 1. Returns true only when all acceptance markers pass.
   */
  public static validatePhase1(markdownText: string, parsedBlocks: ParsedBlock[]): boolean {
    const report = this.validatePhase1Detailed(markdownText, parsedBlocks);

    if (!report.passed) {
      console.error(`[MILESTONE 1 FAILED]\n${report.errors.join("\n")}`);
    } else {
      console.log("[MILESTONE 1 PASSED] Technical and semantic quality is PageIndex-ready for Milestone 2.");
    }

    return report.passed;
  }

  public static validatePhase1Detailed(markdownText: string, parsedBlocks: ParsedBlock[]): ValidationReport {
    const markers: ValidationMarkerResult[] = [
      validateHeaders(markdownText),
      validateTables(markdownText),
      validateVisualCaptionLinks(parsedBlocks),
      validateHSCodeOrder(markdownText, parsedBlocks),
      validateHSCodeTitlePairing(markdownText, parsedBlocks),
      validateMissingHSCodeSections(markdownText, parsedBlocks),
      validateCaptionSourceLeakage(markdownText),
      validateCaptionOverFusion(markdownText),
      validateImageAssetLinks(markdownText, parsedBlocks)
    ];
    const errors = markers.filter((marker) => !marker.passed).map((marker) => marker.message);

    return {
      passed: errors.length === 0,
      markers,
      errors
    };
  }
}

function validateHeaders(markdownText: string): ValidationMarkerResult {
  const headerRegex = /^(#{1,6})\s+.+$/gm;
  const headers = markdownText.match(headerRegex) ?? [];

  if (headers.length === 0) {
    return {
      marker: "MARKER 1",
      passed: false,
      message:
        "[Marker 1 Failed] Missing Headers: Markdown has no H1-H6 hierarchy, so PageIndex cannot build a TOC tree."
    };
  }

  return {
    marker: "MARKER 1",
    passed: true,
    message: "[Marker 1 Passed] Header hierarchy is present.",
    details: { headerCount: headers.length }
  };
}

function validateTables(markdownText: string): ValidationMarkerResult {
  const tables = extractMarkdownTables(markdownText);

  for (const [tableIndex, table] of tables.entries()) {
    const rows = table.map(parseTableRow);
    const separatorIndex = rows.findIndex(isSeparatorCells);
    if (separatorIndex === -1) {
      continue;
    }

    const expectedColumns = rows[separatorIndex].length;
    const brokenRowIndex = rows.findIndex((row) => row.length !== expectedColumns);
    if (brokenRowIndex !== -1) {
      return {
        marker: "MARKER 2",
        passed: false,
        message: `[Marker 2 Failed] Broken Table: table ${tableIndex + 1}, row ${
          brokenRowIndex + 1
        } has ${rows[brokenRowIndex].length} columns; expected ${expectedColumns}.`,
        details: {
          tableIndex,
          rowIndex: brokenRowIndex,
          expectedColumns,
          actualColumns: rows[brokenRowIndex].length
        }
      };
    }
  }

  return {
    marker: "MARKER 2",
    passed: true,
    message: "[Marker 2 Passed] Markdown tables have consistent column counts.",
    details: { tableCount: tables.length }
  };
}

function validateVisualCaptionLinks(parsedBlocks: ParsedBlock[]): ValidationMarkerResult {
  const imageBlocks = parsedBlocks.filter(
    (block) =>
      block.type === "image" &&
      block.metadata?.duplicateOf === undefined &&
      block.metadata?.decorative !== true
  );
  const orphanImages = imageBlocks.filter((block) => block.captionLinked !== true);
  const allowedOrphans = imageBlocks.length * 0.05;

  if (orphanImages.length > allowedOrphans) {
    return {
      marker: "MARKER 3",
      passed: false,
      message:
        "[Marker 3 Failed] Caption Association: too many non-decorative images/diagrams are not mapped to nearby captions or spatial annotations.",
      details: {
        imageCount: imageBlocks.length,
        orphanImageCount: orphanImages.length,
        allowedOrphans,
        orphanImageIds: orphanImages.map((block) => block.id),
        orphanImages: orphanImages.map((block) => ({
          id: block.id,
          pageNumber: block.pageNumber,
          bbox: block.bbox,
          areaRatio: block.metadata?.areaRatio,
          width: block.metadata?.width,
          height: block.metadata?.height
        }))
      }
    };
  }

  return {
    marker: "MARKER 3",
    passed: true,
    message: "[Marker 3 Passed] Visual-caption linkage is within tolerance.",
    details: {
      imageCount: imageBlocks.length,
      orphanImageCount: orphanImages.length,
      allowedOrphans
    }
  };
}

function validateHSCodeOrder(markdownText: string, parsedBlocks: ParsedBlock[]): ValidationMarkerResult {
  const markdownSections = extractMarkdownHSCodeSections(markdownText);
  const layoutSections = extractLayoutHSCodeSections(parsedBlocks);

  if (layoutSections.length === 0 && markdownSections.length === 0) {
    return {
      marker: "MARKER 4",
      passed: true,
      message: "[Marker 4 Passed] No HS Code sections detected; order check skipped.",
      details: { markdownHSCodes: [], layoutHSCodes: [] }
    };
  }

  const firstChapterIndex = markdownText.search(/^#\s+CHAPTER\s+\d+/im);
  const firstHSIndex = markdownText.search(/^##\s+\d{4}\.\d{2}\.\d{2}\b/im);
  if (firstHSIndex !== -1 && (firstChapterIndex === -1 || firstChapterIndex > firstHSIndex)) {
    return {
      marker: "MARKER 4",
      passed: false,
      message: "[Marker 4 Failed] CHAPTER is missing or appears after the first HS Code heading.",
      details: { firstChapterIndex, firstHSIndex }
    };
  }

  const markdownCodes = markdownSections.map((section) => section.hs);
  const layoutCodes = layoutSections.map((section) => section.hs);
  if (!sameStringArray(markdownCodes, layoutCodes)) {
    return {
      marker: "MARKER 4",
      passed: false,
      message: "[Marker 4 Failed] HS Code order in Markdown diverges from the layout source.",
      details: { markdownHSCodes: markdownCodes, layoutHSCodes: layoutCodes }
    };
  }

  return {
    marker: "MARKER 4",
    passed: true,
    message: "[Marker 4 Passed] CHAPTER and HS Code order match the layout source.",
    details: { markdownHSCodes: markdownCodes, layoutHSCodes: layoutCodes }
  };
}

function validateHSCodeTitlePairing(markdownText: string, parsedBlocks: ParsedBlock[]): ValidationMarkerResult {
  const markdownSections = extractMarkdownHSCodeSections(markdownText);
  const layoutSections = extractLayoutHSCodeSections(parsedBlocks);
  const brokenPairs: Array<Record<string, unknown>> = [];
  const unpairedHsCodes: UnpairedHSCodeDiagnostic[] = [];
  let directPairCount = 0;
  let groupedPairCount = 0;

  for (const [sectionIndex, layoutSection] of layoutSections.entries()) {
    const markdownSection = markdownSections[sectionIndex];
    const knownTitle = KNOWN_HS_TITLE_REGRESSIONS[layoutSection.hs];
    const expectedTitle = knownTitle ?? layoutSection.title;
    const parsedTitle = markdownSection?.title ?? "";
    let reason: string | undefined;

    if (!markdownSection) {
      reason = "missing-markdown-heading";
    } else if (markdownSection.hs !== layoutSection.hs) {
      reason = "hs-code-order-mismatch";
    } else if (!expectedTitle) {
      reason = layoutSection.reason ?? "missing-layout-title";
    } else if (!parsedTitle) {
      reason = "missing-markdown-title";
    } else if (normalizeComparableText(parsedTitle) !== normalizeComparableText(expectedTitle)) {
      reason = knownTitle ? "known-regression-mismatch" : "title-mismatch";
    }

    if (reason) {
      const diagnostic: UnpairedHSCodeDiagnostic = {
        hsCode: layoutSection.hs,
        pageNumber: layoutSection.pageNumber,
        blockId: layoutSection.blockId,
        nearestTextBefore: layoutSection.nearestTextBefore ?? "",
        nearestTextAfter: layoutSection.nearestTextAfter ?? "",
        reason
      };
      unpairedHsCodes.push(diagnostic);
      brokenPairs.push({
        hsCode: layoutSection.hs,
        parsedTitle,
        expectedTitle,
        pageNumber: layoutSection.pageNumber,
        blockId: layoutSection.blockId,
        nearestTextBefore: diagnostic.nearestTextBefore,
        nearestTextAfter: diagnostic.nearestTextAfter,
        pairingKind: layoutSection.pairingKind,
        groupCodes: layoutSection.groupCodes,
        reason
      });
    } else {
      if (layoutSection.pairingKind === "grouped") {
        groupedPairCount += 1;
      } else {
        directPairCount += 1;
      }
    }
  }

  const pairedHSCodeCount = directPairCount + groupedPairCount;
  if (pairedHSCodeCount !== layoutSections.length || brokenPairs.length > 0) {
    return {
      marker: "MARKER 5",
      passed: false,
      message: `[Marker 5 Failed] Paired HS Codes (${pairedHSCodeCount}) do not match layout HS Code count (${layoutSections.length}).`,
      details: {
        layoutHSCodeCount: layoutSections.length,
        directPairCount,
        groupedPairCount,
        pairedHSCodeCount,
        pairCount: pairedHSCodeCount,
        unpairedHsCodes,
        brokenPairs
      }
    };
  }

  return {
    marker: "MARKER 5",
    passed: true,
    message: `[Marker 5 Passed] HS Code-title headings are intact (${pairedHSCodeCount}/${layoutSections.length} paired).`,
    details: {
      layoutHSCodeCount: layoutSections.length,
      directPairCount,
      groupedPairCount,
      pairedHSCodeCount,
      pairCount: pairedHSCodeCount,
      unpairedHsCodes
    }
  };
}

function validateMissingHSCodeSections(markdownText: string, parsedBlocks: ParsedBlock[]): ValidationMarkerResult {
  const markdownCodes = new Set(extractMarkdownHSCodeSections(markdownText).map((section) => section.hs));
  const layoutCodes = extractLayoutHSCodeSections(parsedBlocks).map((section) => section.hs);
  const missingCodes = layoutCodes.filter((hs) => !markdownCodes.has(hs));

  if (missingCodes.length > 0) {
    return {
      marker: "MARKER 6",
      passed: false,
      message: `[Marker 6 Failed] Missing rendered HS Code sections: ${missingCodes.join(", ")}.`,
      details: { missingCodes }
    };
  }

  return {
    marker: "MARKER 6",
    passed: true,
    message: "[Marker 6 Passed] No HS Code sections were dropped during Markdown reconstruction.",
    details: { layoutHSCodeCount: layoutCodes.length, markdownHSCodeCount: markdownCodes.size }
  };
}

function validateCaptionSourceLeakage(markdownText: string): ValidationMarkerResult {
  const leakedCaptions = extractMarkdownCaptions(markdownText).filter((caption) => /\(Source:/i.test(caption));

  if (leakedCaptions.length > 0) {
    return {
      marker: "MARKER 7",
      passed: false,
      message: `[Marker 7 Failed] Source leakage detected in image captions: ${previewList(leakedCaptions)}.`,
      details: { leakedCaptions }
    };
  }

  return {
    marker: "MARKER 7",
    passed: true,
    message: "[Marker 7 Passed] Source lines are not fused into image captions.",
    details: { captionCount: extractMarkdownCaptions(markdownText).length }
  };
}

function validateCaptionOverFusion(markdownText: string): ValidationMarkerResult {
  const overFusedCaptions = extractMarkdownCaptions(markdownText).filter(
    (caption) => /\d{4}\.\d{2}\.\d{2}/.test(caption) || wordCount(caption) > 25
  );

  if (overFusedCaptions.length > 0) {
    return {
      marker: "MARKER 8",
      passed: false,
      message: `[Marker 8 Failed] Caption over-fusion detected: ${previewList(overFusedCaptions)}.`,
      details: { overFusedCaptions }
    };
  }

  return {
    marker: "MARKER 8",
    passed: true,
    message: "[Marker 8 Passed] Captions do not contain HS Codes or oversized paragraphs.",
    details: { captionCount: extractMarkdownCaptions(markdownText).length }
  };
}

function validateImageAssetLinks(markdownText: string, parsedBlocks: ParsedBlock[]): ValidationMarkerResult {
  const imageLinks = extractMarkdownImageLinks(markdownText);
  const imagesWithAssets = parsedBlocks.filter(
    (block) => block.type === "image" && typeof block.metadata?.assetPath === "string"
  );
  const assetExportEnabled = imageLinks.length > 0 || imagesWithAssets.length > 0;

  if (!assetExportEnabled) {
    return {
      marker: "MARKER 9",
      passed: true,
      message: "[Marker 9 Passed] Image asset export is not enabled; asset link check skipped.",
      details: { imageLinkCount: 0, assetImageCount: 0 }
    };
  }

  const assetPathToAbsolute = new Map<string, string>();
  for (const image of imagesWithAssets) {
    const assetPath = String(image.metadata?.assetPath ?? "");
    const absolutePath = String(image.metadata?.assetAbsolutePath ?? "");
    if (assetPath && absolutePath) {
      assetPathToAbsolute.set(normalizeMarkdownPath(assetPath), absolutePath);
    }
  }

  const brokenLinks = imageLinks
    .map((link) => ({
      ...link,
      absolutePath: assetPathToAbsolute.get(normalizeMarkdownPath(link.path))
    }))
    .filter((link) => !link.absolutePath || !existsSync(link.absolutePath));

  const includedImageIds = extractMarkdownImageIds(markdownText);
  const imageById = new Map(parsedBlocks.map((block) => [block.id, block]));
  const missingAssetBlocks = includedImageIds
    .map((id) => imageById.get(id))
    .filter((block): block is ParsedBlock => Boolean(block))
    .filter((block) => {
      if (block.type !== "image" || block.metadata?.decorative === true || block.metadata?.duplicateOf !== undefined) {
        return false;
      }

      return typeof block.metadata?.assetPath !== "string" || !block.metadata.assetPath;
    })
    .map((block) => block.id);

  if (brokenLinks.length > 0 || missingAssetBlocks.length > 0) {
    return {
      marker: "MARKER 9",
      passed: false,
      message: "[Marker 9 Failed] Broken Markdown image asset links or missing image asset metadata.",
      details: {
        brokenLinks,
        missingAssetBlockIds: missingAssetBlocks,
        imageLinkCount: imageLinks.length,
        assetImageCount: imagesWithAssets.length
      }
    };
  }

  return {
    marker: "MARKER 9",
    passed: true,
    message: "[Marker 9 Passed] Markdown image links resolve to exported local assets.",
    details: {
      imageLinkCount: imageLinks.length,
      assetImageCount: imagesWithAssets.length
    }
  };
}

interface HSCodeSection {
  hs: string;
  title: string;
  pageNumber?: number;
  blockId?: string;
  lineIndex?: number;
  reason?: string;
  groupSize: number;
  pairingKind: "direct" | "grouped";
  groupCodes: string[];
  nearestTextBefore?: string;
  nearestTextAfter?: string;
}

interface TextLineRef {
  block: ParsedBlock;
  lineIndex: number;
  text: string;
  y0: number;
  y1: number;
  x0: number;
  x1: number;
}

interface HSCodeLineParse {
  codes: string[];
  trailingText: string;
}

interface HSCodeGroup {
  codes: string[];
  codeLines: TextLineRef[];
  inlineTitle: string;
  inlineTitleLine?: TextLineRef;
  titleCandidateLines: TextLineRef[];
}

interface UnpairedHSCodeDiagnostic {
  hsCode: string;
  pageNumber?: number;
  blockId?: string;
  nearestTextBefore: string;
  nearestTextAfter: string;
  reason: string;
}

const HS_CODE_PATTERN = "\\d{4}\\.\\d{2}\\.\\d{2}";
const HS_CODE_REGEX = new RegExp(`^(${HS_CODE_PATTERN})\\b\\s*(.*)$`);

const KNOWN_HS_TITLE_REGRESSIONS: Record<string, string> = {
  "0701.90.10": "CHIPPING POTATOES",
  "0704.90.10": "ROUND (DRUMHEAD) CABBAGES",
  "0704.90.20": "CHINESE MUSTARD",
  "0708.20.10": "FRENCH BEANS",
  "1207.10.10": "PALM NUTS SUITABLE FOR SOWING/PLANTING",
  "1211.90.13": "RAUWOLFIA SERPENTINA ROOTS",
  "1211.90.95": "AGARWOOD (GAHARU) CHIPS",
  "1211.90.97": "BARK OF PERSEA (PERSEA KURZII KOSTERM)",
  "1212.21.11": "EUCHEUMA SPINOSUM",
  "1212.21.12": "EUCHEUMA COTTONII",
  "1212.99.10": "STONES AND KERNELS OF APRICOT, PEACH (INCLUDING NECTARINE) OR PLUM"
};

function extractMarkdownHSCodeSections(markdownText: string): HSCodeSection[] {
  const sections: HSCodeSection[] = [];
  const regex = /^##\s+(\d{4}\.\d{2}\.\d{2})\b(?:\s+(?:—|-|â€”)\s*(.+?))?\s*$/gm;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(markdownText)) !== null) {
    sections.push({
      hs: match[1],
      title: cleanInlineText(match[2] ?? ""),
      groupSize: 1,
      pairingKind: "direct",
      groupCodes: [match[1]],
      nearestTextBefore: "",
      nearestTextAfter: ""
    });
  }

  return sections;
}

function extractLayoutHSCodeSections(parsedBlocks: ParsedBlock[]): HSCodeSection[] {
  const sections: HSCodeSection[] = [];
  const textBlocks = parsedBlocks
    .filter((block) => block.source === "layout" && block.type === "text" && block.text)
    .sort(compareReadingOrder);
  const tableBlocks = parsedBlocks.filter(isReliableTableBlock);
  const allTextLines = textBlocks.flatMap(textLineRefs);
  const consumedLineKeys = new Set<string>();

  for (let blockIndex = 0; blockIndex < textBlocks.length; blockIndex += 1) {
    const block = textBlocks[blockIndex];
    const lines = textLineRefs(block);
    for (const line of lines) {
      const lineKey = textLineKey(line);
      if (consumedLineKeys.has(lineKey)) {
        continue;
      }

      const parsed = parseHSCodeLine(line.text);
      if (!parsed) {
        continue;
      }

      const followingLines = collectLayoutTitleSearchLines(block, line.lineIndex, textBlocks.slice(blockIndex + 1));
      const group = collectHSCodeGroup(line, parsed, followingLines);
      const title = selectLayoutTitleForHSCodeGroup(group, tableBlocks);
      const pairingKind = group.codes.length > 1 ? "grouped" : "direct";
      const context = nearestLayoutText(group.codeLines, allTextLines);

      for (const codeLine of group.codeLines) {
        consumedLineKeys.add(textLineKey(codeLine));
      }

      for (const code of group.codes) {
        sections.push({
          hs: code,
          title: title.title,
          pageNumber: line.block.pageNumber,
          blockId: line.block.id,
          lineIndex: line.lineIndex,
          reason: title.reason,
          groupSize: group.codes.length,
          pairingKind,
          groupCodes: group.codes,
          nearestTextBefore: context.before,
          nearestTextAfter: context.after
        });
      }
    }
  }

  return sections;
}

function collectHSCodeGroup(
  firstLine: TextLineRef,
  firstParse: HSCodeLineParse,
  followingLines: TextLineRef[]
): HSCodeGroup {
  const codes = [...firstParse.codes];
  const codeLines = [firstLine];
  let inlineTitle = firstParse.trailingText;
  let inlineTitleLine: TextLineRef | undefined = inlineTitle ? firstLine : undefined;
  let cursor = 0;

  if (!inlineTitle) {
    while (cursor < followingLines.length) {
      const candidate = followingLines[cursor];
      const parsed = parseHSCodeLine(candidate.text);
      if (!parsed) {
        break;
      }
      if (!isAdjacentHSCodeLine(codeLines[codeLines.length - 1], candidate)) {
        break;
      }

      codes.push(...parsed.codes);
      codeLines.push(candidate);
      cursor += 1;

      if (parsed.trailingText) {
        inlineTitle = parsed.trailingText;
        inlineTitleLine = candidate;
        break;
      }
    }
  }

  return {
    codes,
    codeLines,
    inlineTitle,
    inlineTitleLine,
    titleCandidateLines: followingLines.slice(cursor)
  };
}

function selectLayoutTitleForHSCodeGroup(
  group: HSCodeGroup,
  tableBlocks: ParsedBlock[]
): { title: string; reason?: string } {
  const selectedLines: TextLineRef[] = [];
  const hsLine = group.codeLines[group.codeLines.length - 1];

  if (
    group.inlineTitle.trim() &&
    group.inlineTitleLine &&
    isValidTitleLine(group.inlineTitle, group.inlineTitleLine, tableBlocks)
  ) {
    selectedLines.push({
      ...group.inlineTitleLine,
      text: cleanInlineText(group.inlineTitle)
    });
  }

  for (const candidate of group.titleCandidateLines) {
    if (parseHSCodeLine(candidate.text)) {
      break;
    }

    if (selectedLines.length === 0) {
      if (distanceFromHSLine(hsLine, candidate) > 140) {
        break;
      }
      if (!isValidTitleLine(candidate.text, candidate, tableBlocks)) {
        if (isRejectedTitleBoundary(candidate.text) || isBodyLikeLine(candidate.text)) {
          break;
        }
        continue;
      }
      selectedLines.push(candidate);
      continue;
    }

    const previous = selectedLines[selectedLines.length - 1];
    if (!isValidTitleLine(candidate.text, candidate, tableBlocks) || candidate.y0 - previous.y1 > 30) {
      break;
    }
    selectedLines.push(candidate);
  }

  if (selectedLines.length === 0) {
    return { title: "", reason: "missing-or-suspicious-title" };
  }

  return { title: cleanInlineText(selectedLines.map((line) => line.text).join(" ")) };
}

function collectLayoutTitleSearchLines(
  currentBlock: ParsedBlock,
  hsLineIndex: number,
  nextBlocks: ParsedBlock[]
): TextLineRef[] {
  return [
    ...textLineRefs(currentBlock).filter((line) => line.lineIndex > hsLineIndex),
    ...nextBlocks.filter((block) => !isPageNumberBlock(block)).flatMap(textLineRefs)
  ];
}

function parseHSCodeLine(text: string): HSCodeLineParse | undefined {
  let rest = cleanInlineText(text);
  const codes: string[] = [];

  while (rest.length > 0) {
    const match = rest.match(HS_CODE_REGEX);
    if (!match || !rest.startsWith(match[1])) {
      break;
    }

    codes.push(match[1]);
    rest = cleanInlineText(match[2] ?? "");
  }

  if (codes.length === 0) {
    return undefined;
  }

  return {
    codes,
    trailingText: rest
  };
}

function isAdjacentHSCodeLine(previous: TextLineRef, candidate: TextLineRef): boolean {
  if (previous.block.pageNumber !== candidate.block.pageNumber) {
    return false;
  }

  return candidate.y0 - previous.y1 <= 45;
}

function textLineKey(line: TextLineRef): string {
  return `${line.block.id}:${line.lineIndex}`;
}

function nearestLayoutText(
  codeLines: TextLineRef[],
  allTextLines: TextLineRef[]
): { before: string; after: string } {
  const codeLineKeys = new Set(codeLines.map(textLineKey));
  const sortedCodeIndexes = codeLines
    .map((line) => allTextLines.findIndex((candidate) => textLineKey(candidate) === textLineKey(line)))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right);
  const firstIndex = sortedCodeIndexes[0] ?? -1;
  const lastIndex = sortedCodeIndexes[sortedCodeIndexes.length - 1] ?? firstIndex;

  return {
    before: nearestTextBefore(firstIndex, allTextLines, codeLineKeys),
    after: nearestTextAfter(lastIndex, allTextLines, codeLineKeys)
  };
}

function nearestTextBefore(index: number, allTextLines: TextLineRef[], excludedKeys: Set<string>): string {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const line = allTextLines[cursor];
    if (!line || excludedKeys.has(textLineKey(line)) || isPageNumberBlock(line.block)) {
      continue;
    }

    const text = diagnosticText(line.text);
    if (text) {
      return text;
    }
  }

  return "";
}

function nearestTextAfter(index: number, allTextLines: TextLineRef[], excludedKeys: Set<string>): string {
  for (let cursor = index + 1; cursor < allTextLines.length; cursor += 1) {
    const line = allTextLines[cursor];
    if (!line || excludedKeys.has(textLineKey(line)) || isPageNumberBlock(line.block)) {
      continue;
    }

    const text = diagnosticText(line.text);
    if (text) {
      return text;
    }
  }

  return "";
}

function diagnosticText(text: string): string {
  const cleaned = cleanInlineText(text);
  return cleaned.length > 180 ? `${cleaned.slice(0, 177).trim()}...` : cleaned;
}

function compareReadingOrder(a: ParsedBlock, b: ParsedBlock): number {
  const pageCompare = a.pageNumber - b.pageNumber;
  if (pageCompare !== 0) {
    return pageCompare;
  }

  const ay = a.bbox?.y0 ?? Number.MAX_SAFE_INTEGER;
  const by = b.bbox?.y0 ?? Number.MAX_SAFE_INTEGER;
  if (Math.abs(ay - by) > 4) {
    return ay - by;
  }

  const ax = a.bbox?.x0 ?? Number.MAX_SAFE_INTEGER;
  const bx = b.bbox?.x0 ?? Number.MAX_SAFE_INTEGER;
  if (Math.abs(ax - bx) > 4) {
    return ax - bx;
  }

  return a.order - b.order || a.id.localeCompare(b.id);
}

function textLineRefs(block: ParsedBlock): TextLineRef[] {
  if (!block.text) {
    return [];
  }

  const lines = splitTextLines(block.text);
  const metadataLines = Array.isArray(block.metadata?.lines) ? block.metadata.lines : undefined;

  return lines.map((text, lineIndex) => {
    const metadataLine = metadataLines?.[lineIndex];
    const metadataBox = isBoundingBoxContainer(metadataLine) ? metadataLine.bbox : undefined;
    const fallbackBox = estimateLineBox(block, lineIndex, lines.length);
    const box = metadataBox ?? fallbackBox;

    return {
      block,
      lineIndex,
      text,
      y0: box.y0,
      y1: box.y1,
      x0: box.x0,
      x1: box.x1
    };
  });
}

function estimateLineBox(block: ParsedBlock, lineIndex: number, lineCount: number) {
  const box = block.bbox ?? { page: block.pageNumber, x0: 0, y0: 0, x1: 0, y1: 0 };
  const lineHeight = Math.max(1, (box.y1 - box.y0) / Math.max(1, lineCount));
  return {
    page: box.page,
    x0: box.x0,
    x1: box.x1,
    y0: box.y0 + lineHeight * lineIndex,
    y1: box.y0 + lineHeight * (lineIndex + 1)
  };
}

function splitTextLines(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map(cleanInlineText)
    .filter(Boolean);
}

function isValidTitleLine(text: string, line: TextLineRef | undefined, tableBlocks: ParsedBlock[]): boolean {
  const cleaned = cleanInlineText(text);
  if (!cleaned || /^(\d{4}\.\d{2}\.\d{2})\b/.test(cleaned) || /^CHAPTER\s+\d+/i.test(cleaned) || /^\(Source:/i.test(cleaned)) {
    return false;
  }
  if (isPictureCaption(cleaned) || isTableHeaderText(cleaned) || isListOrTableRowText(cleaned)) {
    return false;
  }
  if (wordCount(cleaned) > 14 || cleaned.length > 110) {
    return false;
  }
  if (line && isLineInsideTable(line, tableBlocks)) {
    return false;
  }

  return uppercaseRatio(cleaned) >= 0.6;
}

function isRejectedTitleBoundary(text: string): boolean {
  const cleaned = cleanInlineText(text);
  return (
    /^CHAPTER\s+\d+/i.test(cleaned) ||
    /^\(Source:/i.test(cleaned) ||
    isPictureCaption(cleaned) ||
    isTableHeaderText(cleaned) ||
    isListOrTableRowText(cleaned)
  );
}

function isBodyLikeLine(text: string): boolean {
  const cleaned = cleanInlineText(text);
  return wordCount(cleaned) > 14 || /[.!?]\s*$/.test(cleaned) || uppercaseRatio(cleaned) < 0.45;
}

function distanceFromHSLine(hsLine: TextLineRef | undefined, candidate: TextLineRef): number {
  if (!hsLine || hsLine.block.pageNumber !== candidate.block.pageNumber) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.max(0, candidate.y0 - hsLine.y1);
}

function isPageNumberBlock(block: ParsedBlock): boolean {
  const text = block.text?.trim() ?? "";
  return /^\d{1,3}$/.test(text) && (block.bbox?.y0 ?? 0) >= 650;
}

function isReliableTableBlock(block: ParsedBlock): boolean {
  return block.source === "layout" && block.type === "table" && block.bbox !== undefined && block.metadata?.reason !== "aligned-text-grid";
}

function isLineInsideTable(line: TextLineRef, tableBlocks: ParsedBlock[]): boolean {
  return tableBlocks.some((table) => {
    if (!table.bbox || table.pageNumber !== line.block.pageNumber) {
      return false;
    }

    const centerX = (line.x0 + line.x1) / 2;
    const centerY = (line.y0 + line.y1) / 2;
    return (
      centerX >= table.bbox.x0 &&
      centerX <= table.bbox.x1 &&
      centerY >= table.bbox.y0 + 2 &&
      centerY <= table.bbox.y1
    );
  });
}

function isPictureCaption(text: string): boolean {
  return /^(pictures?|fig(?:ure)?|hinh|anh|ảnh)\b/i.test(normalizeComparableText(text));
}

function isTableHeaderText(text: string): boolean {
  const normalized = normalizeComparableText(text);
  return (
    /\bgaharu tree species\b/.test(normalized) ||
    /\bscientific name\s*\/?\s*genus\b/.test(normalized) ||
    /\bdimension\b.*\b(color|identification)\b/.test(normalized) ||
    /\bcabbage\b.*\bdescription\b/.test(normalized) ||
    /\bbrassica\b.*\bspecies\b/.test(normalized)
  );
}

function isListOrTableRowText(text: string): boolean {
  const cleaned = cleanInlineText(text);
  return /^\d+\.?\s*$/.test(cleaned) || /^\d+\.\s+\S+/.test(cleaned) || /^[ivxlcdm]+\.\s+/i.test(cleaned);
}

function uppercaseRatio(text: string): number {
  const letters = [...text].filter((char) => /\p{L}/u.test(char));
  if (letters.length === 0) {
    return 0;
  }

  const uppercase = letters.filter((char) => char === char.toUpperCase() && char !== char.toLowerCase());
  return uppercase.length / letters.length;
}

function cleanInlineText(text: string): string {
  return text
    .replace(/ï¿½/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function isBoundingBoxContainer(value: unknown): value is { bbox: { x0: number; y0: number; x1: number; y1: number } } {
  if (typeof value !== "object" || value === null || !("bbox" in value)) {
    return false;
  }

  const bbox = (value as { bbox?: unknown }).bbox;
  if (typeof bbox !== "object" || bbox === null) {
    return false;
  }

  const record = bbox as Record<string, unknown>;
  return ["x0", "y0", "x1", "y1"].every((key) => typeof record[key] === "number");
}

function extractMarkdownCaptions(markdownText: string): string[] {
  const captions: string[] = [];
  const regex = /^\*Caption:\s*(.*?)\*\s*$/gm;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(markdownText)) !== null) {
    captions.push(cleanInlineText(match[1] ?? ""));
  }

  return captions;
}

function extractMarkdownImageLinks(markdownText: string): Array<{ alt: string; path: string }> {
  const links: Array<{ alt: string; path: string }> = [];
  const regex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(markdownText)) !== null) {
    const path = match[2].trim();
    if (/^(?:https?:|data:|#)/i.test(path)) {
      continue;
    }

    links.push({
      alt: match[1],
      path
    });
  }

  return links;
}

function extractMarkdownImageIds(markdownText: string): string[] {
  const ids: string[] = [];
  const regex = /<!--\s*image-id:\s*([^\s>]+)\s*-->/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(markdownText)) !== null) {
    ids.push(match[1]);
  }

  return ids;
}

function normalizeMarkdownPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function normalizeComparableText(text: string): string {
  return cleanInlineText(text)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function previewList(values: string[]): string {
  return values.map((value) => `"${value.slice(0, 60)}${value.length > 60 ? "..." : ""}"`).join("; ");
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function extractMarkdownTables(markdownText: string): string[][] {
  const lines = markdownText.replace(/\r\n/g, "\n").split("\n");
  const tables: string[][] = [];
  let buffer: string[] = [];
  let inCodeFence = false;

  const flush = () => {
    if (buffer.length > 0) {
      tables.push(buffer);
      buffer = [];
    }
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      flush();
      inCodeFence = !inCodeFence;
      continue;
    }

    if (!inCodeFence && /^\s*\|.*\|\s*$/.test(line)) {
      buffer.push(line);
      continue;
    }

    flush();
  }

  flush();
  return tables;
}

function parseTableRow(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isSeparatorCells(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell) || cell.includes("---"));
}
