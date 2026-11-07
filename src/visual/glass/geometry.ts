import type { GlassOptics, GlassRect } from "./types";
import { createNormalDerivativeCheck } from "./curvatureBounds";

export function intersectRects(first: GlassRect, second: GlassRect): GlassRect {
  const x = Math.max(first.x, second.x);
  const y = Math.max(first.y, second.y);
  return { x, y, width: Math.max(0, Math.min(first.x + first.width, second.x + second.width) - x),
    height: Math.max(0, Math.min(first.y + first.height, second.y + second.height) - y) };
}

export function clampRadius(radius: number, width: number, height: number): number {
  return Math.max(0, Math.min(radius, Math.max(0, width) / 2, Math.max(0, height) / 2));
}

export function normalizeRect(rect: GlassRect, dpr = 1): GlassRect {
  return {
    x: rect.x * dpr,
    y: rect.y * dpr,
    width: Math.max(0, rect.width) * dpr,
    height: Math.max(0, rect.height) * dpr,
  };
}

export function relativeRect(
  root: Pick<DOMRect, "left" | "top">,
  surface: Pick<DOMRect, "left" | "top" | "width" | "height">,
): GlassRect {
  return {
    x: surface.left - root.left,
    y: surface.top - root.top,
    width: surface.width,
    height: surface.height,
  };
}

export interface CurvatureGeometry {
  width: number;
  height: number;
  radius: number;
  bevel?: number;
  inset?: number;
  optics?: GlassOptics;
  refraction?: number;
  dispersion?: number;
}

/** Original tuning: 14 CSS px bevel, at most 512 samples per map axis. */
export const curvatureMapLimit = 512;
export const curvatureDisplacementScale = 24;

/** Public Thick normalized values; coefficients below are original tuning. */
export const lensMaterial = { refraction: 0.9, frost: 0.24, dispersion: 0.65, elasticity: 0.7 } as const;

export function lensChromaticScales(pressure = 0, stretch = 0, refraction: number = lensMaterial.refraction, dispersion: number = lensMaterial.dispersion): [number, number, number] {
  const scale = 32 * Math.max(0.05, Math.min(1.4, refraction)) * (1 + Math.max(0, Math.min(1.16, pressure)) * 0.14 + Math.abs(stretch) * 0.28);
  const split = Math.max(0, Math.min(1, dispersion)) * 0.025;
  return [scale * (1 + split), scale, scale * (1 - split)];
}

function lensBody(shape: CurvatureGeometry) {
  const width = positiveSize(shape.width), height = positiveSize(shape.height);
  const inset = Math.max(0, Math.min(shape.inset ?? 0, width / 8, height / 8));
  const pressure = Math.max(0, Math.min(1.16, shape.optics?.pressure ?? 0));
  const radius = clampRadius((Number.isFinite(shape.radius) ? shape.radius : 0) * (1 + pressure * 0.08), width - 2 * inset, height - 2 * inset);
  const bendX = Math.max(-8, Math.min(8, shape.optics?.bendX ?? 0)) * 0.32;
  const bendY = Math.max(-8, Math.min(8, shape.optics?.bendY ?? 0)) * 0.32;
  // With one zero bend the other axis already converges in one iteration.
  const warpIterations = bendX === 0 && bendY === 0 ? 0 : bendX === 0 || bendY === 0 ? 1 : 3;
  return { width, height, inset, pressure, radius, bendX, bendY, warpIterations };
}

function lensDistance(body: ReturnType<typeof lensBody>, x: number, y: number): number {
  const px = x - body.width / 2, py = y - body.height / 2;
  let ux = px, uy = py;
  // Invert the same smooth bow used to draw the contour. Bounded displacement
  // makes three fixed-point steps accurate without moving the layout box.
  for (let i = 0; i < body.warpIterations; i++) {
    const qx = Math.max(-1, Math.min(1, ux / (body.width / 2)));
    const qy = Math.max(-1, Math.min(1, uy / (body.height / 2)));
    ux = px - body.bendX * (1 - qy * qy);
    uy = py - body.bendY * (1 - qx * qx);
  }
  const qx = Math.abs(ux) - body.width / 2 + body.inset + body.radius;
  const qy = Math.abs(uy) - body.height / 2 + body.inset + body.radius;
  const outerX = Math.max(0, qx), outerY = Math.max(0, qy);
  const outside = outerX === 0 ? outerY : outerY === 0 ? outerX : Math.hypot(outerX, outerY);
  return Math.min(Math.max(qx, qy), 0) + outside - body.radius;
}

/** The actual local silhouette, shared by clipping and directional reflection. */
export function lensBoundaryPath(shape: CurvatureGeometry): string {
  const body = lensBody(shape);
  const points: string[] = [];
  const corners = [[1, -1], [1, 1], [-1, 1], [-1, -1]];
  for (let corner = 0; corner < 4; corner++) {
    const [sx, sy] = corners[corner];
    const cx = sx * (body.width / 2 - body.inset - body.radius);
    const cy = sy * (body.height / 2 - body.inset - body.radius);
    for (let step = 0; step <= 12; step++) {
      const angle = -Math.PI / 2 + corner * Math.PI / 2 + step * Math.PI / 24;
      const x = cx + Math.cos(angle) * body.radius, y = cy + Math.sin(angle) * body.radius;
      const qx = x / (body.width / 2), qy = y / (body.height / 2);
      const warpedX = x + body.bendX * (1 - qy * qy) + body.width / 2;
      const warpedY = y + body.bendY * (1 - qx * qx) + body.height / 2;
      points.push(`${points.length ? "L" : "M"}${warpedX.toFixed(2)},${warpedY.toFixed(2)}`);
    }
  }
  return `${points.join(" ")} Z`;
}

function positiveSize(value: number): number {
  return Number.isFinite(value) ? Math.max(1, value) : 1;
}

/**
 * A rounded lens has a flat center and a curved bevel. These normalized offsets
 * encode an inward optical pull; they describe curvature, never backdrop color.
 */
export function sampleCurvatureDisplacement(
  shape: CurvatureGeometry,
  x: number,
  y: number,
): { x: number; y: number } {
  const body = lensBody(shape);
  const field = curvatureField(shape, body);
  const offset = sampleField(body, field.bevel, field.profileWidth, field.preserve, x, y);
  // This is the continuous seed. Raster encoding below can reduce it further
  // when an eight-bit rounding step would exceed the source-derivative budget.
  return { x: offset.x * field.ratio, y: offset.y * field.ratio };
}

function curvatureField(shape: CurvatureGeometry, body: ReturnType<typeof lensBody>) {
  const anisotropy = (shape.optics?.stretch ?? 0) * Math.cos(2 * (shape.optics?.heading ?? 0));
  const bevel = Math.min(positiveSize(shape.bevel ?? 20) * (1 + body.pressure * 0.16 + anisotropy * 0.2),
    (body.width - 2 * body.inset) * 0.44, (body.height - 2 * body.inset) * 0.44);
  const scales = lensChromaticScales(body.pressure, shape.optics?.stretch ?? 0,
    shape.refraction, shape.dispersion);
  // Live optics serializes scales to three decimals; include both that value
  // and the unrounded initial SVG value in the derivative/amplitude budget.
  const scale = Math.max(...scales, ...scales.map(value => Number(value.toFixed(3))));
  const peak = .48 * scale;
  const preserve = peak <= .5 * bevel;
  // Round the new budget inward, so floating-point multiply/divide cannot put
  // the continuous seed one ULP above A <= B/2. Preserved bytes bypass this.
  return { bevel, scale, preserve, ratio: preserve ? 1 : Math.min(1, .5 * bevel / peak) * (1 - 4 * Number.EPSILON),
    // A linear outer ramp may end before B. Keeping it flat at a rounded-box
    // medial axis avoids a nonzero displacement with a discontinuous normal.
    // The declared bevel, radius, contour, and raster dimensions do not change.
    profileWidth: Math.min(bevel, body.radius) };
}

function sampleField(body: ReturnType<typeof lensBody>, bevel: number, profileWidth: number,
  preserve: boolean, x: number, y: number): { x: number; y: number } {
  const distance = lensDistance(body, x, y);
  if (!Number.isFinite(distance) || distance > 0 || distance <= -bevel) return { x: 0, y: 0 };
  let pull: number;
  if (preserve) {
    // Keep the original arithmetic and encoding for already-compliant budgets.
    const portion = 1 + distance / bevel;
    pull = portion * portion * (3 - 2 * portion) * 0.48;
  } else {
    if (profileWidth <= 0 || distance <= -profileWidth) return { x: 0, y: 0 };
    pull = .48 * Math.max(0, Math.min(1, 1 + distance / profileWidth));
  }
  const dx = lensDistance(body, x + 0.25, y) - lensDistance(body, x - 0.25, y);
  const dy = lensDistance(body, x, y + 0.25) - lensDistance(body, x, y - 0.25);
  const length = (dx === 0 ? Math.abs(dy) : dy === 0 ? Math.abs(dx) : Math.hypot(dx, dy)) || 1;
  return {
    x: dx === 0 ? 0 : -dx / length * pull,
    y: dy === 0 ? 0 : -dy / length * pull,
  };
}

/** Raster size is bounded independently from the optical dimensions in CSS px. */
export function createCurvatureMap(shape: CurvatureGeometry): {
  width: number;
  height: number;
  data: Uint8ClampedArray;
} {
  const sourceWidth = positiveSize(shape.width);
  const sourceHeight = positiveSize(shape.height);
  const resolution = Math.min(1, curvatureMapLimit / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * resolution));
  const height = Math.max(1, Math.round(sourceHeight * resolution));
  const data = new Uint8ClampedArray(width * height * 4);
  const body = lensBody(shape), field = curvatureField(shape, body);
  const samples = field.preserve ? null : new Float64Array(width * height * 2);
  const affected = samples ? new Uint32Array(width * height) : null;
  let affectedCount = 0;
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const at = (row * width + column) * 4;
      const offset = sampleField(body, field.bevel, field.profileWidth, field.preserve,
        (column + 0.5) * sourceWidth / width, (row + 0.5) * sourceHeight / height);
      if (samples && affected) {
        // Neutral RG is independent of the ratio. Re-encode only the bevel
        // when trying another amplitude; the flat center is filled once.
        data[at] = data[at + 1] = 128;
        if (offset.x !== 0 || offset.y !== 0) {
          affected[affectedCount] = row * width + column;
          samples[affectedCount * 2] = offset.x;
          samples[affectedCount * 2 + 1] = offset.y;
          affectedCount++;
        }
      } else {
        data[at] = Math.round((0.5 + offset.x) * 255);
        data[at + 1] = Math.round((0.5 + offset.y) * 255);
      }
      data[at + 3] = 255;
    }
  }
  if (samples && affected) {
    const lowerBound = createNormalDerivativeCheck(body, width, height);
    let ratio = field.ratio;
    for (let attempt = 0; attempt < 130; attempt++) {
      for (let sample = 0; sample < affectedCount; sample++) {
        const at = affected[sample] * 4;
        data[at] = Math.round((.5 + samples[sample * 2] * ratio) * 255);
        data[at + 1] = Math.round((.5 + samples[sample * 2 + 1] * ratio) * 255);
      }
      // Check actual bytes after every reduction: quantization is not monotone
      // in amplitude. A neutral map is the finite final fallback, never an
      // unverified map that violates the derivative floor.
      if (lowerBound.accepts(data, field.scale, .5 + 1e-7)) break;
      ratio = attempt === 128 ? 0 : ratio * .9;
    }
  }
  return { width, height, data };
}
