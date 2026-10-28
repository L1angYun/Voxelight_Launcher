import type { GlassRect } from "./types";

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
