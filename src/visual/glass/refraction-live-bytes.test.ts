// SPDX-License-Identifier: GPL-3.0-only
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCurvatureMap } from "./geometry";
import baseline from "./__fixtures__/curvature-6921a83-live.json";

describe("live curvature byte compatibility with 6921a83", () => {
  for (const { shape, maps } of baseline.cases) {
    it(`preserves ${maps.length} live poses at ${shape.width}x${shape.height}`, () => {
      const checksums = baseline.poses.map(optics => {
        const map = createCurvatureMap({ ...shape, optics });
        expect([map.width, map.height]).toEqual([shape.width, shape.height]);
        return createHash("sha256").update(map.data).digest("hex");
      });
      expect(checksums).toEqual(maps);
    });
  }
});
