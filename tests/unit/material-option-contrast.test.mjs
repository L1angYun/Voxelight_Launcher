import test from "node:test";
import assert from "node:assert/strict";
import { analyzeOptionContrast } from "../e2e/helpers/material-option-contrast.ts";

const image = () => ({ width: 10, height: 10, pixels: new Uint8Array(10 * 10 * 4).fill(255) });
const region = {
  text: "Option", rgba: [0, 0, 0, 255], opacity: 1,
  boxes: [{ left: 2.2, top: 4, right: 7.8, bottom: 6 }],
  clip: { left: 2, top: 3, right: 8, bottom: 8 },
};

test("option contrast clips sample pixels only to the actual text and option geometry", () => {
  const result = analyzeOptionContrast(image(), region);
  assert.equal(result.samples.length, 18);
  assert.deepEqual([...new Set(result.samples.map(p => p.y))], [3, 6, 7]);
  assert(result.samples.every(p => p.x >= 2 && p.x <= 7));
  assert.equal(result.minimum, 21);
});

test("an isolated low contrast background pixel must not be filtered or averaged away", () => {
  const png = image();
  const at = (6 * png.width + 4) * 4;
  png.pixels[at] = png.pixels[at + 1] = png.pixels[at + 2] = 0;
  const result = analyzeOptionContrast(png, region);
  assert.equal(result.samples.length, 18);
  assert.equal(result.minimum, 1);
  assert.deepEqual(result.worst, { x: 4, y: 6, rgb: [0, 0, 0], contrast: 1 });
});

test("the contrast calculation includes foreground alpha and effective ancestor opacity", () => {
  const result = analyzeOptionContrast(image(), { ...region, opacity: .5 });
  assert(result.minimum > 3.9 && result.minimum < 4);
  assert.throws(() => analyzeOptionContrast(image(), { ...region, clip: { left: 2, top: 4, right: 8, bottom: 6 } }),
    /no geometrically eligible/i);
});
