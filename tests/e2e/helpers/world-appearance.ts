// SPDX-License-Identifier: GPL-3.0-only
import type { DecodedPng } from "./glass-pixel-probe.mjs";

/** Encoded-channel arithmetic brightness, matching the historical island metric. */
function brightness(r: number, g: number, b: number) { return (r + g + b) / 3; }

export interface FeetBounds { x: number; y: number; width: number; height: number; }
type PixelBounds = [left: number, top: number, right: number, bottom: number];

function requirePixels(image: DecodedPng) {
  if (!Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width <= 0 || image.height <= 0
    || image.pixels.length < image.width * image.height * 4)
    throw new Error("World appearance capture must contain a complete nonempty RGBA image");
}

function islandBounds(feet: FeetBounds): PixelBounds {
  if (![feet.x, feet.y, feet.width, feet.height].every(Number.isFinite) || feet.width <= 0 || feet.height <= 0)
    throw new Error("岛面锚点必须有有限坐标和非零尺寸");
  const cx = feet.x + feet.width / 2, by = feet.y + feet.height;
  // Pixel-aligned half-open bounds, consistently rounded from the DOM rectangle.
  return [cx - 170, by - 40, cx + 170, by + 35].map(Math.round) as PixelBounds;
}

function clippedBounds([left, top, right, bottom]: PixelBounds, width: number, height: number): PixelBounds {
  return [Math.max(0, Math.min(width, left)), Math.max(0, Math.min(height, top)),
    Math.max(0, Math.min(width, right)), Math.max(0, Math.min(height, bottom))];
}

function lowerWorldBounds(image: DecodedPng): PixelBounds {
  return [Math.min(380, image.width), Math.min(440, image.height), image.width, image.height];
}

function p95(values: number[]): number | null {
  if (!values.length) return null;
  values.sort((left, right) => left - right);
  return values[Math.ceil(values.length * .95) - 1];
}

/**
 * M2 island statistics. The caller captures after hiding only the character
 * canvas with visibility:hidden; its layout and the feet rectangle stay intact.
 * Validity is a sampling check, separate from the numerical appearance gates.
 */
export function islandMetrics(image: DecodedPng, feet: FeetBounds, background: readonly [number, number, number]) {
  requirePixels(image);
  const requestedBounds = islandBounds(feet);
  const bounds = clippedBounds(requestedBounds, image.width, image.height);
  const clipped = bounds.some((value, index) => value !== requestedBounds[index]);
  const baseSum = background[0] + background[1] + background[2], values: number[] = [];
  let samples = 0, covered = 0, total = 0, pureWhite = 0;
  for (let y = bounds[1]; y < bounds[3]; y++) for (let x = bounds[0]; x < bounds[2]; x++) {
    const at = (y * image.width + x) * 4;
    const r = image.pixels[at], g = image.pixels[at + 1], b = image.pixels[at + 2];
    const value = brightness(r, g, b);
    samples++;
    // Evaluate geometry coverage on all pixels, before the neutral filter.
    // Compare the algebraically equivalent sums so a mathematical delta of
    // exactly10 cannot round upward after two recurring-third divisions.
    if (Math.abs(r + g + b - baseSum) > 30) covered++;
    if (Math.max(r, g, b) - Math.min(r, g, b) >= 65) continue;
    values.push(value); total += value;
    if (r === 255 && g === 255 && b === 255) pureWhite++;
  }
  const coverage = samples ? covered / samples : 0;
  const invalidReason = clipped ? "岛面 ROI 超出截图范围"
    : !samples ? "岛面 ROI 没有可采样像素"
    : coverage < .85 ? "ROI 未覆盖岛面：与背景亮度差 >10 的像素不足85%"
    : !values.length ? "岛面 ROI 没有通道极差 <65 的中性像素" : null;
  return {
    method: "hidden-character frame; rounded feet-bottom ROI; coverage before neutral spread<65; encoded RGB mean and nearest-rank p95",
    requestedBounds, bounds, samples, covered, coverage, neutralSamples: values.length,
    mean: values.length ? total / values.length : null, p95: p95(values), pureWhite,
    pureWhiteFraction: values.length ? pureWhite / values.length : null,
    valid: invalidReason === null, invalidReason,
  };
}

/** Hidden-character frame, full lower-world region excluding the anchor ROI. No neutral filter. */
export function outsideIslandMetrics(image: DecodedPng, feet: FeetBounds, background: readonly [number, number, number]) {
  requirePixels(image);
  const bounds = lowerWorldBounds(image), excludedBounds = islandBounds(feet), base = brightness(...background);
  let samples = 0, excludedSamples = 0, total = 0;
  for (let y = bounds[1]; y < bounds[3]; y++) for (let x = bounds[0]; x < bounds[2]; x++) {
    if (x >= excludedBounds[0] && x < excludedBounds[2] && y >= excludedBounds[1] && y < excludedBounds[3]) {
      excludedSamples++; continue;
    }
    const at = (y * image.width + x) * 4;
    total += Math.abs(brightness(image.pixels[at], image.pixels[at + 1], image.pixels[at + 2]) - base);
    samples++;
  }
  return {
    method: "hidden-character frame; lower-world rectangle minus island rectangle; absolute encoded RGB mean difference; no neutral filter",
    bounds, excludedBounds, samples, excludedSamples, meanAbsDelta: samples ? total / samples : null,
    valid: samples > 0, invalidReason: samples ? null : "岛外区域没有可采样像素",
  };
}

/** Normal visible frame; retain the historical maximum-channel far-field p95. */
export function farMetrics(image: DecodedPng) {
  requirePixels(image);
  const bounds: PixelBounds = [Math.round(.703 * image.width), Math.round(.326 * image.height),
    Math.round(.9375 * image.width), Math.round(.556 * image.height)];
  const values: number[] = [];
  for (let y = bounds[1]; y < bounds[3]; y++) for (let x = bounds[0]; x < bounds[2]; x++) {
    const at = (y * image.width + x) * 4;
    values.push(Math.max(image.pixels[at], image.pixels[at + 1], image.pixels[at + 2]));
  }
  return { method: "normal frame; proportional rounded ROI; maximum-channel nearest-rank p95", bounds,
    samples: values.length, p95: p95(values), valid: values.length > 0,
    invalidReason: values.length ? null : "远景 ROI 没有可采样像素" };
}

/** D65-relative CIE L* after the standard sRGB transfer, without RGB averaging or rounding. */
function cieLightness(r: number, g: number, b: number) {
  const linear = (channel: number) => {
    const encoded = channel / 255;
    return encoded <= .04045 ? encoded / 12.92 : ((encoded + .055) / 1.055) ** 2.4;
  };
  const y = .2126 * linear(r) + .7152 * linear(g) + .0722 * linear(b);
  return y > 216 / 24389 ? 116 * Math.cbrt(y) - 16 : (24389 / 27) * y;
}

/**
 * R3-4 silhouette measurements from every normal-frame RGB sample. Keep the
 * legacy far-field ROI, compare it with a separate sky strip, and count only
 * complete16px tiles anchored to that ROI's top-left. No color/alpha filtering.
 */
export function silhouetteMetrics(image: DecodedPng, background: readonly [number, number, number]) {
  requirePixels(image);
  if (background.length !== 3 || !background.every(channel => Number.isFinite(channel) && channel >= 0 && channel <= 255))
    throw new Error("Silhouette background must contain three finite RGB channels in [0,255]");
  const farBounds: PixelBounds = [Math.round(.703 * image.width), Math.round(.326 * image.height),
    Math.round(.9375 * image.width), Math.round(.556 * image.height)];
  const skyBounds: PixelBounds = [Math.round(.703 * image.width), Math.round(.15 * image.height),
    Math.round(.9375 * image.width), Math.round(.28 * image.height)];
  const farWidth = farBounds[2] - farBounds[0], farHeight = farBounds[3] - farBounds[1];
  const skySamples = (skyBounds[2] - skyBounds[0]) * (skyBounds[3] - skyBounds[1]);
  if (farWidth <= 0 || farHeight <= 0 || skySamples <= 0)
    throw new Error("Silhouette far and sky ROIs must contain sample pixels");
  const tileSize = 16, tileColumns = Math.floor(farWidth / tileSize), tileRows = Math.floor(farHeight / tileSize);
  const tileCount = tileColumns * tileRows;
  if (!tileCount) throw new Error("Silhouette far ROI must contain a complete16px tile");

  const farValues: number[] = [];
  let farTotal = 0, skyTotal = 0;
  for (let y = farBounds[1]; y < farBounds[3]; y++) for (let x = farBounds[0]; x < farBounds[2]; x++) {
    const at = (y * image.width + x) * 4;
    const value = cieLightness(image.pixels[at], image.pixels[at + 1], image.pixels[at + 2]);
    farValues.push(value); farTotal += value;
  }
  for (let y = skyBounds[1]; y < skyBounds[3]; y++) for (let x = skyBounds[0]; x < skyBounds[2]; x++) {
    const at = (y * image.width + x) * 4;
    skyTotal += cieLightness(image.pixels[at], image.pixels[at + 1], image.pixels[at + 2]);
  }
  const farSamples = farValues.length, farMeanL = farTotal / farSamples, skyMeanL = skyTotal / skySamples;
  let strongTiles = 0;
  for (let row = 0; row < tileRows; row++) for (let column = 0; column < tileColumns; column++) {
    let total = 0;
    for (let y = row * tileSize; y < (row + 1) * tileSize; y++)
      for (let x = column * tileSize; x < (column + 1) * tileSize; x++) total += farValues[y * farWidth + x];
    if (Math.abs(total / (tileSize * tileSize) - skyMeanL) >= 4) strongTiles++;
  }
  farValues.sort((left, right) => left - right);
  const backgroundL = cieLightness(...background);
  return {
    method: "normal frame; all RGB pixels; sRGB linear Y to full-precision CIE L*; nearest-rank P05; complete16px far-anchored tiles",
    farBounds, skyBounds, farSamples, skySamples, farMeanL, skyMeanL, backgroundL,
    deltaL: farMeanL - skyMeanL, tiles: strongTiles / tileCount,
    farP05: farValues[Math.ceil(.05 * farSamples) - 1], skyOffset: skyMeanL - backgroundL,
    tileSize, tileColumns, tileRows, tileCount, strongTiles, valid: true,
  };
}

/** Normal visible frame; exact white includes every pixel in the lower-world rectangle. */
export function lowerWorldWhiteMetrics(image: DecodedPng) {
  requirePixels(image);
  const bounds = lowerWorldBounds(image);
  let samples = 0, pureWhite = 0;
  for (let y = bounds[1]; y < bounds[3]; y++) for (let x = bounds[0]; x < bounds[2]; x++) {
    const at = (y * image.width + x) * 4;
    samples++;
    if (image.pixels[at] === 255 && image.pixels[at + 1] === 255 && image.pixels[at + 2] === 255) pureWhite++;
  }
  return { method: "normal frame; exact R=G=B=255 in the full lower-world rectangle", bounds,
    samples, pureWhite, fraction: samples ? pureWhite / samples : null, valid: samples > 0,
    invalidReason: samples ? null : "首页下半区没有可采样像素" };
}

export function worldAppearanceMetrics(image: DecodedPng, background: readonly [number, number, number]) {
  const { width, height, pixels } = image;
  const base = brightness(...background);
  let homeSamples = 0, homeCovered = 0, titleSamples = 0, titleBright = 0;
  for (let y = 440; y < height; y++) for (let x = 380; x < width; x++) {
    const at = (y * width + x) * 4;
    homeSamples++;
    if (Math.abs(brightness(pixels[at], pixels[at + 1], pixels[at + 2]) - base) > 10) homeCovered++;
  }
  for (let y = 90; y < Math.min(180, height); y++) for (let x = 400; x < Math.min(1000, width); x++) {
    const at = (y * width + x) * 4;
    titleSamples++;
    if (brightness(pixels[at], pixels[at + 1], pixels[at + 2]) > 60) titleBright++;
  }
  if (!homeSamples || !titleSamples) throw new Error("World appearance capture does not contain the required regions");
  return {
    method: "arithmetic encoded RGB mean; full compositor screenshot includes UI; strict >10 background delta / >60 title brightness",
    home: { samples: homeSamples, covered: homeCovered, fraction: homeCovered / homeSamples, bounds: [380, 440, width, height] },
    title: { samples: titleSamples, bright: titleBright, fraction: titleBright / titleSamples, bounds: [400, 90, Math.min(1000, width), Math.min(180, height)] },
  };
}
