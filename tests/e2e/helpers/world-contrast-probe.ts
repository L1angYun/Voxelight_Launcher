// SPDX-License-Identifier: GPL-3.0-only
import type { Page } from "@playwright/test";
import { decodePng } from "./glass-pixel-probe.mjs";

export interface ContrastTarget {
  name: string;
  selector: string;
  minimum: number;
  optional?: boolean;
  nominalDuringIntro?: boolean;
}
export interface UnanalyzedContrastRegion {
  name: string;
  text: string;
  selector: string;
  minimum: number;
  foreground: [number, number, number, number];
  paintOpacity: number;
  paintVisible: boolean;
  nominalOnly: boolean;
  elementIndex: number;
  elementBounds: { x: number; y: number; width: number; height: number };
  bounds: { x: number; y: number; width: number; height: number }[];
}
export interface ContrastRegion extends UnanalyzedContrastRegion {
  contrast: number;
  worstPixel: { x: number; y: number; rgb: number[] };
  sampledPixels: number;
}
export type WorldContrastState = Record<string, string | number | undefined>;
export interface TextContrastMetadata {
  regions: UnanalyzedContrastRegion[];
  before: WorldContrastState;
  scrim: string;
  viewport: { width: number; height: number };
  epochMs: number;
}
export interface WorldContrastReport {
  before: WorldContrastState;
  after: WorldContrastState;
  scrim: string;
  regions: ContrastRegion[];
  frameEvidence?: Record<string, unknown>;
}

function luminance(rgb: readonly number[]) {
  const channels = rgb.map(value => {
    const s = value / 255;
    return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4;
  });
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
}

/** Standalone browser function: safe to pass directly to evaluate or serialize. */
export function collectTextContrastMetadata(targets: ContrastTarget[]): TextContrastMetadata {
  const scene = document.querySelector<HTMLElement>(".vx-global-scene")!;
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d")!;
  const regions = targets.flatMap(target => {
    const elements = [...document.querySelectorAll<HTMLElement>(target.selector)];
    if (!elements.length && !target.optional) throw new Error(`Missing contrast target: ${target.name}`);
    return elements.map((element, elementIndex) => {
      const style = getComputedStyle(element), box = element.getBoundingClientRect();
      context.clearRect(0, 0, 1, 1); context.fillStyle = style.color; context.fillRect(0, 0, 1, 1);
      const rgba = context.getImageData(0, 0, 1, 1).data;
      let paintOpacity = 1;
      for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement)
        paintOpacity *= Number(getComputedStyle(ancestor).opacity);
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT), bounds = [];
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!node.textContent?.trim()) continue;
        const range = document.createRange(); range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          const left = Math.max(0, rect.left, box.left), top = Math.max(0, rect.top, box.top);
          const right = Math.min(innerWidth, rect.right, box.right), bottom = Math.min(innerHeight, rect.bottom, box.bottom);
          if (right > left && bottom > top) bounds.push({ x: left, y: top, width: right - left, height: bottom - top });
        }
      }
      if (!bounds.length || !rgba[3]) throw new Error(`No visible glyph area or nominal color: ${target.name}`);
      return { name: target.name, text: element.textContent?.trim() ?? "", selector: target.selector, minimum: target.minimum,
        foreground: [rgba[0], rgba[1], rgba[2], rgba[3] / 255] as [number, number, number, number], paintOpacity,
        paintVisible: element.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
        nominalOnly: Boolean(target.nominalDuringIntro && document.documentElement.dataset.worldIntro === "on"), bounds,
        elementIndex, elementBounds: { x: box.x, y: box.y, width: box.width, height: box.height } };
    });
  });
  const now = performance.now(), epochMs = performance.timeOrigin + now;
  return {
    regions,
    before: { theme: document.documentElement.dataset.theme, intro: document.documentElement.dataset.worldIntro, phase: scene.dataset.worldPhase,
      front: scene.dataset.worldFront, frames: scene.dataset.worldFrames, tier: scene.dataset.worldTier,
      material: scene.dataset.worldMaterial, now, epochMs },
    scrim: getComputedStyle(document.querySelector(".vx-home")!, "::before").backgroundImage,
    viewport: { width: innerWidth, height: innerHeight }, epochMs,
  };
}

export function glyphHidingStyle(targets: ContrastTarget[]): string {
  const selectors = targets.flatMap(target => target.selector.split(",").flatMap(selector => [selector, `${selector} *`])).join(",");
  // Only glyph paint changes: box layout, local scrim, surfaces, backdrop filters,
  // canvas pixels and the real launcher state keep their ordinary behavior.
  return `${selectors} {
    -webkit-text-fill-color: transparent !important; text-shadow: none !important; text-decoration-color: transparent !important; }`;
}

export function validateContrastLayout(beforeMetadata: TextContrastMetadata, afterMetadata: TextContrastMetadata): void {
  if (beforeMetadata.viewport.width !== afterMetadata.viewport.width || beforeMetadata.viewport.height !== afterMetadata.viewport.height)
    throw new Error("Contrast viewport changed while glyph paint was hidden");
  if (beforeMetadata.regions.length !== afterMetadata.regions.length)
    throw new Error("Contrast target set changed while glyph paint was hidden");
  for (const [index, before] of beforeMetadata.regions.entries()) {
    const after = afterMetadata.regions[index];
    if (before.selector !== after.selector || before.elementIndex !== after.elementIndex || before.name !== after.name)
      throw new Error(`Contrast target changed: ${before.name}`);
    for (const key of ["x", "y", "width", "height"] as const)
      if (Math.abs(before.elementBounds[key] - after.elementBounds[key]) > .05)
        throw new Error(`Glyph hiding changed ${before.name} layout`);
    if (before.bounds.length !== after.bounds.length) throw new Error(`Glyph hiding changed ${before.name} glyph layout`);
    for (const [boundIndex, bound] of before.bounds.entries())
      for (const key of ["x", "y", "width", "height"] as const)
        if (Math.abs(bound[key] - after.bounds[boundIndex][key]) > .05)
          throw new Error(`Glyph hiding changed ${before.name} glyph layout`);
  }
}

/** Analyze real compositor pixels; no browser or CSS surface substitution. */
export function analyzeTextContrast(png: Buffer, measured: TextContrastMetadata, after: WorldContrastState): WorldContrastReport {
  const image = decodePng(png);
  if (image.width !== measured.viewport.width || image.height !== measured.viewport.height)
    throw new Error(`Contrast PNG dimensions ${image.width}x${image.height} do not match CSS viewport ${measured.viewport.width}x${measured.viewport.height}`);
  const regions = measured.regions.map(region => {
    let contrast = Infinity, sampledPixels = 0;
    let worstPixel = { x: 0, y: 0, rgb: [] as number[] };
    for (const box of region.bounds) for (let y = Math.floor(box.y); y < Math.ceil(box.y + box.height); y++)
      for (let x = Math.floor(box.x); x < Math.ceil(box.x + box.width); x++) {
        if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue;
        const at = (y * image.width + x) * 4;
        if (image.pixels[at + 3] !== 255) throw new Error("Contrast capture must be an opaque compositor screenshot");
        const background = [...image.pixels.subarray(at, at + 3)];
        const alpha = region.foreground[3];
        const foreground = background.map((value, channel) => region.foreground[channel] * alpha + value * (1 - alpha));
        const a = luminance(background), b = luminance(foreground), ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
        sampledPixels++;
        if (ratio < contrast) { contrast = ratio; worstPixel = { x, y, rgb: background }; }
      }
    if (!sampledPixels) throw new Error(`Empty compositor sample: ${region.name}`);
    return { ...region, contrast, worstPixel, sampledPixels };
  });
  return { before: measured.before, after, scrim: measured.scrim, regions };
}

/** Sample compositor pixels beneath glyph bounds; never substitute a CSS surface color. */
export async function captureTextContrast(page: Page, targets: ContrastTarget[], path: string): Promise<WorldContrastReport> {
  const measured = await page.evaluate(collectTextContrastMetadata, targets);
  const style = await page.addStyleTag({ content: glyphHidingStyle(targets) });
  try {
    const png = await page.screenshot({ path, scale: "css" });
    const afterMetadata = await page.evaluate(collectTextContrastMetadata, targets);
    validateContrastLayout(measured, afterMetadata);
    return analyzeTextContrast(png, measured, afterMetadata.before);
  } finally { await style.evaluate(element => element.parentNode?.removeChild(element)); }
}
