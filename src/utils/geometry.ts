import type { BoundingBox } from "../types";

export function bboxWidth(box: BoundingBox): number {
  return Math.max(0, box.x1 - box.x0);
}

export function bboxHeight(box: BoundingBox): number {
  return Math.max(0, box.y1 - box.y0);
}

export function bboxArea(box: BoundingBox): number {
  return bboxWidth(box) * bboxHeight(box);
}

export function bboxCenter(box: BoundingBox): { x: number; y: number } {
  return {
    x: box.x0 + bboxWidth(box) / 2,
    y: box.y0 + bboxHeight(box) / 2
  };
}

export function expandBox(
  box: BoundingBox,
  paddingX: number,
  paddingY: number,
  pageWidth?: number,
  pageHeight?: number
): BoundingBox {
  return {
    page: box.page,
    x0: Math.max(0, box.x0 - paddingX),
    y0: Math.max(0, box.y0 - paddingY),
    x1: pageWidth ? Math.min(pageWidth, box.x1 + paddingX) : box.x1 + paddingX,
    y1: pageHeight ? Math.min(pageHeight, box.y1 + paddingY) : box.y1 + paddingY
  };
}

export function intersects(a: BoundingBox, b: BoundingBox): boolean {
  return a.page === b.page && a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0;
}

export function unionBox(boxes: BoundingBox[]): BoundingBox {
  if (boxes.length === 0) {
    throw new Error("Cannot compute a union box from an empty list.");
  }

  return boxes.reduce<BoundingBox>(
    (acc, box) => ({
      page: acc.page,
      x0: Math.min(acc.x0, box.x0),
      y0: Math.min(acc.y0, box.y0),
      x1: Math.max(acc.x1, box.x1),
      y1: Math.max(acc.y1, box.y1)
    }),
    { ...boxes[0] }
  );
}

export function iou(a: BoundingBox, b: BoundingBox): number {
  if (a.page !== b.page) {
    return 0;
  }

  const intersectionWidth = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const intersectionHeight = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const intersectionArea = intersectionWidth * intersectionHeight;
  const unionArea = bboxArea(a) + bboxArea(b) - intersectionArea;
  return unionArea > 0 ? intersectionArea / unionArea : 0;
}

export function distanceBetweenBoxes(a: BoundingBox, b: BoundingBox): number {
  if (a.page !== b.page) {
    return Number.POSITIVE_INFINITY;
  }

  const dx = Math.max(a.x0 - b.x1, b.x0 - a.x1, 0);
  const dy = Math.max(a.y0 - b.y1, b.y0 - a.y1, 0);
  return Math.hypot(dx, dy);
}

export function centerDistance(a: BoundingBox, b: BoundingBox): number {
  if (a.page !== b.page) {
    return Number.POSITIVE_INFINITY;
  }

  const ac = bboxCenter(a);
  const bc = bboxCenter(b);
  return Math.hypot(ac.x - bc.x, ac.y - bc.y);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
