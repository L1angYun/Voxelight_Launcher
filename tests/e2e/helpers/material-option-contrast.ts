export interface OptionRect { left: number; top: number; right: number; bottom: number }
export interface OptionRegion {
  text: string; rgba: number[]; opacity: number; boxes: OptionRect[]; clip: OptionRect;
}
export interface OptionPixelImage { width: number; height: number; pixels: Uint8Array }
export interface OptionSample { x: number; y: number; rgb: number[]; contrast: number }

function luminance(rgb: number[]) {
  return rgb.map(value => {
    const s = value / 255;
    return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4;
  }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
}

export function analyzeOptionContrast(image: OptionPixelImage, region: OptionRegion) {
  const samples: OptionSample[] = [];
  for (const box of region.boxes) {
    const left = Math.max(0, region.clip.left, box.left), right = Math.min(image.width, region.clip.right, box.right);
    const rows = [Math.floor(box.top) - 2, Math.floor(box.top) - 1, Math.ceil(box.bottom), Math.ceil(box.bottom) + 1];
    for (const y of rows) {
      if (y < 0 || y >= image.height || y + .5 < region.clip.top || y + .5 >= region.clip.bottom) continue;
      for (let x = Math.ceil(left - .5); x + .5 < right; x++) {
        const offset = (y * image.width + x) * 4;
        if (image.pixels[offset + 3] !== 255) throw new Error("The normal compositor PNG must be opaque");
        const rgb = [...image.pixels.subarray(offset, offset + 3)];
        const alpha = region.rgba[3] / 255 * region.opacity;
        const foreground = region.rgba.slice(0, 3).map((v, index) => v * alpha + rgb[index] * (1 - alpha));
        const a = luminance(foreground), b = luminance(rgb);
        samples.push({ x, y, rgb, contrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) });
      }
    }
  }
  if (!samples.length) throw new Error("No geometrically eligible option background samples");
  const worst = samples.reduce((a, b) => a.contrast <= b.contrast ? a : b);
  return { ...region, samples, minimum: worst.contrast, worst };
}
