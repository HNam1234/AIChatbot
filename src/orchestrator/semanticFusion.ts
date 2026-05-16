import type { BoundingBox, ParsedBlock } from "../types";
import {
  bboxHeight,
  bboxWidth,
  centerDistance,
  clamp,
  distanceBetweenBoxes,
  expandBox,
  intersects,
  iou,
  unionBox
} from "../utils/geometry";

export interface SemanticFusionOptions {
  contextPaddingX?: number;
  contextPaddingY?: number;
  dbscanEps?: number;
  dbscanMinPoints?: number;
  minLinkScore?: number;
  duplicateIoUThreshold?: number;
  groupPropagationDistance?: number;
  minGroupPropagationScore?: number;
}

interface Cluster {
  id: string;
  pageNumber: number;
  blocks: ParsedBlock[];
  bbox: BoundingBox;
  text: string;
  kind: string;
  avgFontSize?: number;
}

interface ClusterScore {
  cluster: Cluster;
  score: number;
}

const DEFAULTS = {
  contextPaddingX: 120,
  contextPaddingY: 140,
  dbscanEps: 42,
  dbscanMinPoints: 1,
  minLinkScore: 0.52,
  duplicateIoUThreshold: 0.92,
  groupPropagationDistance: 96,
  minGroupPropagationScore: 0.62
};

const HS_CODE_LINE_REGEX = /^\d{4}\.\d{2}\.\d{2}\b/;

export class SemanticFusion {
  public static fuse(blocks: ParsedBlock[], options: SemanticFusionOptions = {}): ParsedBlock[] {
    const settings = resolveOptions(options);
    const clonedBlocks = blocks.map((block) => ({
      ...block,
      linkedCaptionIds: block.linkedCaptionIds ? [...block.linkedCaptionIds] : undefined,
      metadata: block.metadata ? { ...block.metadata } : undefined
    }));

    const deduplicatedBlocks = removeDuplicateImages(clonedBlocks, settings.duplicateIoUThreshold);
    const captionBlocks = linkSpatialCaptions(deduplicatedBlocks, settings);
    linkNearbySourceAnnotations(deduplicatedBlocks, settings);
    propagateCaptionLinksToImageGroups(deduplicatedBlocks, settings);

    return [...deduplicatedBlocks, ...captionBlocks].sort(
      (a, b) => a.pageNumber - b.pageNumber || a.order - b.order || a.id.localeCompare(b.id)
    );
  }
}

function resolveOptions(options: SemanticFusionOptions): Required<SemanticFusionOptions> {
  return {
    contextPaddingX: options.contextPaddingX ?? DEFAULTS.contextPaddingX,
    contextPaddingY: options.contextPaddingY ?? DEFAULTS.contextPaddingY,
    dbscanEps: options.dbscanEps ?? DEFAULTS.dbscanEps,
    dbscanMinPoints: options.dbscanMinPoints ?? DEFAULTS.dbscanMinPoints,
    minLinkScore: options.minLinkScore ?? DEFAULTS.minLinkScore,
    duplicateIoUThreshold: options.duplicateIoUThreshold ?? DEFAULTS.duplicateIoUThreshold,
    groupPropagationDistance: options.groupPropagationDistance ?? DEFAULTS.groupPropagationDistance,
    minGroupPropagationScore:
      options.minGroupPropagationScore ?? DEFAULTS.minGroupPropagationScore
  };
}

function removeDuplicateImages(blocks: ParsedBlock[], duplicateIoUThreshold: number): ParsedBlock[] {
  const duplicateIds = new Set<string>();
  const imageBlocks = blocks.filter((block) => block.type === "image" && block.bbox);
  const byPage = groupBy(imageBlocks, (block) => String(block.pageNumber));

  for (const pageImages of Object.values(byPage)) {
    const sorted = pageImages.sort((a, b) => (areaOfBlock(b) ?? 0) - (areaOfBlock(a) ?? 0));

    for (let index = 0; index < sorted.length; index += 1) {
      const keeper = sorted[index];
      if (!keeper.bbox || duplicateIds.has(keeper.id)) {
        continue;
      }

      for (let nextIndex = index + 1; nextIndex < sorted.length; nextIndex += 1) {
        const candidate = sorted[nextIndex];
        if (!candidate.bbox || duplicateIds.has(candidate.id)) {
          continue;
        }

        const overlap = iou(keeper.bbox, candidate.bbox);
        const nearSameCenter = centerDistance(keeper.bbox, candidate.bbox) <= 6;
        const nearSameSize =
          Math.abs(bboxWidth(keeper.bbox) - bboxWidth(candidate.bbox)) <= 8 &&
          Math.abs(bboxHeight(keeper.bbox) - bboxHeight(candidate.bbox)) <= 8;

        if (overlap >= duplicateIoUThreshold || (nearSameCenter && nearSameSize)) {
          duplicateIds.add(candidate.id);
          candidate.metadata = {
            ...(candidate.metadata ?? {}),
            duplicateOf: keeper.id,
            includeInMarkdown: false
          };
        }
      }
    }
  }

  return blocks.filter((block) => !duplicateIds.has(block.id));
}

function linkSpatialCaptions(
  blocks: ParsedBlock[],
  settings: Required<SemanticFusionOptions>
): ParsedBlock[] {
  const captionBlocks: ParsedBlock[] = [];
  const images = blocks.filter(
    (block) => block.type === "image" && block.bbox && !getBooleanMetadata(block, "decorative")
  );
  const textCandidates = expandCaptionCandidates(blocks.filter(isCaptionCandidate));
  const clustersByPage = buildClustersByPage(textCandidates, settings.dbscanEps, settings.dbscanMinPoints);

  for (const image of images) {
    if (!image.bbox) {
      continue;
    }

    const clusters = clustersByPage.get(image.pageNumber) ?? [];
    const pageWidth = getNumberMetadata(image, "pageWidth");
    const pageHeight = getNumberMetadata(image, "pageHeight");
    const context = expandBox(
      image.bbox,
      settings.contextPaddingX,
      settings.contextPaddingY,
      pageWidth,
      pageHeight
    );

    const scores = clusters
      .filter((cluster) => intersects(context, cluster.bbox) || distanceBetweenBoxes(image.bbox!, cluster.bbox) <= 120)
      .map<ClusterScore>((cluster) => ({
        cluster,
        score: scoreClusterForImage(image.bbox!, cluster)
      }))
      .filter((item) => item.score >= settings.minLinkScore)
      .sort((a, b) => b.score - a.score);

    if (scores.length === 0) {
      image.captionLinked = false;
      continue;
    }

    const bestScore = scores[0].score;
    const selected = scores.slice(0, 1);
    const captionId = `fusion-caption-${image.id}`;
    const captionText = selected.map((item) => item.cluster.text).join(" | ");

    image.captionLinked = true;
    image.linkedCaptionIds = [
      captionId,
      ...selected.flatMap((item) => item.cluster.blocks.map((block) => block.id))
    ];
    image.confidence = clamp(bestScore, 0, 1);
    image.metadata = {
      ...(image.metadata ?? {}),
      captionText,
      captionLinkScore: bestScore,
      semanticFusion: true
    };

    for (const match of selected) {
      for (const block of match.cluster.blocks) {
        block.anchorImageId = image.id;
        block.metadata = {
          ...(block.metadata ?? {}),
          clusterId: match.cluster.id,
          anchorImageId: image.id,
          captionLinkScore: match.score
        };
        const parentTextBlockId = getStringMetadata(block, "parentTextBlockId");
        if (parentTextBlockId) {
          const parent = blocks.find((candidate) => candidate.id === parentTextBlockId);
          if (parent) {
            parent.anchorImageId = image.id;
            parent.metadata = {
              ...(parent.metadata ?? {}),
              anchorImageId: image.id,
              captionLinkScore: Math.max(getNumberMetadata(parent, "captionLinkScore") ?? 0, match.score)
            };
          }
        }
      }
    }

    captionBlocks.push({
      id: captionId,
      type: "caption",
      source: "fusion",
      pageNumber: image.pageNumber,
      order: image.order + 1,
      text: captionText,
      bbox: unionBox(selected.map((item) => item.cluster.bbox)),
      anchorImageId: image.id,
      confidence: bestScore,
      metadata: {
        includeInMarkdown: false,
        generatedBy: "semantic-layout-fusion",
        sourceClusterIds: selected.map((item) => item.cluster.id)
      }
    });
  }

  return captionBlocks;
}

function propagateCaptionLinksToImageGroups(
  blocks: ParsedBlock[],
  settings: Required<SemanticFusionOptions>
): void {
  const images = blocks.filter(
    (block) => block.type === "image" && block.bbox && !getBooleanMetadata(block, "decorative")
  );
  const linkedImages = images.filter((image) => image.captionLinked === true && !isPageBackground(image));
  const orphanImages = images.filter((image) => image.captionLinked !== true && !isPageBackground(image));

  for (const orphan of orphanImages) {
    if (!orphan.bbox) {
      continue;
    }

    const bestPeer = linkedImages
      .filter((peer) => peer.pageNumber === orphan.pageNumber && peer.id !== orphan.id && peer.bbox)
      .map((peer) => ({
        peer,
        score: scoreImageGroupAffinity(orphan.bbox!, peer.bbox!, settings.groupPropagationDistance)
      }))
      .filter((candidate) => candidate.score >= settings.minGroupPropagationScore)
      .sort((a, b) => b.score - a.score)[0];

    if (!bestPeer) {
      continue;
    }

    const inheritedCaptionText =
      typeof bestPeer.peer.metadata?.captionText === "string" ? bestPeer.peer.metadata.captionText : undefined;
    orphan.captionLinked = true;
    orphan.linkedCaptionIds = bestPeer.peer.linkedCaptionIds ? [...bestPeer.peer.linkedCaptionIds] : undefined;
    orphan.confidence = clamp((bestPeer.peer.confidence ?? 0.64) * bestPeer.score, 0, 0.95);
    orphan.metadata = {
      ...(orphan.metadata ?? {}),
      ...(inheritedCaptionText ? { captionText: inheritedCaptionText } : {}),
      captionLinkScore: orphan.confidence,
      captionPropagatedFrom: bestPeer.peer.id,
      semanticFusion: true,
      visualGroupPropagation: true
    };
  }
}

function linkNearbySourceAnnotations(
  blocks: ParsedBlock[],
  settings: Required<SemanticFusionOptions>
): void {
  const images = blocks.filter(
    (block) =>
      block.type === "image" &&
      block.bbox &&
      block.captionLinked !== true &&
      !getBooleanMetadata(block, "decorative") &&
      !isPageBackground(block)
  );
  const sourceBlocks = blocks.filter(isSourceAnnotationCandidate);

  for (const image of images) {
    if (!image.bbox) {
      continue;
    }

    const pageWidth = getNumberMetadata(image, "pageWidth");
    const pageHeight = getNumberMetadata(image, "pageHeight");
    const context = expandBox(
      image.bbox,
      settings.contextPaddingX,
      settings.contextPaddingY,
      pageWidth,
      pageHeight
    );
    const source = sourceBlocks
      .filter((block) => block.pageNumber === image.pageNumber && block.bbox)
      .map((block) => ({
        block,
        distance: distanceBetweenBoxes(image.bbox!, block.bbox!)
      }))
      .filter(({ block, distance }) => intersects(context, block.bbox!) || distance <= 140)
      .sort((a, b) => a.distance - b.distance)[0];

    if (!source) {
      continue;
    }

    image.captionLinked = true;
    image.linkedCaptionIds = [source.block.id];
    image.confidence = 0.58;
    image.metadata = {
      ...(image.metadata ?? {}),
      sourceText: source.block.text?.trim(),
      captionLinkScore: image.confidence,
      semanticFusion: true,
      visualSourceLinked: true
    };
  }
}

function isCaptionCandidate(block: ParsedBlock): boolean {
  if (!block.bbox || !block.text || !["text", "caption", "unknown"].includes(block.type)) {
    return false;
  }

  const text = captionCandidateText(block.text);
  if (!text || text.length > 500) {
    return false;
  }

  return getBooleanMetadata(block, "layoutOnly") || block.type === "caption";
}

function expandCaptionCandidates(candidates: ParsedBlock[]): ParsedBlock[] {
  return candidates.flatMap((block) => {
    const lineBlocks = captionLineBlocks(block);
    return lineBlocks.length > 0 ? lineBlocks : [block];
  });
}

function captionLineBlocks(block: ParsedBlock): ParsedBlock[] {
  const metadataLines = Array.isArray(block.metadata?.lines) ? block.metadata.lines : undefined;
  if (!metadataLines || metadataLines.length <= 1) {
    return [];
  }

  return metadataLines
    .map((line, lineIndex) => lineToCaptionBlock(block, line, lineIndex))
    .filter((lineBlock): lineBlock is ParsedBlock => Boolean(lineBlock));
}

function lineToCaptionBlock(block: ParsedBlock, line: unknown, lineIndex: number): ParsedBlock | undefined {
  if (!isTextLineRecord(line)) {
    return undefined;
  }

  const text = captionCandidateText(line.text);
  if (!text) {
    return undefined;
  }

  return {
    id: `${block.id}-line-${lineIndex}`,
    type: block.type,
    source: block.source,
    pageNumber: block.pageNumber,
    order: block.order + lineIndex / 100,
    text,
    bbox: line.bbox,
    metadata: {
      ...(block.metadata ?? {}),
      parentTextBlockId: block.id,
      lineIndex
    }
  };
}

function isSourceAnnotationCandidate(block: ParsedBlock): boolean {
  if (!block.bbox || !block.text || block.type !== "text") {
    return false;
  }

  return splitTextLines(block.text).some((line) => /^\(Source:/i.test(line));
}

function buildClustersByPage(candidates: ParsedBlock[], eps: number, minPoints: number): Map<number, Cluster[]> {
  const result = new Map<number, Cluster[]>();
  const byPage = groupBy(candidates, (block) => String(block.pageNumber));

  for (const [pageNumberText, pageBlocks] of Object.entries(byPage)) {
    const pageNumber = Number(pageNumberText);
    const clusters = dbscan(pageBlocks, eps, minPoints).map((clusterBlocks, index) =>
      createCluster(`cluster-p${pageNumber}-${index}`, pageNumber, clusterBlocks)
    );
    result.set(pageNumber, clusters);
  }

  return result;
}

function dbscan(blocks: ParsedBlock[], eps: number, minPoints: number): ParsedBlock[][] {
  const clusters: ParsedBlock[][] = [];
  const visited = new Set<number>();
  const assigned = new Set<number>();

  for (let index = 0; index < blocks.length; index += 1) {
    if (visited.has(index)) {
      continue;
    }

    visited.add(index);
    const neighbors = regionQuery(blocks, index, eps);
    if (neighbors.length < minPoints) {
      clusters.push([blocks[index]]);
      assigned.add(index);
      continue;
    }

    const cluster: ParsedBlock[] = [];
    expandCluster(blocks, index, neighbors, cluster, visited, assigned, eps, minPoints);
    clusters.push(cluster);
  }

  return clusters;
}

function expandCluster(
  blocks: ParsedBlock[],
  index: number,
  neighbors: number[],
  cluster: ParsedBlock[],
  visited: Set<number>,
  assigned: Set<number>,
  eps: number,
  minPoints: number
): void {
  addToCluster(blocks, index, cluster, assigned);

  for (let cursor = 0; cursor < neighbors.length; cursor += 1) {
    const neighborIndex = neighbors[cursor];
    if (!visited.has(neighborIndex)) {
      visited.add(neighborIndex);
      const neighborNeighbors = regionQuery(blocks, neighborIndex, eps);
      if (neighborNeighbors.length >= minPoints) {
        for (const neighbor of neighborNeighbors) {
          if (!neighbors.includes(neighbor)) {
            neighbors.push(neighbor);
          }
        }
      }
    }

    if (!assigned.has(neighborIndex)) {
      addToCluster(blocks, neighborIndex, cluster, assigned);
    }
  }
}

function addToCluster(
  blocks: ParsedBlock[],
  index: number,
  cluster: ParsedBlock[],
  assigned: Set<number>
): void {
  cluster.push(blocks[index]);
  assigned.add(index);
}

function regionQuery(blocks: ParsedBlock[], index: number, eps: number): number[] {
  const source = blocks[index];
  if (!source.bbox) {
    return [];
  }
  const sourceKind = captionCandidateKind(source.text ?? "");

  return blocks
    .map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
    .filter(({ candidate }) => {
      if (!candidate.bbox) {
        return false;
      }
      if (captionCandidateKind(candidate.text ?? "") !== sourceKind) {
        return false;
      }

      return (
        distanceBetweenBoxes(source.bbox!, candidate.bbox) <= eps ||
        centerDistance(source.bbox!, candidate.bbox) <= eps * 1.5
      );
    })
    .map(({ candidateIndex }) => candidateIndex);
}

function createCluster(id: string, pageNumber: number, blocks: ParsedBlock[]): Cluster {
  const sortedBlocks = [...blocks].sort((a, b) => {
    const ay = a.bbox?.y0 ?? 0;
    const by = b.bbox?.y0 ?? 0;
    if (Math.abs(ay - by) > 4) {
      return ay - by;
    }
    return (a.bbox?.x0 ?? 0) - (b.bbox?.x0 ?? 0);
  });
  const boxes = sortedBlocks.map((block) => block.bbox).filter((box): box is BoundingBox => Boolean(box));
  const fontSizes = sortedBlocks
    .map((block) => getNumberMetadata(block, "avgFontSize"))
    .filter((value): value is number => typeof value === "number");

  return {
    id,
    pageNumber,
    blocks: sortedBlocks,
    bbox: unionBox(boxes),
    text: sortedBlocks
      .map((block) => captionCandidateText(block.text ?? ""))
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim(),
    kind: captionCandidateKind(sortedBlocks[0]?.text ?? ""),
    avgFontSize: fontSizes.length > 0 ? average(fontSizes) : undefined
  };
}

function captionCandidateText(text: string): string {
  const lines = splitTextLines(text);

  if (lines.length === 0) {
    return "";
  }

  const hsLineIndex = lines.findIndex((line) => HS_CODE_LINE_REGEX.test(line));
  if (hsLineIndex !== -1) {
    const titleLine = lines[hsLineIndex + 1];
    return titleLine && isShortCaptionLine(titleLine) ? titleLine : "";
  }

  const candidateLines = lines.filter((line) => {
    if (HS_CODE_LINE_REGEX.test(line) || /^CHAPTER\s+\d+/i.test(line)) {
      return false;
    }
    if (/^\(Source:/i.test(line)) {
      return false;
    }
    if (/^\d{1,3}$/.test(line)) {
      return false;
    }
    return true;
  });
  const candidate = candidateLines.join(" ").replace(/\s+/g, " ").trim();

  return isShortCaptionLine(candidate) ? candidate : "";
}

function captionCandidateKind(text: string): string {
  const lines = splitTextLines(text);
  if (lines.some((line) => HS_CODE_LINE_REGEX.test(line))) {
    return "section-title";
  }
  if (lines.some((line) => /^(pictures?|fig(?:ure)?|hinh|ảnh|anh)\b/i.test(normalizeText(line)))) {
    return "figure-caption";
  }
  return "generic";
}

function splitTextLines(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function isShortCaptionLine(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || /^\(Source:/i.test(trimmed) || HS_CODE_LINE_REGEX.test(trimmed)) {
    return false;
  }

  return wordCount(trimmed) <= 25;
}

function scoreClusterForImage(imageBox: BoundingBox, cluster: Cluster): number {
  if (cluster.kind === "section-title" && cluster.bbox.y0 > imageBox.y1 + 8) {
    return 0;
  }

  const distance = distanceBetweenBoxes(imageBox, cluster.bbox);
  const imageDiagonal = Math.hypot(bboxWidth(imageBox), bboxHeight(imageBox));
  const distanceScore = clamp(1 - distance / Math.max(120, imageDiagonal * 0.75), 0, 1);
  const score =
    distanceScore * 0.56 +
    keywordScore(cluster.text) +
    directionalScore(imageBox, cluster.bbox) +
    fontScore(cluster) +
    symbolScore(cluster.text, distance);

  return clamp(score, 0, 1);
}

function scoreImageGroupAffinity(
  orphanBox: BoundingBox,
  peerBox: BoundingBox,
  maxDistance: number
): number {
  const distance = distanceBetweenBoxes(orphanBox, peerBox);
  if (distance > maxDistance) {
    return 0;
  }

  const distanceScore = clamp(1 - distance / Math.max(1, maxDistance), 0, 1);
  const horizontalOverlap = overlapRatio(orphanBox.x0, orphanBox.x1, peerBox.x0, peerBox.x1);
  const verticalOverlap = overlapRatio(orphanBox.y0, orphanBox.y1, peerBox.y0, peerBox.y1);
  const axisAlignmentScore = Math.max(horizontalOverlap, verticalOverlap);
  const orphanArea = Math.max(1, bboxWidth(orphanBox) * bboxHeight(orphanBox));
  const peerArea = Math.max(1, bboxWidth(peerBox) * bboxHeight(peerBox));
  const sizeScore = clamp(Math.min(orphanArea, peerArea) / Math.max(orphanArea, peerArea), 0, 1);

  return clamp(distanceScore * 0.45 + axisAlignmentScore * 0.35 + sizeScore * 0.2, 0, 1);
}

function isPageBackground(block: ParsedBlock): boolean {
  const areaRatio = getNumberMetadata(block, "areaRatio");
  return areaRatio !== undefined && areaRatio >= 0.85;
}

function keywordScore(text: string): number {
  const normalized = normalizeText(text);
  let score = 0;

  if (/\b(hinh|fig|figure|bieu do|so do|anh|chart|diagram|caption|plate|map)\b/.test(normalized)) {
    score += 0.24;
  }
  if (/\b(hinh|fig|figure)\s*[:.-]?\s*\d+/i.test(normalized)) {
    score += 0.08;
  }
  if (/\b(part|item|view|detail|section)\s*[:.-]?\s*[a-z0-9]/i.test(normalized)) {
    score += 0.06;
  }
  if (containsArrowGlyph(text) || /(?:->|<-|=>|<=)/.test(text)) {
    score += 0.08;
  }

  return Math.min(score, 0.34);
}

function directionalScore(imageBox: BoundingBox, clusterBox: BoundingBox): number {
  const horizontalOverlap = overlapRatio(imageBox.x0, imageBox.x1, clusterBox.x0, clusterBox.x1);
  const verticalOverlap = overlapRatio(imageBox.y0, imageBox.y1, clusterBox.y0, clusterBox.y1);

  if (clusterBox.y0 >= imageBox.y1 && horizontalOverlap >= 0.25) {
    return 0.18;
  }
  if (clusterBox.y1 <= imageBox.y0 && horizontalOverlap >= 0.25) {
    return 0.1;
  }
  if ((clusterBox.x1 <= imageBox.x0 || clusterBox.x0 >= imageBox.x1) && verticalOverlap >= 0.15) {
    return 0.1;
  }
  if (intersects(imageBox, clusterBox)) {
    return 0.12;
  }

  return 0;
}

function fontScore(cluster: Cluster): number {
  let score = 0;
  if (cluster.avgFontSize && cluster.avgFontSize <= 10.5) {
    score += 0.06;
  }
  if (cluster.blocks.length <= 3 && cluster.text.length <= 160) {
    score += 0.05;
  }
  return score;
}

function symbolScore(text: string, distance: number): number {
  const trimmed = text.trim();
  if (distance > 100) {
    return 0;
  }

  if (/^[A-Za-z0-9()._/\- ]{1,16}$/.test(trimmed)) {
    return 0.1;
  }

  if (/^[A-Za-z]\d{0,2}$/.test(trimmed)) {
    return 0.12;
  }

  return 0;
}

function normalizeText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9:._/\-<>= ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsArrowGlyph(text: string): boolean {
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    if ((codePoint >= 0x2190 && codePoint <= 0x21ff) || (codePoint >= 0x27f0 && codePoint <= 0x27ff)) {
      return true;
    }
  }
  return false;
}

function overlapRatio(a0: number, a1: number, b0: number, b1: number): number {
  const overlap = Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  const shortest = Math.max(1, Math.min(a1 - a0, b1 - b0));
  return overlap / shortest;
}

function areaOfBlock(block: ParsedBlock): number | undefined {
  if (!block.bbox) {
    return undefined;
  }
  return bboxWidth(block.bbox) * bboxHeight(block.bbox);
}

function getBooleanMetadata(block: ParsedBlock, key: string): boolean {
  return block.metadata?.[key] === true;
}

function getNumberMetadata(block: ParsedBlock, key: string): number | undefined {
  const value = block.metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getStringMetadata(block: ParsedBlock, key: string): string | undefined {
  const value = block.metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function isTextLineRecord(value: unknown): value is { text: string; bbox: BoundingBox } {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  const bbox = record.bbox;
  return typeof record.text === "string" && isBoundingBoxRecord(bbox);
}

function isBoundingBoxRecord(value: unknown): value is BoundingBox {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return ["page", "x0", "y0", "x1", "y1"].every((key) => typeof record[key] === "number");
}

function average(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / Math.max(1, values.length);
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Record<string, T[]> {
  return items.reduce<Record<string, T[]>>((groups, item) => {
    const key = keyFn(item);
    groups[key] ??= [];
    groups[key].push(item);
    return groups;
  }, {});
}
