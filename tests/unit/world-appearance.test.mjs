// SPDX-License-Identifier: GPL-3.0-only
import assert from "node:assert/strict";
import test from "node:test";
import * as appearance from "../e2e/helpers/world-appearance.ts";

const background = [10, 10, 10];
const feet = { x: 199, y: 98, width: 2, height: 2 };

function image(width, height, rgb = background) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index++) pixels.set([...rgb, 255], index * 4);
  return { width, height, pixels };
}
function paint(frame, bounds, rgb) {
  for (let y = bounds[1]; y < bounds[3]; y++) for (let x = bounds[0]; x < bounds[2]; x++)
    frame.pixels.set([...rgb, 255], (y * frame.width + x) * 4);
}

test("island samples follow the feet bottom midpoint and test coverage before the neutral filter", () => {
  const frame = image(400, 200);
  paint(frame, [30, 60, 370, 135], [100, 100, 100]);
  paint(frame, [30, 60, 370, 70], background);
  paint(frame, [30, 70, 370, 71], [0, 200, 0]);
  const measured = appearance.islandMetrics(frame, feet, background);
  assert.deepEqual(measured.bounds, [30, 60, 370, 135]);
  assert.equal(measured.samples, 25500);
  assert.equal(measured.covered, 22100);
  assert.equal(measured.coverage, 65 / 75);
  assert.equal(measured.neutralSamples, 25160);
  assert.equal(measured.mean, 2210000 / 25160);
  assert.equal(measured.p95, 100);
  assert.equal(measured.pureWhite, 0);
  assert.equal(measured.valid, true);

  const moved = appearance.islandMetrics(frame, { x: 209, y: 108, width: 2, height: 2 }, background);
  assert.deepEqual(moved.bounds, [40, 70, 380, 145]);
  // These are actual image coordinates; moving the anchor changes sampled pixels.
  assert.notEqual(moved.mean, measured.mean);
});

test("island coverage uses strict brightness delta and strict neutral channel spread", () => {
  const frame = image(400, 200, [100, 100, 100]);
  paint(frame, [30, 60, 31, 61], [10, 10, 40]); // Mean20: exactly ten from background.
  paint(frame, [31, 60, 32, 61], [0, 0, 65]); // Spread65: excluded from neutral statistics.
  paint(frame, [32, 60, 33, 61], [0, 0, 64]); // Spread64: retained.
  const measured = appearance.islandMetrics(frame, feet, background);
  assert.equal(measured.covered, 25499);
  assert.equal(measured.neutralSamples, 25499);
  assert.ok(Math.abs(measured.mean - (2549700 + 20 + 64 / 3) / 25499) < 1e-12);
  assert.equal(measured.p95, 100);
});

test("island p95 uses nearest rank and counts only exact RGB white", () => {
  const frame = image(340, 75, [100, 100, 100]);
  for (let index = 24225; index < 25500; index++) frame.pixels.set([255, 255, 255, 255], index * 4);
  const anchor = { x: 169, y: 38, width: 2, height: 2 };
  const measured = appearance.islandMetrics(frame, anchor, background);
  assert.equal(measured.mean, 107.75);
  assert.equal(measured.p95, 100);
  assert.equal(measured.pureWhite, 1275);
  assert.equal(measured.pureWhiteFraction, .05);
  frame.pixels.set([255, 255, 255, 255], 24224 * 4);
  assert.equal(appearance.islandMetrics(frame, anchor, background).p95, 255);
  frame.pixels.set([255, 255, 254, 255], 24224 * 4);
  assert.equal(appearance.islandMetrics(frame, anchor, background).pureWhite, 1275);
});

test("actual dark background does not turn an exact ten-level difference into island coverage", () => {
  const frame = image(400, 200, [17, 18, 21]);
  const measured = appearance.islandMetrics(frame, feet, [7, 8, 11]);
  assert.equal(measured.covered, 0);
  assert.equal(measured.valid, false);
  paint(frame, [30, 60, 31, 61], [17, 18, 22]);
  assert.equal(appearance.islandMetrics(frame, feet, [7, 8, 11]).covered, 1);
});

test("invalid island coverage and empty neutral samples are explicit rather than NaN", () => {
  const empty = appearance.islandMetrics(image(400, 200), feet, background);
  assert.equal(empty.coverage, 0);
  assert.equal(empty.valid, false);
  assert.match(empty.invalidReason, /ROI 未覆盖岛面/);
  const colored = appearance.islandMetrics(image(400, 200, [0, 200, 0]), feet, background);
  assert.equal(colored.coverage, 1);
  assert.equal(colored.neutralSamples, 0);
  assert.equal(colored.mean, null);
  assert.equal(colored.p95, null);
  assert.equal(colored.pureWhiteFraction, null);
  assert.equal(colored.valid, false);
  assert.match(colored.invalidReason, /中性像素/);
  const clipped = appearance.islandMetrics(image(400, 200), { x: 0, y: 0, width: 2, height: 2 }, background);
  assert.equal(clipped.valid, false);
  assert.match(clipped.invalidReason, /超出截图/);
  assert.throws(() => appearance.islandMetrics(image(400, 200), { ...feet, x: NaN }, background), /锚点/);
});

test("island coverage accepts exactly 85 percent and rejects the next missing pixel", () => {
  const frame = image(340, 75);
  for (let index = 0; index < 21675; index++) frame.pixels.set([100, 100, 100, 255], index * 4);
  const anchor = { x: 169, y: 38, width: 2, height: 2 };
  assert.equal(appearance.islandMetrics(frame, anchor, background).valid, true);
  frame.pixels.set([10, 10, 10, 255], 21674 * 4);
  assert.equal(appearance.islandMetrics(frame, anchor, background).valid, false);
});

test("outside brightness excludes only the island intersection and retains colored pixels", () => {
  const frame = image(400, 450);
  paint(frame, [380, 440, 395, 450], [255, 255, 255]);
  paint(frame, [395, 440, 400, 450], [20, 20, 20]);
  paint(frame, [395, 440, 396, 441], [100, 10, 10]);
  const measured = appearance.outsideIslandMetrics(frame, { x: 224, y: 478, width: 2, height: 2 }, background);
  assert.deepEqual(measured.bounds, [380, 440, 400, 450]);
  assert.deepEqual(measured.excludedBounds, [55, 440, 395, 515]);
  assert.equal(measured.samples, 50);
  assert.equal(measured.excludedSamples, 150);
  assert.equal(measured.meanAbsDelta, 10.4);
  assert.equal(measured.valid, true);
  const empty = appearance.outsideIslandMetrics(frame, { x: 389, y: 458, width: 2, height: 2 }, background);
  assert.equal(empty.samples, 0);
  assert.equal(empty.meanAbsDelta, null);
  assert.equal(empty.valid, false);
});

test("far metrics scale the stated ROI and use maximum-channel p95", () => {
  const frame = image(1280, 720, [0, 0, 0]);
  paint(frame, [900, 235, 1200, 400], [10, 20, 90]);
  const measured = appearance.farMetrics(frame);
  assert.deepEqual(measured.bounds, [900, 235, 1200, 400]);
  assert.equal(measured.samples, 49500);
  assert.equal(measured.p95, 90);
  const wide = appearance.farMetrics(image(1920, 1080, [12, 40, 80]));
  assert.deepEqual(wide.bounds, [1350, 352, 1800, 600]);
  assert.equal(wide.samples, 111600);
  assert.equal(wide.p95, 80);
});

test("lower-world white counts include normal-frame UI and reject near-white colors", () => {
  const frame = image(400, 450);
  paint(frame, [380, 440, 382, 441], [255, 255, 255]);
  paint(frame, [382, 440, 383, 441], [255, 255, 254]);
  paint(frame, [379, 440, 380, 441], [255, 255, 255]);
  const measured = appearance.lowerWorldWhiteMetrics(frame);
  assert.deepEqual(measured.bounds, [380, 440, 400, 450]);
  assert.equal(measured.samples, 200);
  assert.equal(measured.pureWhite, 2);
  assert.equal(measured.fraction, .01);
});
