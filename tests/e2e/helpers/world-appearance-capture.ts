// SPDX-License-Identifier: GPL-3.0-only
import type { Page } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodePng } from "./glass-pixel-probe.mjs";
import { farMetrics, islandMetrics, lowerWorldWhiteMetrics, outsideIslandMetrics, worldAppearanceMetrics } from "./world-appearance.ts";

export const median = (values: number[]) => {
  if (!values.length || values.some(value => !Number.isFinite(value))) throw new Error("A median requires finite samples");
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const characterSelector = ".vx-home__character .vx-character-canvas__mount canvas";
const settlingTimeoutMs = 20_000;

export interface WorldFrameStamp { atMs: number; worldFrames: number; }

/** Accepted world submissions per second; this is not compositor/display FPS. */
export function worldFrameRate(first: WorldFrameStamp, last: WorldFrameStamp): number | null {
  const elapsed = last.atMs - first.atMs, frames = last.worldFrames - first.worldFrames;
  if (!Number.isFinite(first.atMs) || !Number.isFinite(last.atMs) || elapsed <= 0
    || !Number.isSafeInteger(first.worldFrames) || !Number.isSafeInteger(last.worldFrames)
    || first.worldFrames < 0 || frames < 0) return null;
  return frames * 1000 / elapsed;
}

async function worldFrameStamp(page: Page): Promise<WorldFrameStamp> {
  return page.evaluate(() => {
    const worldFrames = Number(document.querySelector<HTMLElement>(".world-scene")?.dataset.worldFrames);
    if (!Number.isSafeInteger(worldFrames) || worldFrames < 0) throw new Error("World submission counter is unavailable");
    return { atMs: performance.now(), worldFrames };
  });
}

export interface AppearanceObservation {
  at: number; coveragePercent: number; islandMean: number | null;
  islandBeforeMs: number; islandAfterMs: number;
}

export function appearanceSamplesStable(previous: AppearanceObservation, current: AppearanceObservation): boolean {
  return current.islandBeforeMs - previous.islandAfterMs >= 400
    && Number.isFinite(previous.coveragePercent) && Number.isFinite(current.coveragePercent)
    && Math.abs(current.coveragePercent - previous.coveragePercent) < .3
    && typeof previous.islandMean === "number" && typeof current.islandMean === "number"
    && Number.isFinite(previous.islandMean) && Number.isFinite(current.islandMean)
    && Math.abs(current.islandMean - previous.islandMean) < 1;
}

/** One deadline covers both conditions. A late stable sample is still a timeout. */
export async function waitForAppearanceStability<T extends AppearanceObservation>(options: {
  now(): number | Promise<number>;
  delay(milliseconds: number): void | Promise<unknown>;
  capture(deadlineMs: number): Promise<T>;
}) {
  const startedAtMs = await options.now(), deadlineMs = startedAtMs + settlingTimeoutMs, samples: T[] = [];
  const finish = async (status: "stable" | "timeout" | "error", error?: string) => {
    const finishedAtMs = await options.now();
    return { status: status === "stable" && finishedAtMs > deadlineMs ? "timeout" as const : status,
      startedAtMs, deadlineMs, finishedAtMs, elapsedMs: finishedAtMs - startedAtMs, samples, error };
  };
  while (await options.now() < deadlineMs) {
    const previous = samples.at(-1);
    if (previous) {
      const now = await options.now();
      const gap = Math.max(0, previous.islandAfterMs + 400 - now);
      if (gap) await options.delay(Math.min(gap, Math.max(0, deadlineMs - now)));
      if (await options.now() >= deadlineMs) break;
    }
    let current: T;
    try { current = await options.capture(deadlineMs); }
    catch (error) {
      return finish(await options.now() >= deadlineMs ? "timeout" : "error", String(error));
    }
    samples.push(current);
    const endedAtMs = await options.now();
    if (endedAtMs > deadlineMs) return finish("timeout");
    if (current.islandBeforeMs > current.islandAfterMs || current.islandAfterMs > endedAtMs)
      return finish("error", "Appearance capture timestamps are inconsistent");
    if (previous && appearanceSamplesStable(previous, current)) return finish("stable");
  }
  return finish("timeout");
}

async function geometry(page: Page, anchorSelector: string) {
  return page.evaluate(({ anchorSelector, characterSelector }) => {
    const anchor = document.querySelector<HTMLElement>(anchorSelector);
    const canvas = document.querySelector<HTMLCanvasElement>(characterSelector);
    const world = document.querySelector<HTMLElement>(".world-scene");
    if (!anchor || !canvas || !world) throw new Error("World appearance fixture is missing its actual anchor or canvas");
    const gl = world.querySelector("canvas")!.getContext("webgl2"), debug = gl?.getExtension("WEBGL_debug_renderer_info");
    return { anchorSelector, anchorClass: anchor.className, feet: anchor.getBoundingClientRect().toJSON(),
      characterCanvas: canvas.getBoundingClientRect().toJSON(), characterVisibility: getComputedStyle(canvas).visibility,
      renderer: debug ? String(gl!.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : null,
      dpr: devicePixelRatio, world: { ...world.dataset }, at: performance.now(), epochMs: performance.timeOrigin + performance.now() };
  }, { anchorSelector, characterSelector });
}

async function twoFrames(page: Page, timeoutMs?: number) {
  await page.evaluate(timeout => new Promise<void>((resolve, reject) => {
    let first = 0, second = 0;
    const timer = timeout === undefined ? undefined : setTimeout(() => {
      cancelAnimationFrame(first); cancelAnimationFrame(second);
      reject(new Error("Appearance settling deadline exceeded while waiting for two frames"));
    }, timeout);
    first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => { if (timer !== undefined) clearTimeout(timer); resolve(); });
    });
  }), timeoutMs);
}

/** M2/S1: normal compositor image plus a canvas-only hidden image, with unchanged layout. */
export async function captureAppearanceSeries(page: Page, directory: string, options: {
  background: readonly [number, number, number]; anchorSelector?: string;
}) {
  const anchorSelector = options.anchorSelector ?? ".vx-home__feet[data-world-anchor]";
  await mkdir(directory, { recursive: true });
  await page.locator('.vx-home__character[data-character-state="ready"]').waitFor({ timeout: 15000 });
  await page.waitForFunction(() => document.documentElement.dataset.worldIntro === "off");
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const runtime = await geometry(page, anchorSelector);
  assert(runtime.renderer && !/swiftshader|llvmpipe|software|basic render/i.test(runtime.renderer), "Appearance metrics require a real GPU");
  assert.match(runtime.renderer, /Direct3D11|D3D11/);
  assert.equal(runtime.dpr, 1);
  assert.equal(runtime.world.worldGrid, "160");
  assert.equal(runtime.world.worldParticles, "65536");

  const now = () => page.evaluate(() => performance.now());
  let settlingIndex = 0;
  const waiting = await waitForAppearanceStability({
    now, delay: milliseconds => page.waitForTimeout(milliseconds),
    capture: async deadlineMs => {
      const remaining = async () => {
        const milliseconds = deadlineMs - await now();
        if (milliseconds <= 0) throw new Error(`Appearance settling exceeded its ${settlingTimeoutMs}ms deadline`);
        return milliseconds;
      };
      const index = settlingIndex++, before = await geometry(page, anchorSelector);
      assert.equal(before.characterVisibility, "visible");
      const normalPath = join(directory, `settling-${index}-normal.png`);
      const hiddenPath = join(directory, `settling-${index}-island.png`);
      const normalTimeout = await remaining(), normalBefore = await worldFrameStamp(page);
      const normalBytes = await page.screenshot({ path: normalPath, scale: "css", timeout: normalTimeout });
      const normalAfter = await worldFrameStamp(page);
      const normal = decodePng(normalBytes);
      const previous = await page.locator(characterSelector).evaluate(canvas => {
        const element = canvas as HTMLElement;
        const previous = { value: element.style.getPropertyValue("visibility"), priority: element.style.getPropertyPriority("visibility") };
        element.style.setProperty("visibility", "hidden", "important");
        return previous;
      });
      try {
        await twoFrames(page, await remaining());
        const hiddenGeometry = await geometry(page, anchorSelector);
        assert.equal(hiddenGeometry.characterVisibility, "hidden");
        assert.deepEqual(hiddenGeometry.feet, before.feet);
        assert.deepEqual(hiddenGeometry.characterCanvas, before.characterCanvas);
        const hiddenTimeout = await remaining(), hiddenBefore = await worldFrameStamp(page);
        const hiddenBytes = await page.screenshot({ path: hiddenPath, scale: "css", timeout: hiddenTimeout });
        const hiddenAfter = await worldFrameStamp(page);
        const hidden = decodePng(hiddenBytes);
        const islandBeforeMs = hiddenBefore.atMs, islandAfterMs = hiddenAfter.atMs;
        const island = islandMetrics(hidden, before.feet, options.background);
        return { at: islandBeforeMs, worldFrames: hiddenBefore.worldFrames, islandBeforeMs, islandAfterMs, normalPath, hiddenPath,
          frameCheckpoints: { normalBefore, normalAfter, hiddenBefore, hiddenAfter },
          coveragePercent: worldAppearanceMetrics(normal, options.background).home.fraction * 100,
          islandMean: island.mean, islandCoverage: island.coverage, before, hiddenGeometry };
      } finally {
        await page.locator(characterSelector).evaluate((canvas, previous) => {
          const element = canvas as HTMLElement;
          if (previous.value) element.style.setProperty("visibility", previous.value, previous.priority);
          else element.style.removeProperty("visibility");
        }, previous);
      }
    },
  });
  const { samples: settling, ...settlingWait } = waiting;
  await writeFile(join(directory, "settling.json"), JSON.stringify({ runtime, stable: waiting.status === "stable", settlingWait, settling }, null, 2));
  assert.equal(waiting.status, "stable", `Appearance did not settle within ${settlingTimeoutMs}ms (${waiting.elapsedMs.toFixed(1)}ms): ${waiting.error ?? waiting.status}`);
  await twoFrames(page);

  const samples = [];
  for (let index = 0; index < 5; index++) {
    const before = await geometry(page, anchorSelector);
    assert.equal(before.characterVisibility, "visible");
    const normal = decodePng(await page.screenshot({ path: join(directory, `normal-${index}.png`), scale: "css" }));
    const previous = await page.locator(characterSelector).evaluate(canvas => {
      const element = canvas as HTMLElement;
      const previous = { value: element.style.getPropertyValue("visibility"), priority: element.style.getPropertyPriority("visibility") };
      element.style.setProperty("visibility", "hidden", "important");
      return previous;
    });
    try {
      await twoFrames(page);
      const hiddenGeometry = await geometry(page, anchorSelector);
      assert.deepEqual(hiddenGeometry.feet, before.feet, "Hiding the canvas must preserve the actual anchor");
      assert.deepEqual(hiddenGeometry.characterCanvas, before.characterCanvas, "Hiding the canvas must preserve layout");
      assert.equal(hiddenGeometry.characterVisibility, "hidden");
      const hidden = decodePng(await page.screenshot({ path: join(directory, `island-${index}.png`), scale: "css" }));
      samples.push({ index, before, hiddenGeometry,
        island: islandMetrics(hidden, before.feet, options.background),
        outside: outsideIslandMetrics(hidden, before.feet, options.background),
        far: farMetrics(normal), lower: lowerWorldWhiteMetrics(normal),
        coveragePercent: worldAppearanceMetrics(normal, options.background).home.fraction * 100 });
    } finally {
      await page.locator(characterSelector).evaluate((canvas, previous) => {
        const element = canvas as HTMLElement;
        if (previous.value) element.style.setProperty("visibility", previous.value, previous.priority);
        else element.style.removeProperty("visibility");
      }, previous);
      await twoFrames(page);
    }
    const restored = await geometry(page, anchorSelector);
    assert.equal(restored.characterVisibility, "visible");
    assert.deepEqual(restored.feet, before.feet);
    if (index < 4) await page.waitForTimeout(250);
  }
  const result = { runtime, settling, settlingWait,
    medians: {
      islandCoverage: median(samples.map(sample => sample.island.coverage)),
      islandMean: median(samples.map(sample => sample.island.mean!)),
      islandP95: median(samples.map(sample => sample.island.p95!)),
      islandWhiteFraction: median(samples.map(sample => sample.island.pureWhiteFraction!)),
      outsideMeanAbsDelta: median(samples.map(sample => sample.outside.meanAbsDelta!)),
      farP95: median(samples.map(sample => sample.far.p95!)),
      lowerWhiteFraction: median(samples.map(sample => sample.lower.fraction!)),
      coveragePercent: median(samples.map(sample => sample.coveragePercent)),
    }, samples };
  await writeFile(join(directory, "measurements.json"), JSON.stringify(result, null, 2));
  return result;
}
