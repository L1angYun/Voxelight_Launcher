import assert from 'node:assert/strict';
import test from 'node:test';
import { compareLibraryPixels } from '../e2e/helpers/library-image-comparison.mjs';

const image = (changes = []) => {
  const pixels = new Uint8Array(16).fill(255);
  for (const [index, value] of changes) for (const channel of [0, 1, 2]) pixels[index * 4 + channel] = value;
  return { width: 2, height: 2, pixels };
};
test('library image comparison reports raw differences separately from declared intentional regions', () => {
  const result = compareLibraryPixels(image(), image([[0, 0], [3, 250]]), [{ name: 'card', left: 0, top: 0, right: 1, bottom: 1 }]);
  assert.equal(result.changedPixels, 1); assert.equal(result.changedFraction, .25);
  assert.equal(result.outsidePixels, 3); assert.equal(result.outsideChangedPixels, 0); assert.equal(result.outsideFraction, 0);
  assert.deepEqual(result.regions, [{ name: 'card', pixels: 1, changedPixels: 1, changedFraction: 1 }]);
});
test('library masks form a union, retain unmasked failures, and do not double count overlap', () => {
  const rect = { left: 0, top: 0, right: 1, bottom: 1 };
  const result = compareLibraryPixels(image(), image([[0, 0], [1, 0]]), [{ name: 'old', ...rect }, { name: 'new', ...rect }]);
  assert.equal(result.changedPixels, 2); assert.equal(result.outsidePixels, 3);
  assert.equal(result.outsideChangedPixels, 1); assert.equal(result.outsideFraction, 1 / 3);
});
test('library pixel threshold is strict and image geometry cannot be silently resized', () => {
  const result = compareLibraryPixels(image(), image([[0, 247], [1, 246]]), []);
  assert.equal(result.changedPixels, 1); assert.equal(result.outsideFraction, .25);
  assert.throws(() => compareLibraryPixels(image(), { ...image(), width: 1 }, []), /dimensions/);
});
