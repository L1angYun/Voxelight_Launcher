// SPDX-License-Identifier: GPL-3.0-only

export const CUBE_SIZE_PX = 32;
export const CUBE_PITCH_PX = 56;
// Orthographic camera elevation. The full yaw envelope is < 46px on both axes.
export const CUBE_VIEW_SINE = 1 / 3;
export const CUBE_CELL_CLEAR_PX = 55;
export const CUBE_MAX_PROJECTION_HALF_PX = CUBE_SIZE_PX / Math.SQRT2;
export const CUBE_CANVAS_EDGE_GUARD_PX = 2;

export type Point2 = { x: number; y: number };
export type PointerSweep = { from: Point2; to: Point2 };

export function cameraSweepToField(
  sweep: PointerSweep,
  viewport: { width: number; height: number },
  camera: { x: number; y: number; scale: number },
  screenRadius: number,
): PointerSweep & { radius: number } {
  const inverse = (point: Point2) => ({
    x:
      (point.x - viewport.width / 2 - camera.x) / camera.scale +
      viewport.width / 2,
    y:
      (point.y - viewport.height / 2 - camera.y) / camera.scale +
      viewport.height / 2,
  });
  return {
    from: inverse(sweep.from),
    to: inverse(sweep.to),
    radius: screenRadius / camera.scale,
  };
}

type ProjectedVertex = Point2 & { depth: number };
type Face = { vertices: ProjectedVertex[]; light: number; depth: number };
export type CubeProjection = {
  vertices: ProjectedVertex[];
  faces: Face[];
  boundary: Point2[];
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
};

const VERTICES = [
  [-1, -1, -1],
  [1, -1, -1],
  [1, 1, -1],
  [-1, 1, -1],
  [-1, -1, 1],
  [1, -1, 1],
  [1, 1, 1],
  [-1, 1, 1],
] as const;
const FACES = [
  { indices: [0, 1, 5, 4], normal: [0, -1, 0] },
  { indices: [3, 7, 6, 2], normal: [0, 1, 0] },
  { indices: [4, 5, 6, 7], normal: [0, 0, 1] },
  { indices: [1, 0, 3, 2], normal: [0, 0, -1] },
  { indices: [5, 1, 2, 6], normal: [1, 0, 0] },
  { indices: [0, 4, 7, 3], normal: [-1, 0, 0] },
] as const;

function cross(origin: Point2, a: Point2, b: Point2) {
  return (
    (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x)
  );
}

function convexBoundary(vertices: Point2[]): Point2[] {
  const points = [...vertices].sort((a, b) => a.x - b.x || a.y - b.y);
  const lower: Point2[] = [];
  const upper: Point2[] = [];
  for (const point of points) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2], lower.at(-1)!, point) <= 1e-8
    )
      lower.pop();
    lower.push(point);
  }
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index];
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2], upper.at(-1)!, point) <= 1e-8
    )
      upper.pop();
    upper.push(point);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Rotate all eight solid vertices about the origin; never resize a face. */
export function cubeProjection(rotation: number): CubeProjection {
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);
  const elevationCosine = Math.sqrt(1 - CUBE_VIEW_SINE ** 2);
  const half = CUBE_SIZE_PX / 2;
  const vertices = VERTICES.map(([x, y, z]) => {
    const rotatedX = (x * cosine + z * sine) * half;
    const rotatedZ = (-x * sine + z * cosine) * half;
    return {
      x: rotatedX,
      y: y * half * elevationCosine + rotatedZ * CUBE_VIEW_SINE,
      depth: -y * half * CUBE_VIEW_SINE + rotatedZ * elevationCosine,
    };
  });
  const faces: Face[] = [];
  for (const {
    indices,
    normal: [x, y, z],
  } of FACES) {
    const normalX = x * cosine + z * sine;
    const normalZ = -x * sine + z * cosine;
    if (-y * CUBE_VIEW_SINE + normalZ * elevationCosine <= 1e-8) continue;
    const points = indices.map((index) => vertices[index]);
    faces.push({
      vertices: points,
      depth: points.reduce((sum, point) => sum + point.depth, 0) / 4,
      light: Math.max(
        0,
        Math.min(1, -normalX * 0.38 - y * 0.76 + normalZ * 0.52),
      ),
    });
  }
  faces.sort((a, b) => a.depth - b.depth);
  return {
    vertices,
    faces,
    boundary: convexBoundary(vertices),
    bounds: {
      minX: Math.min(...vertices.map((point) => point.x)),
      maxX: Math.max(...vertices.map((point) => point.x)),
      minY: Math.min(...vertices.map((point) => point.y)),
      maxY: Math.max(...vertices.map((point) => point.y)),
    },
  };
}

function pointSegmentDistanceSquared(
  point: Point2,
  start: Point2,
  end: Point2,
) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(
          0,
          Math.min(
            1,
            ((point.x - start.x) * dx + (point.y - start.y) * dy) /
              lengthSquared,
          ),
        );
  return (point.x - start.x - t * dx) ** 2 + (point.y - start.y - t * dy) ** 2;
}

function segmentDistanceSquared(a: Point2, b: Point2, c: Point2, d: Point2) {
  const first = cross(a, b, c);
  const second = cross(a, b, d);
  const third = cross(c, d, a);
  const fourth = cross(c, d, b);
  if (first * second < 0 && third * fourth < 0) return 0;
  return Math.min(
    pointSegmentDistanceSquared(a, c, d),
    pointSegmentDistanceSquared(b, c, d),
    pointSegmentDistanceSquared(c, a, b),
    pointSegmentDistanceSquared(d, a, b),
  );
}

/** Distance is to the true projected solid boundary, including edge contact. */
export function cubeSweepIntersects(
  sweep: PointerSweep,
  center: Point2,
  projection: CubeProjection,
  radius: number,
): boolean {
  const from = { x: sweep.from.x - center.x, y: sweep.from.y - center.y };
  const to = { x: sweep.to.x - center.x, y: sweep.to.y - center.y };
  const { minX, maxX, minY, maxY } = projection.bounds;
  if (
    Math.max(from.x, to.x) + radius < minX - 1e-8 ||
    Math.min(from.x, to.x) - radius > maxX + 1e-8 ||
    Math.max(from.y, to.y) + radius < minY - 1e-8 ||
    Math.min(from.y, to.y) - radius > maxY + 1e-8
  )
    return false;
  const boundary = projection.boundary;
  const inside = (point: Point2) =>
    boundary.every(
      (start, index) =>
        cross(start, boundary[(index + 1) % boundary.length], point) >= -1e-8,
    );
  if (inside(from) || inside(to)) return true;
  return boundary.some(
    (start, index) =>
      segmentDistanceSquared(
        from,
        to,
        start,
        boundary[(index + 1) % boundary.length],
      ) <=
      radius * radius + 1e-8,
  );
}

/** Shared by WorldScene and standalone visual inspection; no test-only path. */
export function paintCubeProjection(
  context: CanvasRenderingContext2D,
  projection: CubeProjection,
  center: Point2,
  faceColor: (light: number) => string,
) {
  for (const face of projection.faces) {
    context.beginPath();
    face.vertices.forEach((point, index) => {
      if (index === 0) context.moveTo(center.x + point.x, center.y + point.y);
      else context.lineTo(center.x + point.x, center.y + point.y);
    });
    context.closePath();
    context.fillStyle = faceColor(face.light);
    context.fill();
  }
}
