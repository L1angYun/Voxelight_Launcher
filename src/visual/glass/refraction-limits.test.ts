// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createCurvatureMap, lensBoundaryPath, lensChromaticScales, sampleCurvatureDisplacement } from "./geometry";
import baseline from "./__fixtures__/curvature-before-r6.json";

describe("S4 size-bounded source sampling", () => {
  for (const [width, height, radius] of [[68, 44, 22], [40, 32, 16], [96, 40, 20]]) {
    it(`${width}x${height}: the actual encoded top-bevel mapping has derivative at least one half`, () => {
      const shape = { width, height, radius, bevel: 20, inset: 3, refraction: .9, dispersion: .65 };
      const bevel = Math.min(20, (width - 6) * .44, (height - 6) * .44);
      const scales = lensChromaticScales(0, 0, .9, .65);
      const map = createCurvatureMap(shape);
      expect([map.width, map.height]).toEqual([width, height]);
      // The straight top segment has an independently known vertical normal.
      // Decode the stored map and use every RGB filter scale, not only the
      // continuous sampler or the green channel's smaller displacement.
      const column = Math.floor(width / 2), derivatives: number[] = [];
      for (let row = 3; row + 1.5 < 3 + bevel; row++) {
        const before = map.data[(row * map.width + column) * 4 + 1] / 255 - .5;
        const after = map.data[((row + 1) * map.width + column) * 4 + 1] / 255 - .5;
        for (const scale of scales) derivatives.push(1 + scale * (after - before));
      }
      expect(derivatives.length).toBeGreaterThan(0);
      expect.soft(Math.min(...derivatives)).toBeGreaterThanOrEqual(.5);
      const peak = Math.abs(sampleCurvatureDisplacement(shape, width / 2, 3).y) * Math.max(...scales);
      expect.soft(peak).toBeLessThanOrEqual(.5 * bevel);
    });
  }

  const digest = (value: Uint8ClampedArray | string) => createHash("sha256").update(value).digest("hex");
  for (const entry of baseline.cases) {
    it(`keeps ${entry.owner} ${entry.shape.width}x${entry.shape.height} dimensions and contour while limiting its formerly over-budget map`, () => {
      const { shape } = entry;
      const map = createCurvatureMap(shape);
      const bevel = Math.min(20, (shape.width - 6) * .44, (shape.height - 6) * .44);
      expect(shape.refraction).toBe(.9); expect(shape.dispersion).toBe(.65);
      lensChromaticScales(0, 0, shape.refraction, shape.dispersion).forEach((value, index) =>
        expect(value).toBeCloseTo([29.268, 28.8, 28.332][index], 12));
      expect(.48 * 29.268).toBeGreaterThan(.5 * bevel);
      expect([map.width, map.height]).toEqual(entry.mapSize);
      expect(digest(lensBoundaryPath(shape))).toBe(entry.boundarySha256);
      // All fifteen actual resting geometries were over budget. They must be
      // reported as changed, not passed off as unchanged large-surface cases.
      expect(digest(map.data)).not.toBe(entry.beforeBytesSha256);
      let maximum = 0;
      for (let at = 0; at < map.data.length; at += 4)
        maximum = Math.max(maximum, Math.hypot(map.data[at] / 255 - .5, map.data[at + 1] / 255 - .5) * 29.268);
      expect(maximum).toBeGreaterThanOrEqual(2);
      expect(maximum).toBeLessThanOrEqual(.5 * bevel);
    });
  }

  for (const entry of baseline.compatibility) {
    it(`preserves every encoded byte for a synthetic already-in-budget ${entry.shape.width}x${entry.shape.height} surface`, () => {
      const { shape } = entry, map = createCurvatureMap(shape);
      expect(.48 * Math.max(...lensChromaticScales(0, 0, shape.refraction, shape.dispersion))).toBeLessThanOrEqual(10);
      expect([map.width, map.height]).toEqual(entry.mapSize);
      expect(digest(map.data)).toBe(entry.beforeBytesSha256);
    });
  }
});
