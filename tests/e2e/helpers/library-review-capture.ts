// SPDX-License-Identifier: GPL-3.0-only
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { installLauncherFixture } from "../fixtures.ts";
import { installWorldUniformProbe, readWorldUniformProbe } from "./world-uniform-probe.ts";

/** Declared before measuring historical diffs; do not grow this set after a failure. */
export const LIBRARY_COMPARISON_REGIONS = [".vx-window-chrome", ".vx-page-header", ".vx-library-commandbar",
  ".vx-instance-sheet", ".vx-detail-header", ".vx-detail-context", ".vx-detail-workspace"] as const;
export const LIBRARY_COMPARISON_STATES = ["grid", "list", "overview", "content", "worlds", "logs", "settings"] as const;

function regionGeometry() {
  const selectors = [".vx-window-chrome", ".vx-page-header", ".vx-library-commandbar", ".vx-instance-sheet",
    ".vx-detail-header", ".vx-detail-context", ".vx-detail-workspace"];
  return selectors.flatMap(selector => [...document.querySelectorAll<HTMLElement>(selector)]
    .filter(element => element.checkVisibility({ opacityProperty: true, visibilityProperty: true })
      && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0)
    .map((element, index) => ({ name: `${selector}:${index}`, ...element.getBoundingClientRect().toJSON() })));
}

export async function prepareLibraryComparison(page: Page, baseURL: string, width: 1050 | 1440) {
  await page.setViewportSize({ width, height: width === 1050 ? 720 : 930 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "no-preference", forcedColors: "none", contrast: "no-preference" });
  await installLauncherFixture(page, { theme: "dark", effects: "full", instanceCount: 2 });
  await installWorldUniformProbe(page);
  await page.addInitScript(() => {
    const prototype = WebGL2RenderingContext.prototype;
    const location = prototype.getUniformLocation, scalar = prototype.uniform1f, vector = prototype.uniform2f;
    const names = new WeakMap<WebGLUniformLocation, string>();
    const owners = new WeakMap<WebGLUniformLocation, WebGLProgram>();
    const origins = new Map<WebGLProgram, { gl: WebGL2RenderingContext; location: WebGLUniformLocation; writes: number; at: number }>();
    prototype.getUniformLocation = function (program, name) {
      const result = location.call(this, program, name);
      if (result) { names.set(result, name); owners.set(result, program); }
      return result;
    };
    prototype.uniform1f = function (uniform, value) {
      return scalar.call(this, uniform, uniform && names.get(uniform) === "uT" ? 9.7 : value);
    };
    prototype.uniform2f = function (uniform, x, y) {
      const result = vector.call(this, uniform, x, y);
      const program = uniform && owners.get(uniform);
      if (program && uniform && names.get(uniform) === "uOrigin" && this.canvas instanceof HTMLCanvasElement
        && this.canvas.closest(".world-scene")) origins.set(program, { gl: this, location: uniform,
        writes: (origins.get(program)?.writes ?? 0) + 1, at: performance.now() });
      return result;
    };
    (window as unknown as { __readLibraryOrigins: () => unknown }).__readLibraryOrigins = () => {
      const entries = [...origins.entries()].map(([program, record], index) => ({ program, record, index, live: record.gl.isProgram(program) }));
      const contexts = [...new Set(entries.filter(entry => entry.live).map(entry => entry.record.gl))];
      const before = contexts.map(gl => gl.getError());
      const programs = entries.map(({ program, record, index, live }) => {
        const applied = live ? record.gl.getUniform(program, record.location) : null;
        return { program: index, live, writes: record.writes, at: record.at,
          applied: applied ? Array.from(applied as Float32Array) : null };
      });
      const errors = contexts.map((gl, index) => ({ context: index, before: before[index], after: gl.getError() }));
      return { programs, errors };
    };
  });
  await page.goto(baseURL);
  await page.waitForFunction(() => document.documentElement.dataset.worldIntro === "off");
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const runtime = await page.evaluate(() => {
    const gl = document.querySelector<HTMLCanvasElement>(".world-scene canvas")!.getContext("webgl2")!;
    const debug = gl.getExtension("WEBGL_debug_renderer_info")!;
    return { renderer: String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)), dpr: devicePixelRatio,
      html: { ...document.documentElement.dataset }, width: innerWidth, height: innerHeight,
      fonts: [...document.fonts].map(font => ({ family: font.family, weight: font.weight, status: font.status })) };
  });
  assert.match(runtime.renderer, /D3D11|Direct3D11/); assert.doesNotMatch(runtime.renderer, /swiftshader|software|llvmpipe/i);
  assert.equal(runtime.dpr, 1); assert.equal(runtime.html.theme, "dark"); assert.equal(runtime.html.effects, "full");
  const miSans = runtime.fonts.filter(font => font.family.replaceAll('"', "") === "MiSans");
  assert(miSans.length >= 2 && miSans.every(font => font.status === "loaded"), "Both actual MiSans weights must be loaded");
  await page.locator('.vx-floating-nav [data-page="library"]').click();
  await page.locator('[data-page-stage="library"]').waitFor();
  const observations = [], started = Date.now();
  let stable = false;
  while (Date.now() - started < 20000) {
    const sample = await page.evaluate(readWorldUniformProbe); observations.push(sample);
    const previous = observations.at(-2);
    if (previous && sample.atMs - previous.atMs >= 400 && (["uLat", "uCry", "uIsland"] as const).every(key =>
      Math.abs(sample[key] - previous[key]) < 1e-6)) { stable = true; break; }
    await page.waitForTimeout(450);
  }
  assert(stable, "Historical comparison crystallization must settle before capture");
  return { runtime, settling: observations };
}

export async function captureLibraryComparison(page: Page, directory: string) {
  await mkdir(directory, { recursive: true });
  const rows = [];
  for (const state of LIBRARY_COMPARISON_STATES) {
    if (state === "list") await page.getByRole("button", { name: "列表视图", exact: true }).click();
    else if (state === "overview") await page.locator('.vx-instance-card[data-instance-id="fixture-world"] .vx-instance-card__select').click();
    else if (state !== "grid") await page.locator(`#instance-tab-${state}`).click();
    await page.mouse.move(1, 100);
    await page.waitForFunction(() => {
      const stage = document.querySelector<HTMLElement>('[data-page-stage="library"]');
      const panel = document.querySelector<HTMLElement>(".vx-detail-workspace");
      return stage && getComputedStyle(stage).opacity === "1" && (!panel || getComputedStyle(panel).opacity === "1");
    });
    let before = await page.evaluate(regionGeometry), stable = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      await page.waitForTimeout(100); const next = await page.evaluate(regionGeometry);
      if (JSON.stringify(before) === JSON.stringify(next)) { before = next; stable = true; break; }
      before = next;
    }
    assert(stable, `${state}: presentation geometry must settle`);
    const screenshot = join(directory, `${state}.png`);
    const uniforms = await page.evaluate(readWorldUniformProbe);
    const originProbe = await page.evaluate(() => (window as unknown as { __readLibraryOrigins: () => {
      programs: { live: boolean; applied: number[] | null }[]; errors: { before: number; after: number }[];
    } }).__readLibraryOrigins());
    const origins = originProbe.programs;
    const liveOrigins = origins.filter(origin => origin.live);
    assert(liveOrigins.length > 0 && liveOrigins.every(origin => origin.applied?.length === 2 && origin.applied.every(Number.isFinite)),
      "Actual live world origin uniforms must be recorded without querying retired programs");
    assert(originProbe.errors.every(error => error.before === 0 && error.after === 0), "Record and reject GL errors before/after origin observation");
    await page.screenshot({ path: screenshot, scale: "css" });
    const after = await page.evaluate(regionGeometry);
    assert.deepEqual(after, before, `${state}: capture must not move the UI`);
    const headings = await page.locator('[data-page-stage="library"]').evaluate(element => [...element.querySelectorAll("h1,h2")]
      .map(node => ({ text: node.textContent, font: getComputedStyle(node).fontSize, bounds: node.getBoundingClientRect().toJSON() })));
    const row = { state, screenshot, regions: before, after, uniforms, origins, originErrors: originProbe.errors, headings };
    rows.push(row); await writeFile(join(directory, `${state}.json`), JSON.stringify(row, null, 2));
  }
  await writeFile(join(directory, "screenshots.json"), JSON.stringify(rows, null, 2));
  return rows;
}
