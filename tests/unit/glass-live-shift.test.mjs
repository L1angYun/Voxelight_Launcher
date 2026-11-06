// SPDX-License-Identifier: GPL-3.0-only
import test from "node:test";
import assert from "node:assert/strict";
import * as probe from "../e2e/helpers/glass-pixel-probe.mjs";

const capsule = {
  left: 160.75, top: 19, width: 68, height: 44,
  radius: 19, inset: 3, profileWidth: 16.72,
};
const clip = { x: 160, y: 19, width: 69, height: 44 };

test("the flat interval follows the actual rounded scanline and pixel centers", () => {
  // After erosion, the corner radius is 2.28. The pixel centers on row 22
  // are half a CSS pixel below the geometric center, with a fractional x origin.
  const region = probe.flatGlassScanline(capsule, clip, 22);
  assert.equal(region.localY, 22.5);
  assert.ok(Math.abs(region.pngLeft - 20.0255000562) < 1e-8);
  assert.ok(Math.abs(region.pngRight - 48.4744999438) < 1e-8);
  assert.equal(probe.flatGlassScanline(capsule, clip, 19), null);
});

test("a stripe that leaves the flat region is recorded but does not affect live shift", () => {
  const region = probe.flatGlassScanline(capsule, clip, 22);
  const flat = { x: 32.4977, offset: 7 };
  const crosses = { x: 42, offset: 9 };
  const bevel = { x: 48.5023, offset: 11 };
  const result = probe.measureGlassLiveShift([flat, crosses, bevel], region);
  assert.deepEqual(result.liveOffsets, [flat]);
  assert.deepEqual(result.bevelOffsets, [crosses, bevel]);
  assert.equal(result.liveShift, 7);
  assert.equal(result.liveShiftPass, true);
});

test("an ineligible seven-pixel move cannot pass and a bad flat move cannot be averaged away", () => {
  const region = probe.flatGlassScanline(capsule, clip, 22);
  const empty = probe.measureGlassLiveShift([{ x: 46, offset: 7 }], region);
  assert.equal(empty.liveShift, null);
  assert.equal(empty.liveShiftPass, false);
  const bad = probe.measureGlassLiveShift([{ x: 25, offset: 5 }, { x: 30, offset: 9 }], region);
  assert.equal(bad.liveShift, 7);
  assert.equal(bad.liveOffsets.length, 2);
  assert.equal(bad.liveShiftPass, false);
});
