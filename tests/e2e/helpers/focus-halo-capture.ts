// SPDX-License-Identifier: GPL-3.0-only
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Page } from "@playwright/test";
import { decodePng } from "./glass-pixel-probe.mjs";

type Image = { width: number; height: number; pixels: Uint8Array };
type Bounds = { left: number; right: number; top: number; bottom: number };
type Region = { x: number; y: number; width: number; height: number };
type Paint = {
  id: number; at: number; region: Region; alphaBase64: string;
  halo: null | { bounds: Bounds & { width: number; height: number }; width: number; height: number;
    state?: string; attributes: CanvasRenderingContext2DSettings };
};
type ReferenceVisibility = { present: boolean; at: number; value?: string; priority?: string; computed?: string };
type Probe = { arm(region: Region): void; finish(id: number): Paint; beginReference(): ReferenceVisibility;
  endReference(): ReferenceVisibility; abort(): void };
type ProbeWindow = Window & { __focusHaloPaintProbe?: Probe };
const MARKER_WIDTH = 80, MARKER_HEIGHT = 2;

/** The marker is outside all measured edges and is included in the normal PNG. */
export function decodeHaloFrameStamp(image: Image) {
  assert(image.width >= MARKER_WIDTH && image.height >= MARKER_HEIGHT, "Missing halo frame marker geometry");
  const bits: number[] = [];
  for (let bit = 0; bit < 40; bit++) {
    const colors = [];
    for (let y = image.height - 2; y < image.height; y++) for (let x = bit * 2; x < bit * 2 + 2; x++) {
      const at = (y * image.width + x) * 4;
      colors.push([...image.pixels.subarray(at, at + 4)]);
    }
    const one = colors.every(c => c.join() === "255,0,255,255");
    const zero = colors.every(c => c.join() === "0,255,255,255");
    assert(one || zero, `Missing or inconsistent halo frame marker bit ${bit}`);
    bits.push(one ? 1 : 0);
  }
  const value = (offset: number, count: number) => bits.slice(offset, offset + count).reduce((s, b, i) => s + b * 2 ** i, 0);
  assert.equal(value(0, 8), 0xac, "Invalid halo marker header");
  const id = value(8, 24);
  assert(id > 0, "Halo frame ID must be nonzero");
  assert.equal(value(32, 8), 0xa7 ^ (id & 255) ^ ((id >> 8) & 255) ^ ((id >> 16) & 255), "Invalid halo marker checksum");
  return id;
}

/** Only the captured edge region is used; its coordinates remain CSS PNG pixels. */
export function haloPaintMask(width: number, height: number, paint: Pick<Paint, "region" | "alphaBase64">) {
  const r = paint.region;
  assert([width, height, r.x, r.y, r.width, r.height].every(Number.isInteger), "Invalid halo crop geometry");
  assert(width > 0 && height > 0 && r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0
    && r.x + r.width <= width && r.y + r.height <= height, "Halo crop outside screenshot");
  const alpha = Buffer.from(paint.alphaBase64, "base64");
  assert.equal(alpha.length, r.width * r.height, "Incomplete halo alpha crop");
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++)
    pixels[((r.y + y) * width + r.x + x) * 4 + 3] = alpha[y * r.width + x];
  return { width, height, pixels };
}

/**
 * Test-only observation of the existing synchronized 2D canvas. A clear starts
 * each synchronous halo draw; its microtask reads the completed paint and
 * updates the marker in the same rendering commit. No rAF, physics, opacity,
 * waiting rule is changed. Only the subsequent background reference hides the
 * halo, per R3-3 ruling 2; normal screenshots select an exact paint ID.
 */
export async function installFocusHaloPaintProbe(page: Page) {
  await page.addInitScript(() => {
    const host = window as ProbeWindow;
    if (host.__focusHaloPaintProbe) return;
    let serial = 0, queued = false, marker: HTMLCanvasElement | null = null;
    let reference: { canvas: HTMLCanvasElement | null; value: string; priority: string; computed: string } | null = null;
    let current: { region: Region; canvas: HTMLCanvasElement | null; width: number; height: number;
      records: Map<number, Paint>; normalCaptured: boolean; error: string | null } | null = null;
    function fail(message: string): never { throw new Error(message); }
    function ensureMarker() {
      if (!marker) {
        marker = document.createElement("canvas");
        marker.width = 80; marker.height = 2;
        marker.setAttribute("aria-hidden", "true"); marker.inert = true;
        marker.setAttribute("popover", "manual"); marker.dataset.focusFrameProbe = "";
        marker.style.cssText = "position:fixed!important;left:0!important;bottom:0!important;top:auto!important;right:auto!important;width:80px!important;height:2px!important;margin:0!important;padding:0!important;border:0!important;pointer-events:none!important;opacity:1!important;filter:none!important;backdrop-filter:none!important;mix-blend-mode:normal!important;transform:none!important;z-index:2147483647!important;image-rendering:pixelated!important";
        document.body.append(marker);
      }
      // Reopen only the diagnostic stamp above a subsequently opened dialog.
      // The actual halo canvas is never hidden or moved.
      if (marker.matches(":popover-open")) marker.hidePopover();
      marker.showPopover();
      const b = marker.getBoundingClientRect();
      if (b.x !== 0 || b.y !== innerHeight - 2 || b.width !== 80 || b.height !== 2) fail("Unexpected halo marker geometry");
      return marker.getContext("2d") ?? fail("Halo marker context unavailable");
    }
    function record() {
      if (!current || !marker || current.normalCaptured) return;
      const canvas = document.querySelector<HTMLCanvasElement>(".vx-cursor-halo");
      if (canvas !== current.canvas || innerWidth !== current.width || innerHeight !== current.height || devicePixelRatio !== 1)
        fail("Halo canvas or viewport changed during capture");
      const r = current.region;
      let alpha = new Uint8Array(r.width * r.height), halo: Paint["halo"] = null;
      if (canvas) {
        const b = canvas.getBoundingClientRect(), context = canvas.getContext("2d");
        if (b.x !== 0 || b.y !== 0 || b.width !== innerWidth || b.height !== innerHeight
          || canvas.width !== innerWidth || canvas.height !== innerHeight || !context)
          fail("Halo CSS/backing pixels must match the DPR1 screenshot");
        const attributes = context.getContextAttributes();
        if (!attributes.alpha || attributes.desynchronized) fail("Halo paint must use synchronized alpha compositing");
        const rgba = context.getImageData(r.x, r.y, r.width, r.height).data;
        alpha = Uint8Array.from({ length: r.width * r.height }, (_, i) => rgba[i * 4 + 3]);
        halo = { bounds: b.toJSON(), width: canvas.width, height: canvas.height, state: canvas.dataset.haloState, attributes };
      }
      const id = ++serial;
      if (id > 0xffffff) fail("Halo frame marker exhausted");
      let binary = "";
      for (let at = 0; at < alpha.length; at += 8192) binary += String.fromCharCode(...alpha.subarray(at, at + 8192));
      current.records.set(id, { id, at: performance.now(), region: { ...r }, alphaBase64: btoa(binary), halo });
      if (current.records.size > 64) current.records.delete(current.records.keys().next().value!);
      const g = marker.getContext("2d")!;
      const checksum = 0xa7 ^ (id & 255) ^ ((id >> 8) & 255) ^ ((id >> 16) & 255);
      for (let bit = 0; bit < 40; bit++) {
        const value = bit < 8 ? (0xac >> bit) & 1 : bit < 32 ? (id >> (bit - 8)) & 1 : (checksum >> (bit - 32)) & 1;
        g.fillStyle = value ? "#ff00ff" : "#00ffff"; g.fillRect(bit * 2, 0, 2, 2);
      }
    }
    const clearRect = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (...args: Parameters<typeof clearRect>) {
      clearRect.apply(this, args);
      if (current && this.canvas instanceof HTMLCanvasElement && this.canvas.classList.contains("vx-cursor-halo") && !queued) {
        queued = true;
        queueMicrotask(() => {
          queued = false;
          if (!current) return;
          try { record(); } catch (error) { current.error = String(error); }
        });
      }
    };
    function restoreReference(): ReferenceVisibility {
      if (!reference) return { present: false, at: performance.now() };
      const saved = reference;
      reference = null;
      if (!saved.canvas) return { present: false, at: performance.now() };
      if (saved.value) saved.canvas.style.setProperty("visibility", saved.value, saved.priority);
      else saved.canvas.style.removeProperty("visibility");
      const value = saved.canvas.style.getPropertyValue("visibility"), priority = saved.canvas.style.getPropertyPriority("visibility");
      const computed = getComputedStyle(saved.canvas).visibility;
      if (value !== saved.value || priority !== saved.priority || computed !== saved.computed)
        fail("Reference capture did not restore the original halo visibility");
      return { present: true, at: performance.now(), value, priority, computed };
    }
    host.__focusHaloPaintProbe = {
      arm(region) {
        if (current) fail("Halo capture already active");
        if (devicePixelRatio !== 1) fail("Focus halo capture requires DPR1");
        const focused = document.activeElement;
        ensureMarker();
        if (document.activeElement !== focused) fail("Diagnostic marker changed focus");
        current = { region, canvas: document.querySelector<HTMLCanvasElement>(".vx-cursor-halo"),
          width: innerWidth, height: innerHeight, records: new Map(), normalCaptured: false, error: null };
        try { record(); } catch (error) { current = null; throw error; }
      },
      finish(id) {
        if (!current) fail("Halo capture is not active");
        if (reference) fail("Reference halo visibility was not restored");
        const active = current;
        current = null;
        if (active.error) fail(active.error);
        if (document.querySelector(".vx-cursor-halo") !== active.canvas || innerWidth !== active.width || innerHeight !== active.height)
          fail("Halo identity or viewport changed during screenshot");
        if (active.canvas) {
          const b = active.canvas.getBoundingClientRect(), context = active.canvas.getContext("2d");
          const attributes = context?.getContextAttributes();
          if (active.canvas.width !== active.width || active.canvas.height !== active.height
            || b.x !== 0 || b.y !== 0 || b.width !== active.width || b.height !== active.height
            || !attributes?.alpha || attributes.desynchronized)
            fail("Halo backing, CSS geometry or synchronized alpha context changed during screenshot");
        }
        const paint = active.records.get(id);
        if (!paint) fail(`Screenshot halo frame ${id} is missing; available IDs: ${[...active.records.keys()].join(",")}; no nearest-frame fallback`);
        return paint;
      },
      beginReference() {
        if (!current || reference) fail("Invalid reference capture state");
        // Normal screenshot is complete. Pin its paint history while the real
        // animation keeps running; hidden-reference alpha is never sampled.
        current.normalCaptured = true;
        const canvas = current.canvas;
        if (document.querySelector(".vx-cursor-halo") !== canvas) fail("Reference canvas identity changed");
        reference = { canvas, value: canvas?.style.getPropertyValue("visibility") ?? "",
          priority: canvas?.style.getPropertyPriority("visibility") ?? "", computed: canvas ? getComputedStyle(canvas).visibility : "absent" };
        if (!canvas) return { present: false, at: performance.now() };
        canvas.style.setProperty("visibility", "hidden", "important");
        const computed = getComputedStyle(canvas).visibility;
        if (computed !== "hidden") fail("Reference halo must be hidden");
        return { present: true, at: performance.now(), value: reference.value, priority: reference.priority, computed };
      },
      endReference() { return restoreReference(); },
      abort() { try { restoreReference(); } finally { current = null; } },
    };
  });
}

export async function captureFocusFrame(page: Page, screenshot: string, bounds: Bounds, outlineOffset: string, outlineWidth: string) {
  const viewport = page.viewportSize();
  assert(viewport, "Focus screenshot needs a fixed viewport");
  // Expand the observation crop even for inset outlines. Sampling positions
  // themselves remain exclusively defined by focusEdgeSamples.
  const extent = Math.abs(parseFloat(outlineOffset) + parseFloat(outlineWidth)) + 2;
  const left = Math.max(0, Math.floor(bounds.left - extent)), top = Math.max(0, Math.floor(bounds.top - extent));
  const right = Math.min(viewport.width, Math.ceil(bounds.right + extent)), bottom = Math.min(viewport.height, Math.ceil(bounds.bottom + extent));
  const region = { x: left, y: top, width: right - left, height: bottom - top };
  assert(region.width > 0 && region.height > 0, "Empty focus capture region");
  // The stamp cannot supply even one pixel to an adjacent focus edge.
  assert(region.x >= MARKER_WIDTH || region.y + region.height <= viewport.height - MARKER_HEIGHT,
    "Diagnostic marker intersects the focus sampling region");
  const referenceScreenshot = screenshot.replace(/\.png$/, ".reference.png");
  assert.notEqual(referenceScreenshot, screenshot, "Focus screenshot must use a PNG extension");
  await mkdir(dirname(screenshot), { recursive: true });
  try {
    await page.evaluate(region => {
      const probe = (window as ProbeWindow).__focusHaloPaintProbe;
      if (!probe) throw new Error("Focus halo paint probe was not installed");
      probe.arm(region);
    }, region);
    // No decode, disk write, rAF or timeout between these two captures. The
    // reference changes only the halo's visibility, restoring it in finally.
    const normalBytes = await page.screenshot({ scale: "css" });
    let referenceBytes: Buffer, hidden: ReferenceVisibility, restored: ReferenceVisibility;
    try {
      hidden = await page.evaluate(() => (window as ProbeWindow).__focusHaloPaintProbe!.beginReference());
      referenceBytes = await page.screenshot({ scale: "css" });
    } finally {
      restored = await page.evaluate(() => (window as ProbeWindow).__focusHaloPaintProbe!.endReference());
    }
    // Preserve even an invalid pair for diagnosis before validating its stamp.
    await Promise.all([writeFile(screenshot, normalBytes), writeFile(referenceScreenshot, referenceBytes!)]);
    const image = decodePng(normalBytes), referenceImage = decodePng(referenceBytes!);
    assert.equal(image.width, viewport.width); assert.equal(image.height, viewport.height);
    assert.equal(referenceImage.width, image.width); assert.equal(referenceImage.height, image.height);
    const id = decodeHaloFrameStamp(image);
    const paint = await page.evaluate(id => (window as ProbeWindow).__focusHaloPaintProbe!.finish(id), id);
    assert.equal(paint.id, id); assert.deepEqual(paint.region, region);
    const referenceCapture = { screenshot: referenceScreenshot, hidden: hidden!, restored: restored!, normalFrameId: id };
    await writeFile(screenshot.replace(/\.png$/, ".halo-paint.json"), JSON.stringify({
      method: "exact normal PNG frame ID; immediate reference with only halo visibility hidden and restored; no added waiting or animation changes",
      screenshot, referenceCapture, viewport, marker: { width: MARKER_WIDTH, height: MARKER_HEIGHT, x: 0, y: viewport.height - MARKER_HEIGHT }, ...paint,
    }, null, 2));
    return { image, referenceImage, referenceCapture, haloPaint: haloPaintMask(image.width, image.height, paint),
      haloCapture: { id, at: paint.at, region, canvas: paint.halo, evidence: screenshot.replace(/\.png$/, ".halo-paint.json") } };
  } finally {
    await page.evaluate(() => (window as ProbeWindow).__focusHaloPaintProbe?.abort());
  }
}
