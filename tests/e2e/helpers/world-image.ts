// SPDX-License-Identifier: GPL-3.0-only
import type { Page } from "@playwright/test";
import { decodePng, type DecodedPng } from "./glass-pixel-probe.mjs";

/** Hold foreground visibility constant across a set of real compositor captures. */
export async function withWorldView<T>(page: Page, run: (capture: (path?: string) => Promise<DecodedPng>) => Promise<T>): Promise<T> {
  const style = await page.addStyleTag({ content: `
    .vx-window-chrome, .vx-window-chrome *, .vx-app-main, .vx-app-main *, .vx-skip-link,
    .vx-glass-canvas, .vx-cursor-halo { visibility: hidden !important; }
    .world-scene { background-image: none !important; }
  ` });
  try {
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    return await run(async path => decodePng(await page.screenshot({ path, scale: "css" })));
  } finally {
    await style.evaluate(element => { element.parentNode?.removeChild(element); });
  }
}

/** Observe the real composited world, without foreground or fallback-pattern pixels. */
export async function captureWorld(page: Page, path?: string): Promise<DecodedPng> {
  return withWorldView(page, capture => capture(path));
}

export function changedPixels(before: DecodedPng, after: DecodedPng, threshold = 2): number {
  if (before.width !== after.width || before.height !== after.height) throw new Error("World screenshot dimensions changed");
  let changed = 0;
  for (let at = 0; at < before.pixels.length; at += 4) {
    if (Math.max(...[0, 1, 2].map(channel => Math.abs(before.pixels[at + channel] - after.pixels[at + channel]))) > threshold) changed++;
  }
  return changed;
}

export function worldStructure(image: DecodedPng): { range: number; edges: number } {
  let darkest = 255, brightest = 0, edges = 0;
  for (let row = 1; row < image.height; row++) for (let column = 1; column < image.width; column++) {
    const at = (row * image.width + column) * 4;
    const previous = at - 4;
    const above = at - image.width * 4;
    for (let channel = 0; channel < 3; channel++) {
      darkest = Math.min(darkest, image.pixels[at + channel]);
      brightest = Math.max(brightest, image.pixels[at + channel]);
    }
    if ([0, 1, 2].some(channel => Math.abs(image.pixels[at + channel] - image.pixels[previous + channel]) > 3 ||
      Math.abs(image.pixels[at + channel] - image.pixels[above + channel]) > 3)) edges++;
  }
  return { range: brightest - darkest, edges };
}
