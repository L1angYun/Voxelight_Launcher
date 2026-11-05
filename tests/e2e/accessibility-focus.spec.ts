// SPDX-License-Identifier: GPL-3.0-only
import { chromium, expect, test, type Locator, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { installLauncherFixture } from "./fixtures";
import { decodePng } from "./helpers/glass-pixel-probe.mjs";

const nativeTest = test.extend({
  context: async ({ baseURL }, use) => {
    const browser = await chromium.launch({ channel: "chromium", args: ["--use-angle=d3d11"] });
    const context = await browser.newContext({ baseURL, deviceScaleFactor: 1 });
    try { await use(context); } finally { await context.close(); await browser.close(); }
  },
});

nativeTest.afterEach(async ({ page }, info) => {
  const runtime = await page.evaluate(() => {
    const world = document.querySelector<HTMLElement>(".world-scene");
    const gl = world?.querySelector("canvas")?.getContext("webgl2");
    const debug = gl?.getExtension("WEBGL_debug_renderer_info");
    return { renderer: debug ? String(gl!.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : null,
      dpr: devicePixelRatio, theme: document.documentElement.dataset.theme,
      effects: document.documentElement.dataset.effects, world: { ...world?.dataset } };
  });
  await writeFile(info.outputPath("browser-runtime.json"), JSON.stringify(runtime, null, 2));
  expect(runtime.renderer).toMatch(/Direct3D11|D3D11/);
  expect(runtime.renderer).not.toMatch(/swiftshader|llvmpipe|software|basic render/i);
  expect(runtime.dpr).toBe(1);
  expect(runtime.theme).toBe("light");
});

function contrast(first: readonly number[], second: readonly number[]) {
  const luminance = (rgb: readonly number[]) => rgb.map(value => {
    const s = value / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4;
  }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}

async function tabTo(page: Page, target: Locator) {
  const visited = [];
  for (let index = 0; index < 60; index++) {
    await page.keyboard.press("Tab");
    visited.push(await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      return { tag: active?.tagName, id: active?.id, className: active?.className,
        label: active?.getAttribute("aria-label"), text: active?.textContent?.trim().slice(0, 120) };
    }));
    if (await target.evaluate(element => element === document.activeElement)) return visited;
  }
  throw new Error(`Keyboard could not reach ${await target.getAttribute("class")}: ${JSON.stringify(visited)}`);
}

async function outline(owner: Locator) {
  return owner.evaluate(element => {
    const style = getComputedStyle(element), root = getComputedStyle(document.documentElement);
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!;
    context.fillStyle = style.outlineColor; context.fillRect(0, 0, 1, 1);
    return { outlineColor: style.outlineColor, outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth, outlineOffset: style.outlineOffset,
      rgb: [...context.getImageData(0, 0, 1, 1).data].slice(0, 3),
      indicator: root.getPropertyValue("--accent-indicator").trim(),
      focusVisible: document.activeElement?.matches(":focus-visible"), bounds: element.getBoundingClientRect().toJSON() };
  });
}

for (const mode of ["full", "lite", "reduced"] as const) {
  nativeTest(`R2-01 light keyboard outlines remain visible in ${mode}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    if (mode === "reduced") await page.emulateMedia({ reducedMotion: "reduce" });
    await installLauncherFixture(page, { theme: "light", effects: mode === "lite" ? "lite" : "full", instanceCount: 2 });
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-world-intro", "off");
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const homeTabs = await tabTo(page, page.locator(".vx-instance-picker__trigger"));
    const home = await outline(page.locator(".vx-launch-console__selector-wrap"));
    await page.screenshot({ path: info.outputPath(`focus-home-light-${mode}.png`), scale: "css" });
    await page.locator('.vx-floating-nav [data-page="library"]').click();
    await expect(page.locator('[data-page-stage="library"]')).toHaveCSS("opacity", "1");
    const libraryTabs = await tabTo(page, page.locator(".vx-library-page .vx-search input"));
    const library = await outline(page.locator(".vx-library-page .vx-search"));
    await page.screenshot({ path: info.outputPath(`focus-library-light-${mode}.png`), scale: "css" });
    const surfaces = [[243, 241, 235], [250, 249, 245], [234, 231, 224]];
    const samples = [home, library].map(value => ({ ...value, contrasts: surfaces.map(surface => contrast(value.rgb, surface)) }));
    await writeFile(info.outputPath("keyboard-focus.json"), JSON.stringify({ mode, homeTabs, libraryTabs, surfaces, samples }, null, 2));
    for (const sample of samples) {
      expect(sample.focusVisible).toBe(true);
      expect(sample.outlineStyle).toBe("solid");
      expect(sample.outlineWidth).toBe("2px");
      expect(sample.rgb).not.toEqual([180, 241, 122]);
      expect(sample.indicator).not.toBe("");
      for (const ratio of sample.contrasts) expect(ratio).toBeGreaterThanOrEqual(3);
    }
  });
}

nativeTest("R2-01 en light 1050 downloads completed columns have three-to-one contrast", async ({ page }, info) => {
  await page.setViewportSize({ width: 1050, height: 720 });
  await installLauncherFixture(page, { theme: "light", stress: true });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-world-intro", "off");
  await page.locator('.vx-floating-nav [data-page="downloads"]').click();
  await expect(page.locator('[data-page-stage="downloads"]')).toHaveCSS("opacity", "1");
  // The first half of the active task is genuinely complete. Inspect its solid
  // columns; terminal history rows may later have no progress visualization.
  const canvas = page.locator('[data-task-id="task-long"] canvas.vx-lattice-progress');
  await canvas.scrollIntoViewIfNeeded();
  await expect(canvas).toHaveAttribute("data-percent", "50");
  const readCores = () => canvas.evaluate(element => {
    const canvas = element as HTMLCanvasElement, context = canvas.getContext("2d")!;
    const bytes = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const token = getComputedStyle(document.documentElement);
    const color = token.getPropertyValue("--accent-indicator").trim() || token.getPropertyValue("--accent").trim();
    const probe = document.createElement("canvas"); probe.width = probe.height = 1;
    const p = probe.getContext("2d")!; p.fillStyle = color; p.fillRect(0, 0, 1, 1);
    const expected = [...p.getImageData(0, 0, 1, 1).data].slice(0, 3);
    const cores = [];
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width * .4; x++) {
      const offset = (y * canvas.width + x) * 4;
      if (bytes[offset + 3] === 255 && expected.every((value, index) => value === bytes[offset + index])) cores.push({ x, y });
    }
    return { cores, expected, bounds: canvas.getBoundingClientRect().toJSON(), width: canvas.width, height: canvas.height };
  });
  await expect.poll(async () => (await readCores()).cores.length).toBeGreaterThan(20);
  const painted = await readCores();
  const normal = decodePng(await page.screenshot({ path: info.outputPath("en-light-1050-downloads.png"), scale: "css" }));
  const previous = await canvas.evaluate(element => {
    const value = element.style.getPropertyValue("visibility"), priority = element.style.getPropertyPriority("visibility");
    element.style.setProperty("visibility", "hidden", "important"); return { value, priority };
  });
  let background;
  try {
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    background = decodePng(await page.screenshot({ path: info.outputPath("downloads-under-progress.png"), scale: "css" }));
  } finally {
    await canvas.evaluate((element, previous) => {
      if (previous.value) element.style.setProperty("visibility", previous.value, previous.priority);
      else element.style.removeProperty("visibility");
    }, previous);
  }
  const samples = painted.cores.flatMap(core => {
    const x = Math.floor(painted.bounds.x + (core.x + .5) * painted.bounds.width / painted.width);
    const y = Math.floor(painted.bounds.y + (core.y + .5) * painted.bounds.height / painted.height);
    if (x < 0 || y < 0 || x >= normal.width || y >= normal.height) return [];
    const offset = (y * normal.width + x) * 4;
    const foreground = [...normal.pixels.subarray(offset, offset + 3)];
    // Ignore antialiased edges: only opaque dot cores whose compositor color
    // matches the actual canvas solid palette are contrast samples.
    if (foreground.some((value, index) => Math.abs(value - painted.expected[index]) > 2)) return [];
    const under = [...background.pixels.subarray(offset, offset + 3)];
    return [{ x, y, foreground, background: under, ratio: contrast(foreground, under) }];
  });
  const minimum = Math.min(...samples.map(sample => sample.ratio));
  await writeFile(info.outputPath("completed-columns-contrast.json"), JSON.stringify({
    progressPercent: 50, inspectedFraction: .4, palette: painted.expected, sampledPixels: samples.length, minimum,
    worst: [...samples].sort((a, b) => a.ratio - b.ratio).slice(0, 10),
  }, null, 2));
  expect(samples.length).toBeGreaterThan(20);
  expect(minimum).toBeGreaterThanOrEqual(3);
});

nativeTest("R2-02 keyboard launch follows preparation running and idle with the cancel guard", async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await installLauncherFixture(page, { theme: "light", launchDelay: 0 });
  await page.addInitScript(() => {
    type Api = { invoke(name: string, args?: Record<string, unknown>): Promise<unknown> };
    type KeyRecord = { at: number; action: string | null; disabled: string | null };
    const host = window as unknown as { __TAURI_INTERNALS__?: Api;
      __focusFixture?: { finish(): void; keys: KeyRecord[] }; __appearanceFixtures?: { calls: { name: string }[] } };
    let finish = () => {}; const pending = new Promise<void>(resolve => { finish = resolve; });
    const keys: KeyRecord[] = [], wrapped = new WeakSet<Api>();
    function attach(api: Api) {
      if (wrapped.has(api)) return; wrapped.add(api);
      const invoke = api.invoke;
      api.invoke = async (name, args) => {
        const result = await invoke(name, args);
        if (name === "launch_game") await pending;
        return result;
      };
    }
    let api = host.__TAURI_INTERNALS__;
    Object.defineProperty(host, "__TAURI_INTERNALS__", { configurable: true, enumerable: true,
      get: () => api, set(value: Api) { api = value; attach(value); } });
    if (api) attach(api);
    host.__focusFixture = { finish, keys };
    document.addEventListener("keydown", event => {
      if (event.key === "Enter") keys.push({ at: performance.now(),
        action: (event.target as HTMLElement).getAttribute("data-launch-action"),
        disabled: (event.target as HTMLElement).getAttribute("aria-disabled") });
    }, true);
  });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-world-intro", "off");
  await tabTo(page, page.locator('[data-launch-action="idle"]'));
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  const guard = await page.evaluate(() => {
    const host = window as unknown as { __focusFixture: { keys: { at: number; action: string | null; disabled: string | null }[] };
      __appearanceFixtures: { calls: { name: string }[] } };
    return { keys: host.__focusFixture.keys, cancelled: host.__appearanceFixtures.calls.filter(call => call.name === "cancel_download_task").length };
  });
  await writeFile(info.outputPath("cancel-guard.json"), JSON.stringify(guard, null, 2));
  expect(guard.keys.map(key => key.action)).toEqual(["idle", "preparing"]);
  expect(guard.keys[1].at - guard.keys[0].at).toBeLessThan(250);
  expect(guard.keys[1].disabled).toBe("true");
  expect(guard.cancelled).toBe(0);
  await expect(page.locator('[data-launch-action="preparing"]')).toBeFocused();
  await page.screenshot({ path: info.outputPath("keyboard-preparing-light.png"), scale: "css" });
  await page.evaluate(() => (window as unknown as { __focusFixture: { finish(): void } }).__focusFixture.finish());
  await expect(page.locator('[data-launch-action="running"]')).toBeFocused();
  await page.screenshot({ path: info.outputPath("keyboard-running-light.png"), scale: "css" });
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-launch-action="idle"]')).toBeFocused();
  await page.screenshot({ path: info.outputPath("keyboard-ended-light.png"), scale: "css" });
});
