// SPDX-License-Identifier: GPL-3.0-only
import type { Page } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodePng, encodePng, type DecodedPng } from "./glass-pixel-probe.mjs";

export function glassColumnProfile(image: DecodedPng, bounds: {left:number;top:number;right:number;bottom:number;width:number;height:number},
  content: {left:number;top:number;right:number;bottom:number}[]) {
  const center=Math.floor((bounds.left+bounds.right)/2);
  const column=(x:number)=>{
    const values=[];
    for(let y=Math.ceil(bounds.top);y<Math.ceil(bounds.bottom);y++){
      if(x<0||y<0||x>=image.width||y>=image.height||content.some(b=>x+.5>=b.left&&x+.5<b.right&&y+.5>=b.top&&y+.5<b.bottom))continue;
      const at=(y*image.width+x)*4;values.push((image.pixels[at]+image.pixels[at+1]+image.pixels[at+2])/3);
    }
    return {x,count:values.length,mean:values.length?values.reduce((a,b)=>a+b,0)/values.length:null};
  };
  const neighbors=[...Array.from({length:9},(_,i)=>column(center-16+i)),...Array.from({length:9},(_,i)=>column(center+8+i))];
  const valid=neighbors.filter(c=>c.mean!==null);
  assert(valid.length>0,"A column reference requires visible neighbor samples");
  const neighborMean=valid.reduce((sum,c)=>sum+c.mean!,0)/valid.length;
  const columns=Array.from({length:13},(_,i)=>column(center-6+i)).map(c=>({...c,delta:c.mean===null?null:Math.abs(c.mean-neighborMean)}));
  return {center,neighborMean,neighbors,columns,maxDelta:Math.max(...columns.filter(c=>c.delta!==null).map(c=>c.delta!))};
}

/** Signed edge color from the browser's actual inner contour band, without a visual pass/fail threshold. */
export function glassEdgeColorProfile(
  image: DecodedPng,
  crop: { x: number; y: number; width: number; height: number },
  bounds: { left: number; right: number },
  bandIndices: readonly number[],
  content: { left: number; top: number; right: number; bottom: number }[],
) {
  type Pixel = { x: number; y: number; redMinusBlue: number };
  const pixels: { left: Pixel[]; right: Pixel[] } = { left: [], right: [] };
  const seen = new Set<number>(), centerX = (bounds.left + bounds.right) / 2;
  let excludedContentPixels = 0;
  for (const index of bandIndices) {
    assert(Number.isInteger(index) && index >= 0 && index < crop.width * crop.height, "Edge-band index must stay inside the crop");
    assert(!seen.has(index), "Duplicate edge-band samples would bias the color mean");
    seen.add(index);
    const x = crop.x + index % crop.width, y = crop.y + Math.floor(index / crop.width);
    assert(Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < image.width && y < image.height,
      "Edge-band sample must stay inside the actual image");
    if (content.some(box => x + .5 >= box.left && x + .5 < box.right && y + .5 >= box.top && y + .5 < box.bottom)) {
      excludedContentPixels++; continue;
    }
    const at = (y * image.width + x) * 4;
    pixels[x + .5 < centerX ? "left" : "right"].push({ x, y, redMinusBlue: image.pixels[at] - image.pixels[at + 2] });
  }
  assert(pixels.left.length > 0 && pixels.right.length > 0, "Both edge sides must have visible contour-band samples");
  const side = (values: Pixel[]) => ({ count: values.length,
    meanRedMinusBlue: values.reduce((sum, pixel) => sum + pixel.redMinusBlue, 0) / values.length, pixels: values });
  const left = side(pixels.left), right = side(pixels.right);
  const differenceLeftMinusRight = left.meanRedMinusBlue - right.meanRedMinusBlue;
  return { centerX, left, right, excludedContentPixels, differenceLeftMinusRight, absoluteDifference: Math.abs(differenceLeftMinusRight) };
}

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
    const edgeBandIndices: number[] = [];
    for (let y = 0; y < crop.height; y++) for (let x = 0; x < crop.width; x++) {
      const globalX = crop.x + x + .5, globalY = crop.y + y + .5;
      const localX = globalX - bounds.left, localY = globalY - bounds.top, index = y * crop.width + x;
      if (!context.isPointInPath(path, localX, localY)) continue;
      masks.silhouette.push(index);
      const atInnerEdge = context.isPointInStroke(path, localX, localY);
      if (atInnerEdge) edgeBandIndices.push(index);
      if (content.some(box => globalX >= box.left && globalX < box.right && globalY >= box.top && globalY < box.bottom)) continue;
      if (Math.abs(localX - bounds.width / 2) <= 2) masks.center4WithoutContent.push(index);
      if (!atInnerEdge) masks.interior4WithoutContent.push(index);
    }
    const style = getComputedStyle(element), world = document.querySelector<HTMLElement>(".world-scene");
    const gl = world?.querySelector("canvas")?.getContext("webgl2"), debug = gl?.getExtension("WEBGL_debug_renderer_info");
    return { bounds: bounds.toJSON(), crop, path: pathText, content, masks, edgeBandIndices,
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
  const filterTargets = ".vx-window-chrome, .vx-window-chrome__bar, .vx-floating-nav, .vx-floating-nav__indicator-slot, .vx-floating-nav__indicator";
  const savedFilters = await page.locator(filterTargets).evaluateAll(elements => elements.map(element => {
    const style=(element as HTMLElement).style;
    const saved={value:style.getPropertyValue("backdrop-filter"),priority:style.getPropertyPriority("backdrop-filter"),
      webkitValue:style.getPropertyValue("-webkit-backdrop-filter"),webkitPriority:style.getPropertyPriority("-webkit-backdrop-filter"),actual:getComputedStyle(element).backdropFilter};
    style.setProperty("backdrop-filter","none","important");style.setProperty("-webkit-backdrop-filter","none","important");return saved;
  }));
  const chromeBounds=await page.locator(".vx-window-chrome").boundingBox();
  assert(chromeBounds);
  await page.waitForTimeout(80);
  const backgroundPath = join(directory, "without-navigation-refraction.png");
  let background:DecodedPng;
  try {background=decodePng(await page.screenshot({path:backgroundPath,scale:"css"}));}
  finally {await page.locator(filterTargets).evaluateAll((elements,saved)=>elements.forEach((element,index)=>{
    const style=(element as HTMLElement).style, previous=saved[index];
    for(const [name,value,priority] of [["backdrop-filter",previous.value,previous.priority],["-webkit-backdrop-filter",previous.webkitValue,previous.webkitPriority]]){
      if(value)style.setProperty(name,value,priority);else style.removeProperty(name);
    }
  }),savedFilters);}
  const after=await read();
  const columns=glassColumnProfile(actual,before.bounds,before.content);
  const referenceColumns=glassColumnProfile(background,before.bounds,before.content);
  const edgeColors = {
    bandWidthCssPx: 4,
    maskDefinition: "Pixel centers inside the actual live clip path and its centered 8px stroke (inner 4px band); split at the actual bounding-box center x, with center ties on the right; exclude actual text/icon boxes. Means use signed R-B from the normal screenshot; no color threshold is applied.",
    ...glassEdgeColorProfile(actual, before.crop, before.bounds, before.edgeBandIndices, before.content),
  };
  assert.equal(before.world.worldFrames, after.world.worldFrames, "Reference world frame must be unchanged");
  assert.deepEqual(before.bounds, after.bounds);
  assert.deepEqual(before.content, after.content, "Text and icons must remain in their actual positions");
  let outsideChanged = 0;
  for (let y = 0; y < actual.height; y++) for (let x = 0; x < actual.width; x++) {
    if (x >= chromeBounds.x - 1 && x <= chromeBounds.x + chromeBounds.width + 1 && y >= chromeBounds.y - 1 && y <= chromeBounds.y + chromeBounds.height + 1) continue;
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
  const { masks: omittedMasks, edgeBandIndices: omittedEdgeBand, ...geometry } = before; void omittedMasks; void omittedEdgeBand;
  const report = { geometry, after: { world: after.world, theme: after.theme }, outsideChanged,
    actualPath, backgroundPath, enlargedPath, enlargement: 6, measurements, columns, referenceColumns, edgeColors, savedFilters,
    method: "S4 revision6: same frozen frame; remove backdrop-filter from both navigation and capsule for the record-only reference comparison; preserve reflection/content. True4px contour erosion excludes actual text/icon boxes. The unchanged actual-image column gate uses full capsule height, center±6 vs offsets±8..16. Left/right inner-edge signed R-B means are record-only.",
    manual: { status: "not-assessed-by-automated-test", checks: ["no center stripe", "no one-sided colored wedge", "background dots remain visibly curved at the lens edge"] } };
  await writeFile(join(directory, "interior.json"), JSON.stringify(report, null, 2));
  assert.equal(outsideChanged, 0, "Background reference changed outside navigation");
  return report;
}
