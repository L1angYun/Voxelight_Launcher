// SPDX-License-Identifier: GPL-3.0-only
export function compareLibraryPixels(before, after, regions, threshold = 8) {
  if (before.width !== after.width || before.height !== after.height) throw new Error('Screenshot dimensions differ');
  const { width, height } = before, pixels = width * height;
  if (before.pixels.length !== pixels * 4 || after.pixels.length !== pixels * 4) throw new Error('Invalid RGBA dimensions');
  const mask = new Uint8Array(pixels), changed = new Uint8Array(pixels);
  let changedPixels = 0;
  for (let pixel = 0; pixel < pixels; pixel++) {
    const at = pixel * 4;
    if ([0, 1, 2].some(channel => Math.abs(before.pixels[at + channel] - after.pixels[at + channel]) > threshold)) {
      changed[pixel] = 1; changedPixels++;
    }
  }
  const regionResults = regions.map(region => {
    const left = Math.max(0, Math.floor(region.left)), right = Math.min(width, Math.ceil(region.right));
    const top = Math.max(0, Math.floor(region.top)), bottom = Math.min(height, Math.ceil(region.bottom));
    let area = 0, changedPixels = 0;
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
      const pixel = y * width + x;
      mask[pixel] = 1; area++; changedPixels += changed[pixel];
    }
    return { name: region.name, pixels: area, changedPixels, changedFraction: area ? changedPixels / area : 0 };
  });
  let outsidePixels = 0, outsideChangedPixels = 0;
  for (let pixel = 0; pixel < pixels; pixel++) if (!mask[pixel]) {
    outsidePixels++; outsideChangedPixels += changed[pixel];
  }
  return { changedPixels, changedFraction: changedPixels / pixels, outsidePixels, outsideChangedPixels,
    outsideFraction: outsidePixels ? outsideChangedPixels / outsidePixels : null, regions: regionResults };
}
