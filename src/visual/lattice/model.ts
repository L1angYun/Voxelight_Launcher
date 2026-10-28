export type LatticeStatus =
  | "active"
  | "paused"
  | "done"
  | "error"
  | "unknown";

export type LatticeShape = "none" | "hover" | "focus" | "selected";

export const LATTICE_POINT_BUDGET = {
  full: 64,
  lite: 32,
} as const;

export const LATTICE_DOT_RADIUS_MIN_PX = 1.2;
export const LATTICE_DOT_RADIUS_MAX_PX = 2.4;
export const LATTICE_CONTOUR_OUTSET_PX = 3;
export const LATTICE_FOCUS_FLOW_PX_PER_SECOND = 12;
export const LATTICE_HOVER_STAGGER_MS = 120;
export const LATTICE_HOVER_SETTLE_MS = 340;
export const LATTICE_HOVER_SPRING = {
  stiffness: 230,
  damping: 24,
} as const;
export const LATTICE_DISPERSE_DURATION_MS = 460;
export const LATTICE_LOCK_FLASH_MS = 620;

export const LATTICE_PROGRESS_MAX_CELLS = 64;
export const LATTICE_PROGRESS_MAX_ROWS = 3;
export const LATTICE_PROGRESS_TRACK_MIN_PX = 22;
export const LATTICE_PROGRESS_DRIFT_AMPLITUDE_MIN_PX = 2;
export const LATTICE_PROGRESS_DRIFT_AMPLITUDE_MAX_PX = 4;
export const LATTICE_PROGRESS_DRIFT_DURATION_MS = 4200;
export const LATTICE_PROGRESS_SCAN_DURATION_MS = 2600;
export const LATTICE_PROGRESS_LOCK_DURATION_MS = 520;

export interface LatticeCell {
  index: number;
  start: number;
  end: number;
  status: LatticeStatus;
}

export interface LatticeContourPoint {
  index: number;
  x: number;
  y: number;
  radius: number;
  weight: number;
  anchor: boolean;
}

interface Point {
  x: number;
  y: number;
}

interface ContourSegment {
  length: number;
  at(distance: number): Point;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function arcPoint(
  cx: number,
  cy: number,
  radius: number,
  start: number,
  distance: number,
): Point {
  const angle = start + distance / radius;
  return {
    x: cx + Math.cos(angle) * radius,
    y: cy + Math.sin(angle) * radius,
  };
}

function roundedContourSegments(
  width: number,
  height: number,
  radius: number,
): ContourSegment[] {
  const r = Math.max(0.01, Math.min(radius, width / 2, height / 2));
  const horizontal = Math.max(0, width - r * 2);
  const vertical = Math.max(0, height - r * 2);
  const quarterArc = (Math.PI * r) / 2;
  return [
    {
      length: horizontal,
      at: (distance) => ({ x: r + distance, y: 0 }),
    },
    {
      length: quarterArc,
      at: (distance) =>
        arcPoint(width - r, r, r, -Math.PI / 2, distance),
    },
    {
      length: vertical,
      at: (distance) => ({ x: width, y: r + distance }),
    },
    {
      length: quarterArc,
      at: (distance) =>
        arcPoint(width - r, height - r, r, 0, distance),
    },
    {
      length: horizontal,
      at: (distance) => ({ x: width - r - distance, y: height }),
    },
    {
      length: quarterArc,
      at: (distance) =>
        arcPoint(r, height - r, r, Math.PI / 2, distance),
    },
    {
      length: vertical,
      at: (distance) => ({ x: 0, y: height - r - distance }),
    },
    {
      length: quarterArc,
      at: (distance) => arcPoint(r, r, r, Math.PI, distance),
    },
  ];
}

function sampleContour({
  width,
  height,
  radius,
  count,
  phasePx = 0,
}: {
  width: number;
  height: number;
  radius: number;
  count: number;
  phasePx?: number;
}): Point[] {
  const segments = roundedContourSegments(width, height, radius);
  const perimeter = segments.reduce(
    (total, segment) => total + segment.length,
    0,
  );
  if (!(perimeter > 0)) {
    return Array.from({ length: count }, (_, index) => ({
      x: width * ((index + 0.5) / count),
      y: height * ((index + 0.5) / count),
    }));
  }

  return Array.from({ length: count }, (_, index) => {
    let distance =
      (phasePx + ((index + 0.5) / count) * perimeter) % perimeter;
    if (distance < 0) distance += perimeter;
    for (const segment of segments) {
      if (distance <= segment.length) return segment.at(distance);
      distance -= segment.length;
    }
    return { x: 0, y: 0 };
  });
}

function cornerAnchors(
  points: Point[],
  width: number,
  height: number,
  radius: number,
): Set<number> {
  const diagonal = radius * (1 - Math.SQRT1_2);
  const targets = [
    { x: diagonal, y: diagonal },
    { x: width - diagonal, y: diagonal },
    { x: width - diagonal, y: height - diagonal },
    { x: diagonal, y: height - diagonal },
  ];
  const anchors = new Set<number>();
  for (const target of targets) {
    let nearest = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < points.length; index += 1) {
      if (anchors.has(index)) continue;
      const dx = points[index].x - target.x;
      const dy = points[index].y - target.y;
      const distance = dx * dx + dy * dy;
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = index;
      }
    }
    anchors.add(nearest);
  }
  return anchors;
}

function pointRadius(
  index: number,
  x: number,
  y: number,
  signature: number,
): { radius: number; weight: number } {
  const positional =
    0.5 +
    0.5 *
      Math.sin(
        x * 0.113 +
          y * 0.097 +
          index * 0.618 +
          signature * Math.PI * 2,
      );
  const weight = clamp(signature * 0.62 + positional * 0.38, 0, 1);
  return {
    radius:
      LATTICE_DOT_RADIUS_MIN_PX +
      weight *
        (LATTICE_DOT_RADIUS_MAX_PX - LATTICE_DOT_RADIUS_MIN_PX),
    weight,
  };
}

export function latticeSignature(identity: string, count = 64): number[] {
  let seed = 2166136261;
  for (let index = 0; index < identity.length; index += 1) {
    seed ^= identity.charCodeAt(index);
    seed = Math.imul(seed, 16777619);
  }
  return Array.from({ length: Math.max(1, Math.floor(count)) }, (_, index) => {
    seed ^= index + 1;
    seed = Math.imul(seed, 2246822519);
    seed ^= seed >>> 13;
    return ((seed >>> 0) % 10001) / 10000;
  });
}

export function latticeContourPoints(
  pointCount = LATTICE_POINT_BUDGET.full,
): LatticeContourPoint[] {
  const count = Math.max(4, Math.floor(pointCount));
  const radius = 11;
  const raw = sampleContour({
    width: 100,
    height: 100,
    radius,
    count,
  });
  const anchors = cornerAnchors(raw, 100, 100, radius);
  const weights = latticeSignature("lattice-contour", count);
  return raw.map((point, index) => {
    const variation = pointRadius(index, point.x, point.y, weights[index]);
    return {
      index,
      x: Number(point.x.toFixed(3)),
      y: Number(point.y.toFixed(3)),
      radius: Number(variation.radius.toFixed(3)),
      weight: Number(variation.weight.toFixed(3)),
      anchor: anchors.has(index),
    };
  });
}

/** The same points gather onto a rounded contour; none represent data. */
export function latticePointSet(
  shape: LatticeShape,
  identity: string,
): LatticeContourPoint[] {
  return latticePointSetForBox({
    shape,
    identity,
    width: 100,
    height: 100,
    pointCount: LATTICE_POINT_BUDGET.full,
  });
}

/**
 * Fits the point group to the rendered box. The caller gives the frame three
 * pixels of outset, so contour centers sit just outside the card edge.
 */
export function latticePointSetForBox({
  shape,
  identity,
  width,
  height,
  pointCount = LATTICE_POINT_BUDGET.full,
  phasePx = 0,
}: {
  shape: LatticeShape;
  identity: string;
  width: number;
  height: number;
  pointCount?: number;
  phasePx?: number;
}): LatticeContourPoint[] {
  const count = Math.max(
    4,
    Math.min(LATTICE_POINT_BUDGET.full, Math.floor(pointCount)),
  );
  const safeWidth = Number.isFinite(width) && width > 0 ? width : 100;
  const safeHeight = Number.isFinite(height) && height > 0 ? height : 100;
  const weights = latticeSignature(identity, count);

  if (shape === "none") {
    return Array.from({ length: count }, (_, index) => {
      const x = -2.5 + weights[index] * 105;
      const y =
        -8 +
        weights[(index + Math.floor(count / 3)) % count] * 116;
      const variation = pointRadius(index, x, y, weights[index]);
      return {
        index,
        x,
        y,
        radius: variation.radius,
        weight: variation.weight,
        anchor: false,
      };
    });
  }

  const radius = clamp(Math.min(safeWidth, safeHeight) * 0.045, 6.5, 10);
  const raw = sampleContour({
    width: safeWidth,
    height: safeHeight,
    radius,
    count,
    phasePx: shape === "focus" ? phasePx : 0,
  });
  const anchors = cornerAnchors(raw, safeWidth, safeHeight, radius);
  return raw.map((point, index) => {
    const variation = pointRadius(index, point.x, point.y, weights[index]);
    const direction =
      shape === "hover" ? 0.25 + variation.weight * 1.2 : 0;
    return {
      index,
      x: ((point.x + direction) / safeWidth) * 100,
      y: ((point.y + direction) / safeHeight) * 100,
      radius: variation.radius,
      weight: variation.weight,
      anchor: shape === "selected" && anchors.has(index),
    };
  });
}

export function latticeCells({
  completed,
  total,
  status = "active",
  maxCells = LATTICE_PROGRESS_MAX_CELLS,
}: {
  completed: number;
  total: number;
  status?: LatticeStatus;
  maxCells?: number;
}): LatticeCell[] {
  const count = Number.isFinite(maxCells)
    ? Math.max(
        1,
        Math.min(LATTICE_PROGRESS_MAX_CELLS, Math.floor(maxCells)),
      )
    : LATTICE_PROGRESS_MAX_CELLS;
  if (!Number.isFinite(total) || total <= 0) {
    return Array.from({ length: count }, (_, index) => ({
      index,
      start: 0,
      end: 0,
      status: "unknown" as const,
    }));
  }
  const safeCompleted = Number.isFinite(completed)
    ? Math.max(0, Math.min(completed, total))
    : 0;
  const doneCount = Math.floor((safeCompleted / total) * count);
  const remainingStatus = status === "done" ? "active" : status;
  return Array.from({ length: count }, (_, index) => {
    const start = Math.floor((index * total) / count);
    const end = Math.floor(((index + 1) * total) / count);
    const isDone = index < doneCount;
    const isError =
      status === "error" && index === Math.min(doneCount, count - 1);
    return {
      index,
      start,
      end,
      status: isDone ? "done" : isError ? "error" : remainingStatus,
    };
  });
}

export function latticePercent(
  completed: number,
  total: number,
): number | null {
  if (!Number.isFinite(total) || total <= 0) return null;
  const safeCompleted = Number.isFinite(completed)
    ? Math.max(0, Math.min(completed, total))
    : 0;
  return Math.round((safeCompleted / total) * 100);
}

export function latticeSelection({
  hovered = false,
  focused = false,
  selected = false,
}: {
  hovered?: boolean;
  focused?: boolean;
  selected?: boolean;
}): { shape: LatticeShape } {
  if (selected) return { shape: "selected" };
  if (focused) return { shape: "focus" };
  if (hovered) return { shape: "hover" };
  return { shape: "none" };
}

export function resolveVisualOwner({
  overturePlaying = false,
  cardHovered = false,
  lensPressed = false,
}: {
  overturePlaying?: boolean;
  cardHovered?: boolean;
  lensPressed?: boolean;
}): "none" | "lattice" | "lens" | "overture" {
  if (overturePlaying) return "overture";
  if (lensPressed) return "lens";
  if (cardHovered) return "lattice";
  return "none";
}
