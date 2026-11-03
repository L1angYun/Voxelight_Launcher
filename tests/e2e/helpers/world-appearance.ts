// SPDX-License-Identifier: GPL-3.0-only
import type { DecodedPng } from "./glass-pixel-probe.mjs";

/** Encoded-channel arithmetic brightness, matching the historical island metric. */
function brightness(r: number, g: number, b: number) { return (r + g + b) / 3; }

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
