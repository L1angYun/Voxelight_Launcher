// SPDX-License-Identifier: GPL-3.0-only
import { expect, test, type Page } from "@playwright/test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { installLauncherFixture } from "./fixtures";
import { decodePng } from "./helpers/glass-pixel-probe.mjs";

test.use({
  viewport: { width: 1440, height: 930 }, deviceScaleFactor: 1,
  channel: "chromium", launchOptions: { args: ["--use-angle=d3d11"] },
});

type Theme = "dark" | "light";
type Effects = "full" | "lite";
type PixelImage = { width: number; height: number; pixels: Uint8Array };

function luminance(rgb: number[]) {
  return rgb.map(value => {
    const channel = value / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  }).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
}

function contrast(foreground: number[], alpha: number, background: number[]) {
  const visible = foreground.map((channel, index) => channel * alpha + background[index] * (1 - alpha));
  const a = luminance(visible), b = luminance(background);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}

function pixel(image: PixelImage, x: number, y: number) {
  assert(x >= 0 && y >= 0 && x < image.width && y < image.height, `sample (${x}, ${y}) stays in the capture`);
  const offset = (y * image.width + x) * 4;
  assert.equal(image.pixels[offset + 3], 255, "the compositor capture is opaque");
  return [...image.pixels.subarray(offset, offset + 3)];
}

async function runtime(page: Page) {
  return page.evaluate(() => {
    const world = document.querySelector<HTMLElement>(".world-scene")!;
    const gl = world.querySelector("canvas")!.getContext("webgl2")!;
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    return {
      theme: document.documentElement.dataset.theme, effects: document.documentElement.dataset.effects,
      renderer: debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : null,
      dpr: devicePixelRatio, atMs: performance.now(), world: { ...world.dataset },
    };
  });
}

function checkRuntime(value: Awaited<ReturnType<typeof runtime>>, theme: Theme, effects: Effects) {
  expect(value.theme).toBe(theme);
  expect(value.effects).toBe(effects);
  expect(value.dpr).toBe(1);
  expect(value.renderer).toMatch(/D3D11|Direct3D11/);
  expect(value.renderer).not.toMatch(/swiftshader|llvmpipe|software|basic render/i);
  expect(value.world.worldMaterial, "both solid and Lite render the actual solid terrain").toBe("solid");
}

async function prepare(page: Page, theme: Theme, effects: Effects) {
  await installLauncherFixture(page, {
    theme, effects, worldScene: "horizon", worldMaterial: effects === "full" ? "solid" : "lattice", instanceCount: 2,
  });
  await page.addInitScript(() => {
    type Bridge = { invoke: (name: string, args: unknown) => Promise<Record<string, unknown>> };
    const host = window as unknown as { __TAURI_INTERNALS__?: Bridge };
    const wrapped = new WeakSet<Bridge>();
    const attach = (api: Bridge) => {
      if (wrapped.has(api)) return;
      wrapped.add(api);
      const original = api.invoke;
      api.invoke = async (name, args) => {
        const result = await original(name, args);
        return name === "bootstrap" ? { ...result, config: { ...(result.config as object), language: "en-US" } } : result;
      };
    };
    let api = host.__TAURI_INTERNALS__;
    Object.defineProperty(host, "__TAURI_INTERNALS__", {
      configurable: true, enumerable: true, get: () => api,
      set(value: Bridge) { api = value; attach(value); },
    });
    if (api) attach(api);
  });
  await page.route("https://api.modrinth.com/v2/search?**", route => route.fulfill({
    contentType: "application/json", body: JSON.stringify({ hits: [] }),
  }));
  await page.goto("/");
  await page.waitForFunction(() => document.documentElement.dataset.worldIntro === "off"
    && Number(document.querySelector<HTMLElement>(".world-scene")?.dataset.worldFrames) > 0);
  await page.evaluate(() => document.fonts.ready);
  await page.locator('.vx-floating-nav [data-page="library"]').click();
  await page.waitForFunction(() => {
    const stage = document.querySelector('[data-page-stage="library"]');
    return stage && Number(getComputedStyle(stage).opacity) === 1;
  });
  await page.mouse.move(1436, 926);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

function navigationLabels() {
  const canvas = document.createElement("canvas"), context = canvas.getContext("2d")!;
  canvas.width = canvas.height = 1;
  return [...document.querySelectorAll<HTMLElement>(".vx-floating-nav__label")].map((element, index) => {
    const color = getComputedStyle(element).color;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    const rgba = [...context.getImageData(0, 0, 1, 1).data];
    let opacity = 1;
    for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) opacity *= Number(getComputedStyle(parent).opacity);
    const range = document.createRange();
    range.selectNodeContents(element);
    const boxes = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0).map(rect => ({
      left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
    }));
    return { index, text: element.textContent, color, rgba, opacity, boxes,
      active: element.closest(".vx-floating-nav__item")!.classList.contains("is-active") };
  });
}

for (const theme of ["dark", "light"] as const) for (const effects of ["full", "lite"] as const) {
  test(`R2-28 ${theme} ${effects === "full" ? "solid" : "Lite"}: every navigation label clears 4.5 against its adjacent compositor pixels`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await prepare(page, theme, effects);
    const frames = [];
    for (let index = 0; index < 3; index++) {
      if (index) await page.waitForTimeout(250);
      const before = await runtime(page), labels = await page.evaluate(navigationLabels);
      checkRuntime(before, theme, effects);
      expect(labels.length).toBeGreaterThan(0);
      expect(labels.every(label => label.boxes.length > 0 && label.opacity >= .999)).toBe(true);
      const path = info.outputPath(`navigation-${index}-normal.png`);
      const image = decodePng(await page.screenshot({ path, scale: "css" })) as PixelImage;
      const after = await runtime(page);
      checkRuntime(after, theme, effects);
      expect(await page.evaluate(navigationLabels), "foreground and geometry remain unchanged across the screenshot").toEqual(labels);
      const measured = labels.map(label => {
        let minimumContrast = Infinity;
        let worstPixel: { x: number; y: number; rgb: number[]; contrast: number } | null = null;
        const samples = [];
        for (const box of label.boxes) {
          const rows = [Math.floor(box.top) - 2, Math.floor(box.top) - 1, Math.ceil(box.bottom), Math.ceil(box.bottom) + 1];
          for (const y of rows) for (let x = Math.floor(box.left); x < Math.ceil(box.right); x++) {
            const rgb = pixel(image, x, y), value = contrast(label.rgba.slice(0, 3), label.rgba[3] / 255 * label.opacity, rgb);
            const sample = { x, y, rgb, contrast: value };
            samples.push(sample);
            if (value < minimumContrast) { minimumContrast = value; worstPixel = sample; }
          }
        }
        return { ...label, samples, minimumContrast, worstPixel };
      });
      frames.push({ index, path, before, after, labels: measured });
    }
    const minimumContrast = Math.min(...frames.flatMap(frame => frame.labels.map(label => label.minimumContrast)));
    const evidence = {
      method: "Normal compositor PNG; all x pixels across each DOM text Range on the two integer rows immediately above and below it; nominal foreground composited with its actual alpha. No background or glyph paint is changed.",
      minimumContrast, frames, errors,
    };
    await writeFile(info.outputPath("navigation-contrast.json"), JSON.stringify(evidence, null, 2));
    for (const frame of frames) for (const label of frame.labels) {
      expect.soft(label.minimumContrast, `${theme}/${effects} frame ${frame.index}, ${label.text}: ${JSON.stringify(label.worstPixel)}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(errors, "the actual launcher rendered without runtime errors").toEqual([]);
  });
}
