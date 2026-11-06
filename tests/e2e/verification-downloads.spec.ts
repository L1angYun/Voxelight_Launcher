// SPDX-License-Identifier: GPL-3.0-only
import { chromium, expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { installLauncherFixture } from "./fixtures";

const nativeTest = test.extend({
  context: async ({ baseURL }, use) => {
    const browser = await chromium.launch({ channel: "chromium", args: ["--use-angle=d3d11"] });
    const context = await browser.newContext({ baseURL, deviceScaleFactor: 1 });
    try { await use(context); } finally { await context.close(); await browser.close(); }
  },
});

nativeTest.afterEach(async ({ page }, info) => {
  const runtime = await page.evaluate(() => {
    const gl = document.querySelector<HTMLCanvasElement>(".world-scene canvas")!.getContext("webgl2")!;
    const debug = gl.getExtension("WEBGL_debug_renderer_info")!;
    return { renderer: String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)), dpr: devicePixelRatio,
      viewport: { width: innerWidth, height: innerHeight }, theme: document.documentElement.dataset.theme };
  });
  await writeFile(info.outputPath("runtime.json"), JSON.stringify(runtime, null, 2));
  expect(runtime.renderer).toMatch(/D3D11|Direct3D11/);
  expect(runtime.renderer).not.toMatch(/swiftshader|llvmpipe|software|basic render/i);
  expect(runtime.dpr).toBe(1);
});

async function prepare(page: Page, language: "zh-CN" | "en-US") {
  await installLauncherFixture(page, { theme: "dark", stress: true });
  // Keep all 200 task records intact; only select the requested UI language.
  await page.addInitScript(language => {
    type Api = { invoke(name: string, args?: Record<string, unknown>): Promise<unknown> };
    const host = window as unknown as { __TAURI_INTERNALS__?: Api };
    const wrapped = new WeakSet<Api>();
    const attach = (api: Api) => {
      if (wrapped.has(api)) return; wrapped.add(api);
      const original = api.invoke;
      api.invoke = async (name, args) => {
        const data = await original(name, args);
        return name === "bootstrap" ? { ...data as object, config: { ...(data as { config: object }).config, language } } : data;
      };
    };
    let api = host.__TAURI_INTERNALS__;
    Object.defineProperty(host, "__TAURI_INTERNALS__", { configurable: true, get: () => api,
      set(value: Api) { api = value; attach(value); } });
    if (api) attach(api);
  }, language);
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-world-intro", "off");
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.locator('.vx-floating-nav [data-page="downloads"]').click();
  await expect(page.locator('[data-page-stage="downloads"]')).toHaveCSS("opacity", "1");
}

function historyRowGeometry(element: Element) {
  const rectangle = (target: Element) => {
    const rect = target.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
      top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left };
  };
  const columns = [".vx-task-row__header", ".vx-task-row__status", ".vx-task-row__summary", "time", ".vx-task-row__actions"];
  const style = getComputedStyle(element), parent = getComputedStyle(element.parentElement!);
  return { id: element.getAttribute("data-task-id"), status: element.getAttribute("data-status"),
    layout: { columns: style.gridTemplateColumns, containment: style.contain,
      contentVisibility: style.contentVisibility, parentColumns: parent.gridTemplateColumns },
    row: rectangle(element), columns: columns.map(selector => {
      const target = element.querySelector<HTMLElement>(`:scope > ${selector}`)!;
      return { selector, text: target.textContent, ...rectangle(target) };
    }) };
}

for (const language of ["zh-CN", "en-US"] as const) for (const width of [1050, 1440, 1920]) {
  nativeTest(`R2-18 ${language} ${width}: history rows share every column across failed and completed tasks`, async ({ page }, info) => {
    nativeTest.setTimeout(90000);
    await page.setViewportSize({ width, height: width === 1050 ? 720 : width === 1440 ? 930 : 1080 });
    await prepare(page, language);
    const rows = page.locator(".vx-task-section--history .vx-task-row--history");
    await expect(rows).toHaveCount(30);
    await expect(rows.filter({ has: page.locator('[data-status="failed"]') })).toHaveCount(1);
    const geometry: ReturnType<typeof historyRowGeometry>[] = [];
    for (let index = 0; index < 30; index++) {
      const row = rows.nth(index);
      await row.scrollIntoViewIfNeeded();
      geometry.push(await row.evaluate(historyRowGeometry));
    }
    await page.locator(".vx-app-main").evaluate(element => element.scrollTo({ top: 0, behavior: "instant" }));
    await page.screenshot({ path: info.outputPath("downloads-200-columns.png"), scale: "css" });
    const deltas = Array.from({ length: 5 }, (_, column) => {
      const xs = geometry.map(row => row.columns[column].x);
      return { column, selector: geometry[0].columns[column].selector, minimum: Math.min(...xs), maximum: Math.max(...xs), delta: Math.max(...xs) - Math.min(...xs) };
    });
    await writeFile(info.outputPath("history-columns.json"), JSON.stringify({ language, width, geometry, deltas }, null, 2));
    expect(new Set(geometry.map(row => row.status))).toEqual(new Set(["failed", "completed"]));
    for (const row of geometry) {
      expect(row.row.height, `${row.id} retains compact height`).toBe(56);
      for (const [index, column] of row.columns.entries()) {
        const label = `${row.id} ${column.selector}`;
        expect(column.width, `${label} reserves its column even without an action`).toBeGreaterThan(0);
        expect(column.left, `${label} inside row left edge`).toBeGreaterThanOrEqual(row.row.left - .5);
        expect(column.right, `${label} inside row right edge`).toBeLessThanOrEqual(row.row.right + .5);
        expect(column.top, `${label} inside row top edge`).toBeGreaterThanOrEqual(row.row.top - .5);
        expect(column.bottom, `${label} inside row bottom edge`).toBeLessThanOrEqual(row.row.bottom + .5);
        expect(Math.abs((column.top + column.bottom) / 2 - (row.row.top + row.row.bottom) / 2), `${label} centered in the same horizontal row`).toBeLessThanOrEqual(1);
        if (index) expect(column.left, `${label} follows the previous column without overlap`).toBeGreaterThanOrEqual(row.columns[index - 1].right - .5);
      }
    }
    for (const column of deltas)
      expect(column.delta, `${column.selector} must align between all 30 rows`).toBeLessThanOrEqual(.5);
  });
}
