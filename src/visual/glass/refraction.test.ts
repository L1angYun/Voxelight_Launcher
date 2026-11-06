import { describe, expect, it } from "vitest";
import { createCurvatureMap, sampleCurvatureDisplacement } from "./geometry";
import * as geometry from "./geometry";

describe("rounded glass curvature", () => {
  const shape = { width: 220, height: 100, radius: 22, bevel: 14 };

  it("keeps the broad flat interior free of displacement", () => {
    expect(sampleCurvatureDisplacement(shape, 110, 50)).toEqual({ x: 0, y: 0 });
    expect(sampleCurvatureDisplacement(shape, 40, 25)).toEqual({ x: 0, y: 0 });
  });

  it("bends opposite bevels in opposite normal directions", () => {
    const left = sampleCurvatureDisplacement(shape, 3, 50);
    const right = sampleCurvatureDisplacement(shape, 217, 50);
    const top = sampleCurvatureDisplacement(shape, 110, 3);
    const bottom = sampleCurvatureDisplacement(shape, 110, 97);
    expect(left.x).toBeGreaterThan(0);
    expect(left.x * Math.max(...geometry.lensChromaticScales())).toBeLessThanOrEqual(shape.bevel / 2);
    expect(left.y).toBe(0);
    expect(right.x).toBeCloseTo(-left.x, 8);
    expect(top.y).toBeGreaterThan(0);
    expect(top.y * Math.max(...geometry.lensChromaticScales())).toBeLessThanOrEqual(shape.bevel / 2);
    expect(top.x).toBe(0);
    expect(bottom.y).toBeCloseTo(-top.y, 8);
    expect(sampleCurvatureDisplacement(shape, 12, 50).x).toBeLessThan(left.x);
  });

  it("turns the displacement along the rounded corner instead of a rectangular edge", () => {
    const corner = sampleCurvatureDisplacement(shape, 9, 9);
    expect(corner.x).toBeGreaterThan(0.1);
    expect(corner.x).toBeCloseTo(corner.y, 8);
    expect(sampleCurvatureDisplacement(shape, 0, 0)).toEqual({ x: 0, y: 0 });
  });

  it("uses physical bevel width when a surface becomes much wider", () => {
    const wide = { ...shape, width: 1400 };
    expect(sampleCurvatureDisplacement(wide, 3, 50)).toEqual(
      sampleCurvatureDisplacement(shape, 3, 50),
    );
    expect(sampleCurvatureDisplacement(wide, 700, 50)).toEqual({ x: 0, y: 0 });
  });

  it("encodes a neutral center and bounds raster allocation for a large surface", () => {
    const map = createCurvatureMap({ width: 1440, height: 900, radius: 24 });
    expect(map.width).toBe(512);
    expect(map.height).toBe(320);
    expect(map.data).toHaveLength(512 * 320 * 4);
    const center = (160 * 512 + 256) * 4;
    expect(Array.from(map.data.slice(center, center + 4))).toEqual([128, 128, 0, 255]);
  });

  it("does not allocate invalid or empty map dimensions", () => {
    const map = createCurvatureMap({ width: Number.NaN, height: -4, radius: Infinity });
    expect(map.width).toBe(1);
    expect(map.height).toBe(1);
    expect(map.data).toHaveLength(4);
  });

  it("changes real backdrop curvature with pressure while preserving clear center", () => {
    const pressed = { ...shape, optics: { bendX: 0, bendY: 0, pressure: 0.9, energy: 0.1, stretch: 0.1, heading: 0 } };
    expect(sampleCurvatureDisplacement(pressed, 4, 50)).not.toEqual(sampleCurvatureDisplacement(shape, 4, 50));
    expect(sampleCurvatureDisplacement(pressed, 110, 50)).toEqual({ x: 0, y: 0 });
    expect(createCurvatureMap(pressed).data).not.toEqual(createCurvatureMap(shape).data);
  });

  it("bows the same contour and normal field with directional edge lag", () => {
    const bent = { ...shape, optics: { bendX: 7, bendY: -3, pressure: 0.4, energy: 0.2, stretch: 0.12, heading: 0.3 } };
    expect(sampleCurvatureDisplacement(bent, 5, 50)).not.toEqual(sampleCurvatureDisplacement(shape, 5, 50));
    const functions = geometry as typeof geometry & { lensBoundaryPath: (input: typeof bent | typeof shape) => string };
    expect(functions.lensBoundaryPath).toBeTypeOf("function");
    expect(functions.lensBoundaryPath(bent)).not.toBe(functions.lensBoundaryPath(shape));
  });

  it("limits chromatic separation to a quiet bevel effect", () => {
    const functions = geometry as typeof geometry & { lensChromaticScales: (pressure: number, stretch: number) => [number, number, number] };
    expect(functions.lensChromaticScales).toBeTypeOf("function");
    const rest = functions.lensChromaticScales(0, 0);
    const held = functions.lensChromaticScales(1, 0.2);
    expect(rest[0]).toBeGreaterThan(rest[1]);
    expect(rest[1]).toBeGreaterThan(rest[2]);
    expect(held[1]).toBeGreaterThan(rest[1]);
    // Offset channels range ±0.48; full red/blue separation stays under 1px.
    expect((held[0] - held[2]) * 0.48).toBeLessThan(1);
  });
});
