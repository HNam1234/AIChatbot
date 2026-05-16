import type { BoundingBox, LayoutAnalysis, ParsedBlock } from "../types";
import { bboxArea, bboxCenter, bboxHeight, bboxWidth, clamp } from "../utils/geometry";

export interface ArtifactFilterOptions {
  noiseTolerance?: number;
  iconAreaRatioThreshold?: number;
  fullPageAreaRatioThreshold?: number;
  repeatedPositionMinPageRatio?: number;
  repeatedPositionMinPages?: number;
  alphaWatermarkAreaRatioThreshold?: number;
}

interface PageMetrics {
  pageNumber: number;
  width: number;
  height: number;
  textBlockCount: number;
  imageBlockCount: number;
}

interface PositionGroup {
  key: string;
  blocks: ParsedBlock[];
  pageNumbers: Set<number>;
}

interface ArtifactSettings {
  noiseTolerance: number;
  iconAreaRatioThreshold: number;
  fullPageAreaRatioThreshold: number;
  repeatedPositionMinPageRatio: number;
  repeatedPositionMinPages: number;
  alphaWatermarkAreaRatioThreshold: number;
}

const DEFAULTS: ArtifactSettings = {
  noiseTolerance: 50,
  iconAreaRatioThreshold: 0.005,
  fullPageAreaRatioThreshold: 0.9,
  repeatedPositionMinPageRatio: 0.35,
  repeatedPositionMinPages: 2,
  alphaWatermarkAreaRatioThreshold: 0.02
};

export class ArtifactFilter {
  public static filter(
    blocks: ParsedBlock[],
    layout?: LayoutAnalysis,
    options: ArtifactFilterOptions = {}
  ): ParsedBlock[] {
    const settings = resolveOptions(options);
    const clonedBlocks = blocks.map(cloneBlock);
    const pageMetrics = buildPageMetrics(clonedBlocks, layout);
    const images = clonedBlocks.filter((block) => block.type === "image" && block.bbox);
    const repeatedPositionIds = findRepeatedPositionNoiseIds(images, pageMetrics, settings);

    for (const image of images) {
      const reasons = classifyImageArtifact(image, pageMetrics, repeatedPositionIds, settings);
      if (reasons.length === 0) {
        continue;
      }

      markDecorative(image, reasons, settings);
    }

    return clonedBlocks;
  }
}

function resolveOptions(options: ArtifactFilterOptions): ArtifactSettings {
  return {
    noiseTolerance: Math.max(1, options.noiseTolerance ?? DEFAULTS.noiseTolerance),
    iconAreaRatioThreshold: options.iconAreaRatioThreshold ?? DEFAULTS.iconAreaRatioThreshold,
    fullPageAreaRatioThreshold:
      options.fullPageAreaRatioThreshold ?? DEFAULTS.fullPageAreaRatioThreshold,
    repeatedPositionMinPageRatio:
      options.repeatedPositionMinPageRatio ?? DEFAULTS.repeatedPositionMinPageRatio,
    repeatedPositionMinPages: options.repeatedPositionMinPages ?? DEFAULTS.repeatedPositionMinPages,
    alphaWatermarkAreaRatioThreshold:
      options.alphaWatermarkAreaRatioThreshold ?? DEFAULTS.alphaWatermarkAreaRatioThreshold
  };
}

function cloneBlock(block: ParsedBlock): ParsedBlock {
  return {
    ...block,
    linkedCaptionIds: block.linkedCaptionIds ? [...block.linkedCaptionIds] : undefined,
    metadata: block.metadata ? { ...block.metadata } : undefined
  };
}

function buildPageMetrics(blocks: ParsedBlock[], layout?: LayoutAnalysis): Map<number, PageMetrics> {
  const metrics = new Map<number, PageMetrics>();

  for (const page of layout?.pages ?? []) {
    metrics.set(page.pageNumber, {
      pageNumber: page.pageNumber,
      width: page.width,
      height: page.height,
      textBlockCount: page.textBlocks.length,
      imageBlockCount: page.imageBlocks.length
    });
  }

  for (const block of blocks) {
    const existing = metrics.get(block.pageNumber);
    if (!existing) {
      const pageWidth = getNumberMetadata(block, "pageWidth");
      const pageHeight = getNumberMetadata(block, "pageHeight");
      if (pageWidth && pageHeight) {
        metrics.set(block.pageNumber, {
          pageNumber: block.pageNumber,
          width: pageWidth,
          height: pageHeight,
          textBlockCount: block.type === "text" ? 1 : 0,
          imageBlockCount: block.type === "image" ? 1 : 0
        });
      }
      continue;
    }

    if (block.type === "text") {
      existing.textBlockCount += 1;
    } else if (block.type === "image") {
      existing.imageBlockCount += 1;
    }
  }

  return metrics;
}

function findRepeatedPositionNoiseIds(
  images: ParsedBlock[],
  pageMetrics: Map<number, PageMetrics>,
  settings: ArtifactSettings
): Set<string> {
  const groups = new Map<string, PositionGroup>();
  const pageCount = Math.max(1, pageMetrics.size || new Set(images.map((image) => image.pageNumber)).size);
  const minPages = Math.max(
    settings.repeatedPositionMinPages,
    Math.ceil(pageCount * settings.repeatedPositionMinPageRatio)
  );

  for (const image of images) {
    if (!image.bbox) {
      continue;
    }
    const key = positionKey(image.bbox, settings.noiseTolerance);
    const group = groups.get(key) ?? { key, blocks: [], pageNumbers: new Set<number>() };
    group.blocks.push(image);
    group.pageNumbers.add(image.pageNumber);
    groups.set(key, group);
  }

  const repeatedIds = new Set<string>();
  for (const group of groups.values()) {
    if (group.pageNumbers.size < minPages) {
      continue;
    }

    for (const image of group.blocks) {
      const metrics = pageMetrics.get(image.pageNumber);
      if (!metrics || !image.bbox) {
        continue;
      }

      if (isFullPageImage(image, metrics, settings) || isPageEdgeImage(image.bbox, metrics) || isSmallIcon(image, metrics, settings)) {
        repeatedIds.add(image.id);
      }
    }
  }

  return repeatedIds;
}

function classifyImageArtifact(
  image: ParsedBlock,
  pageMetrics: Map<number, PageMetrics>,
  repeatedPositionIds: Set<string>,
  settings: ArtifactSettings
): string[] {
  const reasons: string[] = [];
  const metrics = pageMetrics.get(image.pageNumber);
  if (!metrics || !image.bbox) {
    return reasons;
  }

  if (image.metadata?.decorative === true) {
    reasons.push("layout-decorative");
  }
  if (isSmallIcon(image, metrics, settings)) {
    reasons.push("size-icon");
  }
  if (isFullPageImage(image, metrics, settings)) {
    reasons.push("page-background");
  }
  if (repeatedPositionIds.has(image.id)) {
    reasons.push("repeated-position");
  }
  if (isAlphaWatermark(image, metrics, settings)) {
    reasons.push("alpha-watermark");
  }

  return [...new Set(reasons)];
}

function markDecorative(image: ParsedBlock, reasons: string[], settings: ArtifactSettings): void {
  image.captionLinked = image.captionLinked === true ? true : false;
  image.metadata = {
    ...(image.metadata ?? {}),
    decorative: true,
    includeInMarkdown: false,
    artifactFilter: {
      filtered: true,
      reasons,
      noiseTolerance: settings.noiseTolerance
    }
  };
}

function isSmallIcon(image: ParsedBlock, metrics: PageMetrics, settings: ArtifactSettings): boolean {
  if (!image.bbox) {
    return false;
  }

  const areaRatio = imageAreaRatio(image, metrics);
  const width = bboxWidth(image.bbox);
  const height = bboxHeight(image.bbox);
  const tinyAbsoluteSize = width <= 24 || height <= 24;
  const smallEdgeDecoration = areaRatio <= settings.iconAreaRatioThreshold && isPageEdgeImage(image.bbox, metrics);

  return areaRatio <= settings.iconAreaRatioThreshold * 0.45 || tinyAbsoluteSize || smallEdgeDecoration;
}

function isFullPageImage(image: ParsedBlock, metrics: PageMetrics, settings: ArtifactSettings): boolean {
  if (!image.bbox) {
    return false;
  }

  const areaRatio = imageAreaRatio(image, metrics);
  const edgeTolerance = Math.max(2, settings.noiseTolerance);
  const coversPageEdges =
    image.bbox.x0 <= edgeTolerance &&
    image.bbox.y0 <= edgeTolerance &&
    image.bbox.x1 >= metrics.width - edgeTolerance &&
    image.bbox.y1 >= metrics.height - edgeTolerance;

  return areaRatio >= settings.fullPageAreaRatioThreshold || coversPageEdges;
}

function isPageEdgeImage(box: BoundingBox, metrics: PageMetrics): boolean {
  return (
    box.y1 <= metrics.height * 0.16 ||
    box.y0 >= metrics.height * 0.84 ||
    box.x1 <= metrics.width * 0.12 ||
    box.x0 >= metrics.width * 0.88
  );
}

function isAlphaWatermark(
  image: ParsedBlock,
  metrics: PageMetrics,
  settings: ArtifactSettings
): boolean {
  if (!image.bbox || !getBooleanMetadata(image, "hasAlpha")) {
    return false;
  }

  const center = bboxCenter(image.bbox);
  const centerInPageBody =
    center.x >= metrics.width * 0.15 &&
    center.x <= metrics.width * 0.85 &&
    center.y >= metrics.height * 0.15 &&
    center.y <= metrics.height * 0.85;
  const areaRatio = imageAreaRatio(image, metrics);
  const aspectRatio = bboxWidth(image.bbox) / Math.max(1, bboxHeight(image.bbox));
  const elongatedOverlay = aspectRatio >= 2.2 || aspectRatio <= 0.45;
  const largeOverlay = areaRatio >= 0.35;

  return centerInPageBody && areaRatio >= settings.alphaWatermarkAreaRatioThreshold && (elongatedOverlay || largeOverlay);
}

function imageAreaRatio(image: ParsedBlock, metrics: PageMetrics): number {
  const metadataAreaRatio = getNumberMetadata(image, "areaRatio");
  if (metadataAreaRatio !== undefined) {
    return clamp(metadataAreaRatio, 0, 1);
  }

  if (!image.bbox) {
    return 0;
  }

  return clamp(bboxArea(image.bbox) / Math.max(1, metrics.width * metrics.height), 0, 1);
}

function positionKey(box: BoundingBox, tolerance: number): string {
  const normalized = [box.x0, box.y0, box.x1, box.y1].map((value) => Math.round(value / tolerance) * tolerance);
  return normalized.join(":");
}

function getBooleanMetadata(block: ParsedBlock, key: string): boolean {
  return block.metadata?.[key] === true;
}

function getNumberMetadata(block: ParsedBlock, key: string): number | undefined {
  const value = block.metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
