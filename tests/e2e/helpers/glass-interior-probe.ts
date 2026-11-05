// SPDX-License-Identifier: GPL-3.0-only
import type { Page } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodePng, encodePng, type DecodedPng } from "./glass-pixel-probe.mjs";

/** Test-only freeze: keep background, text, and glyph positions identical for both captures. */
export async function installGlassFrameFreeze(page: Page) {
  await page.addInitScript(() => {
    const host = window as Window & { __glassFrameFreeze?: boolean };
    const schedule = requestAnimationFrame.bind(window);
    host.__glassFrameFreeze = false;
    window.requestAnimationFrame = callback => schedule(time => {
      if (!host.__glassFrameFreeze) callback(time);
    });
  });
}

function enlarge(image: DecodedPng, box: { x: number; y: number; width: number; height: number }, scale: number): DecodedPng {
  const width = box.width * scale, height = box.height * scale, pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const source = ((box.y + Math.floor(y / scale)) * image.width + box.x + Math.floor(x / scale)) * 4;
    image.pixels.copy(pixels, (y * width + x) * 4, source, source + 4);
  }
  return { width, height, pixels };
}

export async function captureGlassInterior(page: Page, directory: string) {
  await mkdir(directory, { recursive: true });
  await page.evaluate(() => { (window as Window & { __glassFrameFreeze?: boolean }).__glassFrameFreeze = true; });
  await page.waitForTimeout(120);
  const selector = ".vx-floating-nav__indicator";
  const read = () => page.locator(selector).evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const pathText = (element as HTMLElement).style.clipPath.match(/^path\(["'](.*)["']\)$/)?.[1];
    if (!pathText) throw new Error("The actual live lens clip path is required");
    const context = document.createElement("canvas").getContext("2d")!;
    const path = new Path2D(pathText);
    // A centered 8px stroke excludes points within 4px of the actual curved boundary.
    context.lineWidth = 8; context.lineJoin = "round"; context.lineCap = "round";
    const content: { kind: "text" | "icon"; left: number; top: number; right: number; bottom: number }[] = [];
    for (const button of document.querySelectorAll(".vx-floating-nav__item")) {
      const rect = button.getBoundingClientRect();
      if (rect.right < bounds.left || rect.left > bounds.right) continue;
      const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        if (!walker.currentNode.textContent?.trim()) continue;
        const range = document.createRange(); range.selectNodeContents(walker.currentNode);
        for (const box of range.getClientRects()) content.push({ kind: "text", left: box.left, top: box.top, right: box.right, bottom: box.bottom });
      }
      for (const icon of button.querySelectorAll("svg")) {
        const box = icon.getBoundingClientRect(); content.push({ kind: "icon", left: box.left, top: box.top, right: box.right, bottom: box.bottom });
      }
    }
    const crop = { x: Math.floor(bounds.left), y: Math.floor(bounds.top), width: Math.ceil(bounds.right) - Math.floor(bounds.left), height: Math.ceil(bounds.bottom) - Math.floor(bounds.top) };
    const masks = { silhouette: [] as number[], interior4WithoutContent: [] as number[], center4WithoutContent: [] as number[] };
    for (let y = 0; y < crop.height; y++) for (let x = 0; x < crop.width; x++) {
      const globalX = crop.x + x + .5, globalY = crop.y + y + .5;
      const localX = globalX - bounds.left, localY = globalY - bounds.top, index = y * crop.width + x;
      if (!context.isPointInPath(path, localX, localY)) continue;
      masks.silhouette.push(index);
      if (content.some(box => globalX >= box.left && globalX < box.right && globalY >= box.top && globalY < box.bottom)) continue;
      if (Math.abs(localX - bounds.width / 2) <= 2) masks.center4WithoutContent.push(index);
      if (!context.isPointInStroke(path, localX, localY)) masks.interior4WithoutContent.push(index);
    }
    const style = getComputedStyle(element), world = document.querySelector<HTMLElement>(".world-scene");
    const gl = world?.querySelector("canvas")?.getContext("webgl2"), debug = gl?.getExtension("WEBGL_debug_renderer_info");
    return { bounds: bounds.toJSON(), crop, path: pathText, content, masks,
      filter: style.backdropFilter, dispersion: Number(style.getPropertyValue("--vx-lens-dispersion")),
      refraction: Number(style.getPropertyValue("--vx-lens-refraction")),
      scales: [...element.querySelectorAll("feDisplacementMap")].map(node => Number(node.getAttribute("scale"))),
      world: { ...world?.dataset }, theme: document.documentElement.dataset.theme, dpr: devicePixelRatio,
      renderer: debug ? String(gl!.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : null };
  });
  const before = await read();
  assert.match(before.filter, /url\([^)]*vx-liquid-refraction/);
  assert.match(before.renderer ?? "", /Direct3D11|D3D11/);
  assert.doesNotMatch(before.renderer ?? "", /swiftshader|llvmpipe|software/i);
  assert.equal(before.dpr, 1);
  assert(before.masks.interior4WithoutContent.length > 0, "The approved interior mask must contain actual pixels");
  const actualPath = join(directory, "actual.png");
  const actual = decodePng(await page.screenshot({ path: actualPath, scale: "css" }));
  const previousVisibility = await page.locator(selector).evaluate(element => {
    const style = (element as HTMLElement).style, previous = { value: style.getPropertyValue("visibility"), priority: style.getPropertyPriority("visibility") };
    style.setProperty("visibility", "hidden", "important"); return previous;
  });
  await page.waitForTimeout(80);
  const backgroundPath = join(directory, "without-indicator.png");
  const background = decodePng(await page.screenshot({ path: backgroundPath, scale: "css" }));
  const after = await read();
  await page.locator(selector).evaluate((element, previous) => {
    const style = (element as HTMLElement).style;
    if (previous.value) style.setProperty("visibility", previous.value, previous.priority); else style.removeProperty("visibility");
  }, previousVisibility);
  assert.equal(before.world.worldFrames, after.world.worldFrames, "Reference world frame must be unchanged");
  assert.deepEqual(before.bounds, after.bounds);
  assert.deepEqual(before.content, after.content, "Text and icons must remain in their actual positions");
  let outsideChanged = 0;
  for (let y = 0; y < actual.height; y++) for (let x = 0; x < actual.width; x++) {
    if (x >= before.crop.x - 1 && x <= before.crop.x + before.crop.width + 1 && y >= before.crop.y - 1 && y <= before.crop.y + before.crop.height + 1) continue;
    const at = (y * actual.width + x) * 4;
    if ([0, 1, 2].some(channel => actual.pixels[at + channel] !== background.pixels[at + channel])) outsideChanged++;
  }
  const measurements = Object.fromEntries(Object.entries(before.masks).map(([name, indices]) => {
    let changed = 0, maxDelta = 0;
    for (const index of indices) {
      const x = before.crop.x + index % before.crop.width, y = before.crop.y + Math.floor(index / before.crop.width), at = (y * actual.width + x) * 4;
      const delta = Math.max(...[0, 1, 2].map(channel => Math.abs(actual.pixels[at + channel] - background.pixels[at + channel])));
      if (delta > 25) changed++; maxDelta = Math.max(maxDelta, delta);
    }
    return [name, { pixels: indices.length, deltaOver25: changed, fraction: changed / indices.length, maxDelta }];
  }));
  const enlargedPath = join(directory, "actual-6x.png");
  await writeFile(enlargedPath, encodePng(enlarge(actual, before.crop, 6)));
  const { masks: omittedMasks, ...geometry } = before; void omittedMasks;
  const report = { geometry, after: { world: after.world, theme: after.theme }, outsideChanged,
    actualPath, backgroundPath, enlargedPath, enlargement: 6, measurements,
    method: "Actual live clip path; true 4px contour erosion through an 8px centered stroke; exclude actual text/icon bounding boxes; max RGB-channel delta >25. Whole silhouette recorded only.",
    manual: { status: "not-assessed-by-automated-test", checks: ["no center stripe", "no one-sided colored wedge"] } };
  await writeFile(join(directory, "interior.json"), JSON.stringify(report, null, 2));
  assert.equal(outsideChanged, 0, "Background reference changed outside the indicator");
  return report;
}
