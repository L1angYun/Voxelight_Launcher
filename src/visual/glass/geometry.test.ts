import { describe, expect, it } from "vitest";
import { clampRadius, normalizeRect, relativeRect, intersectRects } from "./geometry";

describe("glass geometry", () => {
  it("clips a scrolled surface without changing its rounded shape bounds", () => {
    expect(intersectRects({ x: 10, y: 40, width: 200, height: 80 }, { x: 0, y: 72, width: 1000, height: 600 }))
      .toEqual({ x: 10, y: 72, width: 200, height: 48 });
    expect(intersectRects({ x: 10, y: -100, width: 200, height: 30 }, { x: 0, y: 72, width: 1000, height: 600 }).height).toBe(0);
  });
  it("clamps radius to the actual surface bounds", () => {
    expect(clampRadius(24, 40, 20)).toBe(10);
    expect(clampRadius(-4, 40, 20)).toBe(0);
    expect(clampRadius(4, 40, 20)).toBe(4);
  });

  it("normalizes invalid rectangles and scales them for DPR", () => {
    expect(normalizeRect({ x: -4, y: 3, width: -20, height: 12 }, 2)).toEqual({
      x: -8,
      y: 6,
      width: 0,
      height: 24,
    });
  });

  it("computes a surface rectangle relative to its glass root", () => {
    expect(relativeRect({ left: 100, top: 80 }, { left: 130, top: 110, width: 200, height: 60 })).toEqual({
      x: 30,
      y: 30,
      width: 200,
      height: 60,
    });
  });
});
