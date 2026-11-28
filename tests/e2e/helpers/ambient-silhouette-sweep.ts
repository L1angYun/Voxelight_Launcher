// SPDX-License-Identifier: GPL-3.0-only
import type { Page } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodePng } from "./glass-pixel-probe.mjs";
import { SILHOUETTE_FAR_ROI, SILHOUETTE_SKY_ROI, silhouetteMetrics } from "./world-appearance.ts";
import { DEFAULT_ACCENT } from "../../../src/design/accent.ts";
import { deriveAmbientPalette } from "../../../src/design/ambient.ts";
import {
  DRIFT_ORBIT_PERIODS_S, SPRITE_STOPS, computeFieldStates, type AmbientFieldState,
} from "../../../src/visual/ambient/ambientController.ts";

/** The page's own ambient controller module, as the dev server serves it to the app. */
const AMBIENT_MODULE = "/src/visual/ambient/ambientController.ts";
/** Every field retraces its whole drift path within the longest orbit (field 0: 4 x 38 s). */
export const AMBIENT_ORBIT_SPAN_MS = Math.max(...DRIFT_ORBIT_PERIODS_S) * 1000;
/**
 * The far ROI is mostly sky between thin ridge lines: a least-squares fit of
 * real-page frames (1280 and 1050, light horizon) weighted its darkening at
 * 0.88-0.92 of the sky strip's. Used only to rank phases; the page judges them.
 */
const FAR_SKY_WEIGHT = 0.9;

const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
const lcm = (a: number, b: number) => a / gcd(a, b) * b;

function spriteAlpha(radius: number) {
  if (radius >= 1) return 0;
  for (let index = 1; index < SPRITE_STOPS.length; index++) {
    const [r1, a1] = SPRITE_STOPS[index];
    if (radius > r1) continue;
    const [r0, a0] = SPRITE_STOPS[index - 1];
    return a0 + (a1 - a0) * (radius - r0) / (r1 - r0);
  }
  return 0;
}

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
  return .2126 * r + .7152 * g + .0722 * b;
}

/** Mean multiply darkening (alpha minus premultiplied luminance) the fields alone lay over `points`. */
function darkening(fields: AmbientFieldState[], points: [number, number][], luminances: number[]) {
  let total = 0;
  for (const [x, y] of points) {
    let alpha = 0, light = 0;
    for (const field of fields) {
      const dx = x - field.x, dy = y - field.y, cos = Math.cos(-field.rotation), sin = Math.sin(-field.rotation);
      const a = field.alpha * spriteAlpha(Math.hypot((dx * cos - dy * sin) / field.rx, (dx * sin + dy * cos) / field.ry));
      light = luminances[field.index] * a + light * (1 - a);
      alpha = a + alpha * (1 - a);
    }
    total += alpha - light;
  }
  return total / points.length;
}

/**
 * The ambient times at which the light-theme fields alone darken the R3-4 sky
 * strip most against the far ROI below it: the product's own field states and
 * sprite profile, the fixture's default palette, a coarse grid, searched every
 * 4 s over the drawn fields' joint drift period and refined to 0.5 s. The real
 * page then measures each of these phases.
 */
export function worstAmbientSilhouettePhases(width: number, height: number, count = 4) {
  const config = { enabled: true, theme: "light" as const, palette: deriveAmbientPalette(DEFAULT_ACCENT, "light"), intensity: .6 };
  const luminances = config.palette.map(luminance);
  const grid = (roi: readonly number[]) => {
    const points: [number, number][] = [];
    for (let y = roi[1] * height + 16; y < roi[3] * height; y += 32) for (let x = roi[0] * width + 16; x < roi[2] * width; x += 32) points.push([x, y]);
    return points;
  };
  const sky = grid(SILHOUETTE_SKY_ROI), far = grid(SILHOUETTE_FAR_ROI);
  const score = (seconds: number) => {
    const fields = computeFieldStates(seconds * 1000, width, height, config);
    return darkening(fields, sky, luminances) - FAR_SKY_WEIGHT * darkening(fields, far, luminances);
  };
  const drawn = computeFieldStates(0, width, height, config).length;
  const jointS = DRIFT_ORBIT_PERIODS_S.slice(0, drawn).reduce<number>(lcm, 1);
  let coarse: { seconds: number; score: number }[] = [];
  for (let seconds = 0; seconds < jointS; seconds += 4) {
    const value = score(seconds);
    if (coarse.length < 32 || value > coarse[coarse.length - 1].score) {
      coarse.push({ seconds, score: value });
      coarse.sort((a, b) => b.score - a.score);
      coarse = coarse.slice(0, 32);
    }
  }
  const refined = coarse.map(candidate => {
    let best = candidate;
    for (let seconds = candidate.seconds - 4; seconds <= candidate.seconds + 4; seconds += .5) {
      const value = score(seconds);
      if (value > best.score) best = { seconds, score: value };
    }
    return best;
  }).sort((a, b) => b.score - a.score);
  const chosen: typeof refined = [];
  for (const candidate of refined) {
    if (chosen.every(other => Math.abs(other.seconds - candidate.seconds) >= 60)) chosen.push(candidate);
    if (chosen.length === count) break;
  }
  return { jointPeriodS: jointS, phases: chosen.map(phase => ({ ms: phase.seconds * 1000, score: phase.score })) };
}

/** The default Full ambient layer as the page shows it, with a checksum of its canvas. */
async function ambientLayerState(page: Page) {
  return page.evaluate(() => {
    const layer = document.querySelector<HTMLElement>(".vx-app-body > .vx-ambient");
    const canvas = layer?.querySelector<HTMLCanvasElement>("canvas.vx-ambient-canvas") ?? null;
    let checksum: number | null = null;
    if (canvas) {
      const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
      checksum = 0;
      for (let index = 0; index < data.length; index++) checksum = (Math.imul(checksum, 31) + data[index]) >>> 0;
    }
    const style = layer ? getComputedStyle(layer) : null;
    return { at: performance.now(), mode: layer?.dataset.ambientMode ?? null, theme: layer?.dataset.ambientTheme ?? null,
      canvases: layer?.querySelectorAll("canvas.vx-ambient-canvas").length ?? 0,
      visibility: style?.visibility ?? null, opacity: style ? Number(style.opacity) : null,
      blend: style?.mixBlendMode ?? null, hidden: document.hidden, checksum };
  });
}

/** The product's own loop keeps the canvas drifting: two readbacks 500 ms apart differ. */
async function liveDrift(page: Page) {
  const first = await ambientLayerState(page);
  let now: number;
  while ((now = await page.evaluate(() => performance.now())) < first.at + 500) await page.waitForTimeout(first.at + 500 - now);
  const second = await ambientLayerState(page);
  return { first: first.checksum, second: second.checksum, drifting: first.checksum !== null && first.checksum !== second.checksum };
}

async function controller(page: Page, action: "stop" | "start") {
  await page.evaluate(async ({ url, action }) => {
    const module = await import(url);
    const active = module.getActiveAmbientController();
    if (!active) throw new Error("The page has no active ambient controller");
    if (action === "stop") active.stop(); else active.start();
  }, { url: AMBIENT_MODULE, action });
}

/** Draw the page's ambient canvas at `timeMs` through its own controller and let two frames composite. */
async function drawAmbientAt(page: Page, timeMs: number) {
  return page.evaluate(async ({ url, timeMs }) => {
    const module = await import(url);
    const active = module.getActiveAmbientController();
    if (!active) throw new Error("The page has no active ambient controller");
    const drew: boolean = active.drawAt(timeMs);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { drew, fps: active.getFps() as number };
  }, { url: AMBIENT_MODULE, timeMs });
}

type SweepKind = "orbit" | "orbit-refine" | "joint" | "joint-refine";
type SweepFrame = { timeMs: number; kind: SweepKind; drew: boolean; still: boolean; fps: number;
  silhouette: ReturnType<typeof silhouetteMetrics> };

function worstOf(frames: SweepFrame[]) {
  const delta = frames.reduce((a, b) => b.silhouette.deltaL > a.silhouette.deltaL ? b : a);
  const tiles = frames.reduce((a, b) => b.silhouette.tiles < a.silhouette.tiles ? b : a);
  return { deltaL: delta.silhouette.deltaL, deltaLAtMs: delta.timeMs, deltaLKind: delta.kind,
    lowestDeltaL: Math.min(...frames.map(frame => frame.silhouette.deltaL)),
    tiles: tiles.silhouette.tiles, tilesAtMs: tiles.timeMs,
    farP05: Math.min(...frames.map(frame => frame.silhouette.farP05)) };
}

/**
 * ui-language-spec 2.11.4: the transparent sky lets the ambient light show
 * through while the voxel ridge stays the clear subject. On the real page,
 * ambient layer visible at its own opacity and blend, the product's controller
 * is stopped and driven through chosen times with drawAt; each frame is the
 * page's real composite of that light over the live world. The times are:
 * - every 2 s across the longest drift orbit (152 s), in which each field
 *   retraces its whole drift path (field 1: 132 s, its breathing included),
 *   with the configurations at 6 s and 92 s where field 1 used to sit above
 *   the ridge;
 * - the worst joint phases of all fields over their joint drift period;
 * - 0.5 s and 1 s either side of the two worst orbit frames and every joint phase.
 * The loop drifts live before the sweep and again after it. `orbitWorst` covers
 * the orbit frames and their refinements, `jointWorst` the joint ones, `worst` all.
 */
export async function captureAmbientSilhouetteSweep(page: Page, directory: string, options: {
  background: readonly [number, number, number]; stepMs?: number; jointPhases?: number;
}) {
  const stepMs = options.stepMs ?? 2000;
  await mkdir(directory, { recursive: true });
  const layer = await ambientLayerState(page);
  assert.equal(layer.mode, "canvas", "The real-page silhouette is measured over the default Full ambient canvas");
  assert.equal(layer.theme, "light");
  assert.equal(layer.canvases, 1);
  assert.equal(layer.visibility, "visible");
  assert.equal(layer.hidden, false);
  assert(layer.opacity !== null && layer.opacity > 0, "The ambient light layer must be visible");
  const viewport = page.viewportSize();
  assert(viewport, "The sweep needs a fixed viewport");
  const joint = worstAmbientSilhouettePhases(viewport.width, viewport.height, options.jointPhases ?? 4);
  const liveBefore = await liveDrift(page);
  const frames: SweepFrame[] = [];
  const images = new Map<number, Buffer>();
  const measure = async (timeMs: number, kind: SweepKind) => {
    if (timeMs < 0 || frames.some(frame => frame.timeMs === timeMs)) return;
    const drawn = await drawAmbientAt(page, timeMs);
    const before = await ambientLayerState(page);
    const png = await page.screenshot({ scale: "css" });
    const after = await ambientLayerState(page);
    const silhouette = silhouetteMetrics(decodePng(png), options.background);
    frames.push({ timeMs, kind, drew: drawn.drew, fps: drawn.fps,
      still: before.checksum !== null && before.checksum === after.checksum, silhouette });
    images.set(timeMs, png);
  };
  await controller(page, "stop");
  try {
    for (let timeMs = 0; timeMs <= AMBIENT_ORBIT_SPAN_MS; timeMs += stepMs) await measure(timeMs, "orbit");
    for (const phase of joint.phases) await measure(phase.ms, "joint");
    const worstOrbit = frames.filter(frame => frame.kind === "orbit")
      .sort((a, b) => b.silhouette.deltaL - a.silhouette.deltaL).slice(0, 2).map(frame => frame.timeMs);
    for (const center of worstOrbit) for (const offset of [-1000, -500, 500, 1000]) await measure(center + offset, "orbit-refine");
    for (const phase of joint.phases) for (const offset of [-1000, -500, 500, 1000]) await measure(phase.ms + offset, "joint-refine");
  } finally {
    await controller(page, "start");
  }
  const liveAfter = await liveDrift(page);
  const worst = worstOf(frames);
  await writeFile(join(directory, "ambient-worst-delta-l.png"), images.get(worst.deltaLAtMs)!);
  await writeFile(join(directory, "ambient-worst-tiles.png"), images.get(worst.tilesAtMs)!);
  const orbitTimes = frames.filter(frame => frame.kind === "orbit").map(frame => frame.timeMs);
  const result = {
    method: "real page, ambient layer visible; the page's own controller stopped and drawn at each time with drawAt; normal frames",
    layer, stepMs, orbitSpanMs: AMBIENT_ORBIT_SPAN_MS, orbitPeriodsS: DRIFT_ORBIT_PERIODS_S,
    orbitCovered: orbitTimes.length === Math.floor(AMBIENT_ORBIT_SPAN_MS / stepMs) + 1
      && orbitTimes.every((timeMs, index) => timeMs === index * stepMs) && orbitTimes.at(-1) === AMBIENT_ORBIT_SPAN_MS,
    joint, jointMeasured: joint.phases.every(phase => frames.some(frame => frame.timeMs === phase.ms)),
    liveBefore, liveAfter,
    driven: frames.every(frame => frame.drew && frame.still),
    worst,
    orbitWorst: worstOf(frames.filter(frame => frame.kind.startsWith("orbit"))),
    jointWorst: worstOf(frames.filter(frame => frame.kind.startsWith("joint"))),
    frames: frames.map(({ timeMs, kind, drew, still, fps, silhouette }) => ({ timeMs, kind, drew, still, fps,
      silhouette: { deltaL: silhouette.deltaL, tiles: silhouette.tiles, farP05: silhouette.farP05,
        farMeanL: silhouette.farMeanL, skyMeanL: silhouette.skyMeanL, skyOffset: silhouette.skyOffset } })),
  };
  await writeFile(join(directory, "ambient-silhouette.json"), JSON.stringify(result, null, 2));
  return result;
}

export type AmbientSilhouetteSweep = Awaited<ReturnType<typeof captureAmbientSilhouetteSweep>>;
