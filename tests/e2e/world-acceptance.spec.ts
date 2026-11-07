// SPDX-License-Identifier: GPL-3.0-only
import { chromium, expect, test, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { installLauncherFixture } from "./fixtures";
import { selectValue } from "./select-helpers";
import { captureTextContrast, type ContrastTarget, type WorldContrastReport } from "./helpers/world-contrast-probe";
import { prepareIntroContrast } from "./helpers/world-intro-compositor";
import { installWorldResourceProbe, snapshotWorldResources, type WorldResourceSnapshot } from "./helpers/world-resource-probe";
import { decodePng } from "./helpers/glass-pixel-probe.mjs";
import { worldAppearanceMetrics } from "./helpers/world-appearance";
import { captureAppearanceSeries } from "./helpers/world-appearance-capture";
import { loadAppearanceBudget as appearanceBudget } from "./helpers/world-appearance-budget";
import { installWorldUniformProbe } from "./helpers/world-uniform-probe";
import { evidenceDirectory } from "./helpers/evidence-directory";

const evidence = evidenceDirectory("world-acceptance");

const appearanceTest = test.extend({
  context: async ({ baseURL }, use) => {
    const browser = await chromium.launch({ channel: "chromium", args: ["--use-angle=d3d11"] });
    const context = await browser.newContext({ baseURL, deviceScaleFactor: 1 });
    try { await use(context); } finally { await context.close(); await browser.close(); }
  },
});

appearanceTest.beforeEach(async ({ page }) => { await installWorldUniformProbe(page); });

/** Observe the actual renderer, independently of fixture settings. */
async function expectWorldAppearance(page: Page, theme: string, scene: string) {
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await expect(page.locator(".world-scene")).toHaveAttribute("data-world-scene", scene);
}

/** Test-only terrain clock override; keep every other uniform and animation live. */
async function pinTerrainTime(page: Page, phase: number) {
  await page.addInitScript(value => {
    const names = new WeakMap<WebGLUniformLocation, string>();
    const proto = WebGL2RenderingContext.prototype;
    const locate = proto.getUniformLocation, submit = proto.uniform1f;
    const probe = { calls: 0, applied: [] as number[] };
    (window as Window & { __terrainTimeProbe?: typeof probe }).__terrainTimeProbe = probe;
    proto.getUniformLocation = function(program, name) {
      const location = locate.call(this, program, name);
      if (location) names.set(location, name);
      return location;
    };
    proto.uniform1f = function(location, supplied) {
      if (location && names.get(location) === "uT"
        && this.canvas instanceof HTMLCanvasElement && this.canvas.closest(".world-scene")) {
        probe.calls++;
        if (!probe.applied.includes(value)) probe.applied.push(value);
        return submit.call(this, location, value);
      }
      return submit.call(this, location, supplied);
    };
  }, phase);
}

appearanceTest.describe("terrain breathing highlight safety", () => {
  for (const width of [1280, 1050, 1920]) for (const phase of [9.7, 188, 288, 588]) {
    appearanceTest(`dark horizon ${width} uT=${phase}: breathing retains highlight headroom`, async ({ page }, info) => {
      appearanceTest.setTimeout(90000);
      await page.setViewportSize({ width, height: width === 1920 ? 1080 : 720 });
      await pinTerrainTime(page, phase);
      await installLauncherFixture(page, { theme: "dark", effects: "full", worldScene: "horizon", worldMaterial: "lattice" });
      await page.goto("/");
      await expectWorldAppearance(page, "dark", "horizon");
      const result = await captureAppearanceSeries(page, info.outputPath("terrain-phase"), {
        background: [7, 8, 11], stability: "fixed",
      });
      await expectWorldAppearance(page, "dark", "horizon");
      const probe = await page.evaluate(() => (window as Window & {
        __terrainTimeProbe?: { calls: number; applied: number[] }
      }).__terrainTimeProbe);
      expect(probe?.calls).toBeGreaterThan(0);
      expect(probe?.applied).toEqual([phase]);
      const numeric = result.samples.map(sample => ({ index: sample.index,
        p95: sample.island.p95, islandWhite: sample.island.pureWhiteFraction, lowerWhite: sample.lower.fraction,
        pass: sample.island.p95 !== null && sample.island.p95 <= 200
          && sample.island.pureWhiteFraction !== null && sample.island.pureWhiteFraction < .005
          && sample.lower.fraction !== null && sample.lower.fraction < .001,
      }));
      // Revision 4: judge startup brightness at the same terrain phase in each
      // width. The unfrozen burst retains its other gates and records its mean.
      const startupMean = phase === 9.7 ? { value: result.medians.islandMean,
        rule: "90 <= mean <= 150 at uT=9.7 after settling",
        pass: result.medians.islandMean >= 90 && result.medians.islandMean <= 150 } : null;
      await writeFile(info.outputPath("terrain-breathing.json"), JSON.stringify({
        width, phase, probe, runtime: result.runtime, waiting: result.settlingWait, numeric,
        startupMean, medians: result.medians,
        allNumericPass: numeric.every(row => row.pass) && (startupMean?.pass ?? true),
        diagnostics: result.samples.map(sample => ({ index: sample.index, mean: sample.island.mean, uniforms: sample.uniforms,
          coverage: sample.island.coverage, valid: sample.island.valid })),
        manual: { status: "not-assessed-by-automated-test", checks: phase === 9.7
          ? [{ id: "R2-19-feet-on-island", screenshot: info.outputPath("terrain-phase", "normal-2.png") }] : [] },
      }, null, 2));
      for (const frame of numeric) expect.soft(frame.pass, `phase ${phase}, frame ${frame.index}: ${JSON.stringify(frame)}`).toBe(true);
      if (startupMean) expect.soft(startupMean.pass, `startup brightness: ${JSON.stringify(startupMean)}`).toBe(true);
    });
  }
});

appearanceTest.describe("review A appearance budgets", () => {
  for (const theme of ["dark", "light"] as const) for (const width of [1280, 1050]) {
    appearanceTest(`${theme} ${width}: home lower-world coverage stays within its visual budget`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 720 });
      await installLauncherFixture(page, { theme });
      await page.goto("/");
      await expectWorldAppearance(page, theme, "horizon");
      const sample = await captureAppearanceSeries(page, info.outputPath("appearance"), {
        background: theme === "dark" ? [7, 8, 11] : [243, 241, 235],
      });
      const baseline = await appearanceBudget(theme, width);
      // Preserve the approved five-point design increment. S1 adds three
      // standard deviations measured from the independent d5e31ad reference.
      expect(baseline.coverageLimit).not.toBeNull();
      expect(sample.medians.coveragePercent).toBeLessThanOrEqual(baseline.coverageLimit!);
    });
  }
  appearanceTest("dark 1280: content title bands stay quiet across all content pages", async ({ page }, info) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await installLauncherFixture(page, { theme: "dark" });
    await page.route("https://api.modrinth.com/v2/search?**", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ hits: [] }) }));
    await page.goto("/"); await page.waitForTimeout(3500);
    await page.locator('.vx-floating-nav [data-page="home"]').click(); await page.waitForTimeout(700);
    const results = [];
    for (const id of ["library", "discover", "multiplayer", "downloads", "accounts", "settings"]) {
      await page.locator(`.vx-floating-nav [data-page="${id}"]`).click(); await page.waitForTimeout(700);
      const metrics = worldAppearanceMetrics(decodePng(await page.screenshot({ path: info.outputPath(`content-${id}.png`), scale: "css" })), [7, 8, 11]);
      results.push({ page: id, ...metrics });
      expect.soft(metrics.title.fraction, `${id}: title band pixels brighter than 60/255`).toBeLessThan(.005);
    }
    await writeFile(info.outputPath("content-appearance.json"), JSON.stringify(results, null, 2));
  });
});

appearanceTest.describe("round 2 anchored island acceptance", () => {
  const cases = [
    { theme: "dark", width: 1280, height: 720, scene: "horizon" },
    { theme: "dark", width: 1050, height: 720, scene: "horizon" },
    { theme: "dark", width: 1920, height: 1080, scene: "horizon" },
    { theme: "light", width: 1280, height: 720, scene: "horizon" },
    { theme: "dark", width: 1280, height: 720, scene: "massif" },
  ] as const;
  for (const { theme, width, height, scene } of cases) {
    appearanceTest(`M1/M2 ${theme} ${scene} ${width}: anchored island and its surroundings meet their budgets`, async ({ page }, info) => {
      appearanceTest.setTimeout(90000);
      await page.setViewportSize({ width, height });
      await installLauncherFixture(page, { theme, effects: "full", worldScene: scene, worldMaterial: "lattice" });
      await page.goto("/");
      await expectWorldAppearance(page, theme, scene);
      const sampled = await captureAppearanceSeries(page, info.outputPath("anchored-island"), {
        background: theme === "dark" ? [7, 8, 11] : [243, 241, 235],
      });
      await expectWorldAppearance(page, theme, scene);
      const measured = sampled.medians;
      const checks: { id: string; value: number; rule: string; pass: boolean }[] = [];
      if (scene === "horizon") checks.push(
        { id: "valid-roi", value: Math.min(...sampled.samples.map(sample => sample.island.coverage)),
          rule: "Every sampled ROI covers >=85% non-background pixels before the neutral filter",
          pass: sampled.samples.every(sample => sample.island.valid) },
      );
      if (theme === "dark" && scene === "horizon") {
        checks.push(
          { id: "island-p95", value: measured.islandP95, rule: "p95 <= 200", pass: measured.islandP95 <= 200 },
          { id: "island-white", value: measured.islandWhiteFraction, rule: "pure white <0.005", pass: measured.islandWhiteFraction < .005 },
        );
      }
      if (theme === "dark") checks.push(
        { id: "lower-white", value: measured.lowerWhiteFraction, rule: "normal lower-world white <0.001", pass: measured.lowerWhiteFraction < .001 },
      );
      if (scene === "horizon") {
        const baseline = await appearanceBudget(theme, width);
        if (!baseline.outsideApplies || !baseline.sources["287a3af"]?.complete || baseline.outsideLimit === null)
          throw new Error(`Missing matched historical outside-island references for ${theme}-${width}`);
        checks.push({ id: "outside-island", value: measured.outsideMeanAbsDelta,
          rule: `<= d5e31ad + 0.35*(287a3af-d5e31ad) = ${baseline.outsideLimit}`,
          pass: measured.outsideMeanAbsDelta <= baseline.outsideLimit });
        if (theme === "light") {
          const delta = Math.abs(measured.islandMean - baseline.sources.a4f756e.metrics.islandMean.mean);
          checks.push({ id: "light-island-change", value: delta, rule: "absolute mean change from a4f756e <=3", pass: delta <= 3 });
        }
      }
      // The user explicitly restricted this gate after inspecting the actual
      // content of the proportional ROI in the other scenes and themes.
      if (theme === "dark" && scene === "horizon" && width === 1280)
        checks.push({ id: "far-p95", value: measured.farP95, rule: "60 <= p95 <= 90", pass: measured.farP95 >= 60 && measured.farP95 <= 90 });
      const manualScreenshot = scene === "massif" ? info.outputPath("massif-manual.png") : null;
      if (manualScreenshot) await page.screenshot({ path: manualScreenshot, scale: "css" });
      await writeFile(info.outputPath("numeric-acceptance.json"), JSON.stringify({
        scenario: { theme, width, height, scene }, numeric: checks,
        allAGatesPass: checks.every(check => check.pass),
        waiting: sampled.settlingWait, medians: measured,
        frames: sampled.samples.map(sample => ({ index: sample.index, at: sample.hiddenGeometry.at,
          uniforms: sample.uniforms,
          island: sample.island, outside: sample.outside, far: sample.far, lower: sample.lower })),
        diagnostics: { farP95: measured.farP95, outsideMeanAbsDelta: measured.outsideMeanAbsDelta,
          island: { scope: scene === "massif" ? "record-only" : "see-numeric-checks", meanScope: theme === "dark" ? "record-only; startup mean gate uses fixed uT=9.7" : "relative baseline gate", coverage: measured.islandCoverage,
            mean: measured.islandMean, p95: measured.islandP95, whiteFraction: measured.islandWhiteFraction } },
        manual: { status: "not-assessed-by-automated-test", checks: manualScreenshot
          ? [{ id: "massif-island-surface", criterion: "Inspect mountain surface for an overall gray or dark cast", screenshot: manualScreenshot }] : [] },
      }, null, 2));
      for (const check of checks)
        expect.soft(check.pass, `${check.id}: ${check.value}; ${check.rule}${check.id === "valid-roi" ? "; ROI 未覆盖岛面" : ""}`).toBe(true);
    });
  }
});

const targets: ContrastTarget[] = [
  { name: "title", selector: ".vx-home__console-name", minimum: 3, nominalDuringIntro: true },
  { name: "metadata", selector: ".vx-home__meta li", minimum: 4.5, nominalDuringIntro: true },
  { name: "operation", selector: ".vx-launch-console__actions .vx-button__label, .vx-launch-console__running .vx-button__label", minimum: 4.5 },
  { name: "preparation", selector: ".vx-launch-console__progress-heading > span, .vx-launch-console__file-count", minimum: 4.5, optional: true },
  { name: "progress value", selector: ".vx-launch-console__progress-text", minimum: 4.5, optional: true },
  { name: "running", selector: ".vx-launch-console__running > span", minimum: 4.5, optional: true },
];

const previewSourceTarget: ContrastTarget = { name: "preview source", selector: ".vx-home__preview-source", minimum: 4.5 };

interface FixtureControl { progress(fraction: number): void; completeLaunch(): void }
type ControlledWindow = Window & { __worldAcceptanceFixture?: FixtureControl };

/** Control transport completion and emit the same progress event the real controller consumes. */
async function installControlledLaunch(page: Page) {
  await page.addInitScript(() => {
    interface FixtureApi {
      transformCallback(callback: (value: unknown) => void): number;
      invoke(name: string, args?: Record<string, unknown>): Promise<unknown>;
    }
    const host = window as unknown as { __TAURI_INTERNALS__?: FixtureApi };
    const callbacks = new Map<number, (value: unknown) => void>();
    let progressHandler = 0, finish = () => {};
    const completion = new Promise<void>(resolve => { finish = resolve; });
    const wrapped = new WeakSet<FixtureApi>();
    function attach(api: FixtureApi) {
      if (wrapped.has(api)) return;
      wrapped.add(api);
      const invoke = api.invoke, transform = api.transformCallback;
      api.transformCallback = callback => { const id = transform(callback); callbacks.set(id, callback); return id; };
      api.invoke = async (name, args) => {
        if (name === "plugin:event|listen" && args?.event === "launcher://progress") progressHandler = Number(args.handler);
        const result = await invoke(name, args);
        if (name === "launch_game") await completion;
        return result;
      };
    }
    // Playwright does not guarantee ordering across init scripts. Hook either
    // the fixture's existing API or its later assignment before app code runs.
    let api = host.__TAURI_INTERNALS__;
    Object.defineProperty(host, "__TAURI_INTERNALS__", { configurable: true, enumerable: true,
      get: () => api, set(value: FixtureApi) { api = value; attach(value); } });
    if (api) attach(api);
    (window as ControlledWindow).__worldAcceptanceFixture = {
      completeLaunch: () => finish(),
      progress(fraction) {
        const completed = Math.round(fraction * 100);
        const callback = callbacks.get(progressHandler);
        if (!callback) throw new Error("Launcher progress listener has not registered");
        callback({ event: "launcher://progress", id: 1, payload: { versionId: "1.21.1", operation: "install", stage: "assets",
          completed, total: 100, bytesCompleted: completed, bytesTotal: 100, message: `Acceptance progress ${completed}%` } });
      },
    };
  });
}

async function captureState(page: Page, directory: string, state: string, recorded?: WorldContrastReport,
  contrastTargets: ContrastTarget[] = targets): Promise<WorldContrastReport> {
  const scene = page.locator(".vx-global-scene");
  // The entrance lasts only 2.5 real seconds. Capture its current compositor
  // first and validate the batched before/after metadata, without serial IPC
  // preflights consuming that finite observation window.
  if (state !== "intro") {
    await expect(scene.locator(".world-scene__canvas")).toBeVisible();
    await expect(scene).toHaveAttribute("data-world-tier", "animated");
    await expect(scene).toHaveAttribute("data-world-material", "lattice");
    await expect.poll(async () => Number(await scene.getAttribute("data-world-frames"))).toBeGreaterThan(0);
  }
  if (state.startsWith("running")) {
    await expect(page.locator(".vx-overture-root")).toHaveAttribute("data-overture-playing", "false");
    await expect(scene).toHaveAttribute("data-paused", "false");
  }
  const report = recorded ?? await captureTextContrast(page, contrastTargets, resolve(directory, `${state}-under-text.png`));
  await writeFile(resolve(directory, `${state}-contrast.json`), JSON.stringify(report, null, 2));
  for (const frame of [report.before, report.after]) {
    expect(frame.tier).toBe("animated"); expect(frame.material).toBe("lattice");
    expect(Number(frame.frames)).toBeGreaterThan(0);
  }
  expect(report.scrim, "The local scrim must remain painted during sampling").not.toBe("none");
  for (const region of report.regions) {
    expect(region.sampledPixels, `${state}: ${region.name} has real compositor pixels`).toBeGreaterThan(0);
    if (!region.nominalOnly) {
      expect(region.paintVisible, `${state}: ${region.name} must actually be visible`).toBe(true);
      expect(region.paintOpacity, `${state}: ${region.name} must actually be visible`).toBeGreaterThanOrEqual(.999);
    }
    expect(region.contrast, `${state}: ${region.name} '${region.text}' at (${region.worstPixel.x},${region.worstPixel.y}), background ${region.worstPixel.rgb}`)
      .toBeGreaterThanOrEqual(region.minimum);
  }
  return report;
}

appearanceTest.describe("review E1 mandatory preview source", () => {
  appearanceTest.afterEach(async ({ page }, info) => {
    const runtime = await page.evaluate(() => {
      const gl = document.querySelector<HTMLCanvasElement>(".world-scene__canvas")?.getContext("webgl2");
      const extension = gl?.getExtension("WEBGL_debug_renderer_info");
      return { renderer: extension ? String(gl!.getParameter(extension.UNMASKED_RENDERER_WEBGL)) : null,
        dpr: devicePixelRatio, viewport: { width: innerWidth, height: innerHeight },
        world: { ...(document.querySelector<HTMLElement>(".world-scene")?.dataset ?? {}) } };
    });
    await writeFile(info.outputPath("browser-runtime.json"), JSON.stringify(runtime, null, 2));
    expect(runtime.renderer).toBeTruthy();
    expect(runtime.renderer).not.toMatch(/swiftshader|llvmpipe|softpipe|software|basic render/i);
    expect(runtime.dpr).toBe(1);
  });

  for (const theme of ["dark", "light"] as const) for (const width of [1280, 1050]) {
    appearanceTest(`${theme} ${width}x720: no-account preview contrast holds through intro and idle`, async ({ page }) => {
      const directory = resolve(evidence, `no-account-${theme}-${width}x720`);
      await mkdir(directory, { recursive: true });
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
      await page.setViewportSize({ width, height: 720 });
      await page.emulateMedia({ reducedMotion: "no-preference", contrast: "no-preference" });
      await installLauncherFixture(page, { noAccount: true, theme, effects: "full", worldScene: "horizon", worldMaterial: "lattice" });
      const noAccountTargets = [...targets, previewSourceTarget];
      const recorder = await prepareIntroContrast(page, noAccountTargets);
      let intro: WorldContrastReport;
      try {
        await page.goto("/", { waitUntil: "commit" });
        intro = await captureState(page, directory, "intro", await recorder.capture(resolve(directory, "intro-under-text.png")), noAccountTargets);
      } finally { await recorder.dispose(); }
      expect(intro.before).toMatchObject({ intro: "on", theme });
      const frame = intro.frameEvidence!;
      expect(frame.source).toBe("CDP Page.screencastFrame");
      expect(frame.domBefore).toMatchObject({ intro: "on", theme });
      expect(frame.domAfter).toMatchObject({ intro: "on", theme });
      expect(Number(frame.timestampEpochMs)).toBeGreaterThanOrEqual(Number(frame.beforeEpochMs));
      expect(Number(frame.timestampEpochMs)).toBeLessThanOrEqual(Number(frame.afterEpochMs));
      expect(Number(frame.candidateFrames)).toBeGreaterThan(0);
      await expect(page.locator("html")).toHaveAttribute("data-world-intro", "off");
      await expect(page.locator(".vx-home__identity")).toHaveCSS("opacity", "1");
      await expect(page.locator(previewSourceTarget.selector)).toHaveCount(1);
      await expect(page.locator(previewSourceTarget.selector)).toBeVisible();
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      // Without an account the real controller rejects launch before preparing;
      // these cases cover the preview's reachable intro and idle states only.
      const idle = await captureState(page, directory, "idle", undefined, noAccountTargets);
      for (const report of [intro, idle]) {
        const previews = report.regions.filter(region => region.name === previewSourceTarget.name);
        expect(previews).toHaveLength(1);
        expect(previews[0].nominalOnly).toBe(false);
        expect(report.before.theme).toBe(theme);
        expect(report.after.theme).toBe(theme);
      }
      await page.screenshot({ path: resolve(directory, "idle-visible.png"), scale: "css" });
      await writeFile(resolve(directory, "states.json"), JSON.stringify({ intro, idle }, null, 2));
      expect(errors).toEqual([]);
    });
  }
});

for (const theme of ["dark", "light"] as const) for (const [width, height] of [[1050, 720], [1440, 1000]]) {
  test(`${theme} ${width}x${height}: composited home text contrast holds through intro, idle, front and running`, async ({ page }) => {
    test.setTimeout(120_000);
    const directory = resolve(evidence, `${theme}-${width}x${height}`); await mkdir(directory, { recursive: true });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ reducedMotion: "no-preference", contrast: "no-preference" });
    await installLauncherFixture(page, { theme, effects: "full", worldScene: "horizon", worldMaterial: "lattice", launchDelay: 0 });
    await installControlledLaunch(page);
    const recorder = await prepareIntroContrast(page, targets);
    let intro: WorldContrastReport;
    try {
      await page.goto("/", { waitUntil: "commit" });
      intro = await captureState(page, directory, "intro", await recorder.capture(resolve(directory, "intro-under-text.png")));
    } finally { await recorder.dispose(); }
    expect(intro.before.intro).toBe("on");
    expect(intro.before.theme).toBe(theme);
    const frame = intro.frameEvidence!;
    expect(frame.source).toBe("CDP Page.screencastFrame");
    expect(frame.domBefore).toMatchObject({ intro: "on", theme });
    expect(frame.domAfter).toMatchObject({ intro: "on", theme });
    expect(Number(frame.timestampEpochMs)).toBeGreaterThanOrEqual(Number(frame.beforeEpochMs));
    expect(Number(frame.timestampEpochMs)).toBeLessThanOrEqual(Number(frame.afterEpochMs));
    expect(Number(frame.candidateFrames)).toBeGreaterThan(0);
    // The PNG may arrive after the entrance; its compositor timestamp, bracketed
    // by actual on observations, proves which state its pixels came from.
    expect(intro.after.intro).toBe("off");
    expect(intro.after.theme).toBe(theme);
    // The title and metadata are intentionally hidden during the wordmark. Their
    // nominal colors are a conservative check of the later text over that frame;
    // the actual launch label remains visible and is also tested.
    await expect(page.locator("html")).toHaveAttribute("data-world-intro", "off", { timeout: 3500 });
    await expect(page.locator(".vx-home__identity")).toHaveCSS("opacity", "1");
    await expect(page.locator(previewSourceTarget.selector)).toHaveCount(0);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const reports: Record<string, WorldContrastReport> = { intro };
    reports.idle = await captureState(page, directory, "idle");
    await page.screenshot({ path: resolve(directory, "idle-visible.png"), scale: "css" });

    const scene = page.locator(".vx-global-scene");
    await page.getByRole("button", { name: "启动游戏", exact: true }).click();
    await expect(scene).toHaveAttribute("data-world-phase", "preparing");
    await expect(page.getByText("37%", { exact: true })).toBeVisible();
    await expect.poll(async () => Number(await scene.getAttribute("data-world-front")), { timeout: 30_000 }).toBe(80);
    reports["front-37"] = await captureState(page, directory, "front-37");
    expect(Number(reports["front-37"].before.front)).toBe(80);
    for (const [fraction, percent, low, high] of [[.7, "70%", 124, 125], [.95, "95%", 158, 158]] as const) {
      await page.evaluate(fraction => (window as ControlledWindow).__worldAcceptanceFixture!.progress(fraction), fraction);
      await expect(page.getByText(percent, { exact: true })).toBeVisible();
      await expect.poll(async () => Number(await scene.getAttribute("data-world-front")), { timeout: 30_000 }).toBeGreaterThanOrEqual(low);
      const state = `front-${Math.round(fraction * 100)}`;
      reports[state] = await captureState(page, directory, state);
      expect(reports[state].before.phase).toBe("preparing");
      expect(Number(reports[state].before.front)).toBeGreaterThanOrEqual(low);
      expect(Number(reports[state].before.front)).toBeLessThanOrEqual(high);
    }
    await page.evaluate(() => (window as ControlledWindow).__worldAcceptanceFixture!.completeLaunch());
    await expect(scene).toHaveAttribute("data-world-phase", "running");
    await expect(scene).toHaveAttribute("data-world-front", "165");
    reports["running-front"] = await captureState(page, directory, "running-front");
    await expect.poll(async () => {
      const before = Number(await scene.getAttribute("data-world-frames"));
      await page.waitForTimeout(700);
      return { delta: Number(await scene.getAttribute("data-world-frames")) - before, settled: await scene.getAttribute("data-world-settled") };
    }, { timeout: 15_000 }).toEqual({ delta: 0, settled: "true" });
    reports["running-settled"] = await captureState(page, directory, "running-settled");
    await expect(page.locator(previewSourceTarget.selector)).toHaveCount(0);
    for (const report of Object.values(reports)) {
      expect(report.before.theme).toBe(theme); expect(report.after.theme).toBe(theme);
    }
    await page.screenshot({ path: resolve(directory, "running-visible.png"), scale: "css" });
    await writeFile(resolve(directory, "states.json"), JSON.stringify(reports, null, 2));
    expect(errors).toEqual([]);
  });
}

async function openAppearance(page: Page) {
  await page.locator('button[data-page="settings"]').click();
  await page.locator(".vx-settings-nav").getByRole("button", { name: "外观", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "世界材质", exact: true })).toBeVisible();
}

async function settledHomeResources(page: Page): Promise<WorldResourceSnapshot> {
  await expect(page.locator(".vx-home__character")).toHaveAttribute("data-character-state", "ready");
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  let previous = "", matches = 0, latest: WorldResourceSnapshot;
  await expect.poll(async () => {
    latest = await snapshotWorldResources(page);
    const key = JSON.stringify({ live: Object.fromEntries(Object.entries(latest.live).filter(([kind]) => kind !== "query")),
      listeners: latest.persistentListeners });
    matches = key === previous ? matches + 1 : 0; previous = key;
    return matches;
  }, { intervals: [100, 200, 300], timeout: 5000 }).toBeGreaterThanOrEqual(2);
  return latest!;
}

test("30 page cycles and 10 scene/material changes retain one context without GPU resource growth", async ({ page }) => {
  test.setTimeout(180_000);
  const directory = resolve(evidence, "resources"); await mkdir(directory, { recursive: true });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.emulateMedia({ reducedMotion: "no-preference", contrast: "no-preference" });
  await installLauncherFixture(page, { theme: "dark", effects: "full", worldMaterial: "lattice" });
  await installWorldResourceProbe(page);
  await page.goto("/");
  const scene = page.locator(".vx-global-scene"), canvas = scene.locator(".world-scene__canvas");
  await expect(scene).toHaveAttribute("data-world-material", "lattice");
  await expect.poll(async () => Number(await scene.getAttribute("data-world-frames"))).toBeGreaterThan(1);
  const originalCanvas = await canvas.elementHandle();
  // Warm the real content/home lifecycle before comparing a like-for-like state.
  await page.locator('button[data-page="library"]').click(); await expect(page.locator(".vx-library-page")).toBeVisible();
  await page.locator('button[data-page="home"]').click(); await expect(page.locator(".vx-home")).toBeVisible();
  // Motion's document projection installs one shared resize listener on its
  // first popup. Include that genuine one-time setup in the home baseline.
  await page.locator(".vx-home__char-col").hover();
  const pose = page.getByRole("combobox", { name: "动画模式", exact: true });
  await pose.click();
  await expect(page.getByRole("listbox", { name: "动画模式", exact: true })).toBeVisible();
  await pose.press("Escape");
  await expect(page.getByRole("listbox", { name: "动画模式", exact: true })).toHaveCount(0);
  await page.mouse.move(20, 110);
  const baseline = await settledHomeResources(page), snapshots: WorldResourceSnapshot[] = [baseline];
  expect(baseline.worldContexts).toBe(1); expect(baseline.contextId).not.toBeNull();
  expect(baseline.worldCanvasCount).toBe(1); expect(baseline.live.texture).toBeGreaterThan(0);
  const firstFrame = Number(await scene.getAttribute("data-world-frames"));
  for (let index = 0; index < 30; index++) {
    await page.locator('button[data-page="library"]').click(); await expect(page.locator(".vx-library-page")).toBeVisible();
    await page.locator('button[data-page="home"]').click(); await expect(page.locator(".vx-home")).toBeVisible();
    if ((index + 1) % 10 === 0) snapshots.push(await snapshotWorldResources(page));
  }
  await openAppearance(page);
  for (let index = 0; index < 10; index++) {
    const material = index % 2 === 0 ? "solid" : "lattice", setting = index % 2 === 0 ? "massif" : "horizon";
    await selectValue(page, "世界场景", setting); await selectValue(page, "世界材质", material);
    await expect(scene).toHaveAttribute("data-world-material", material, { timeout: 15_000 });
    snapshots.push(await snapshotWorldResources(page));
  }
  await page.locator('button[data-page="home"]').click(); await expect(page.locator(".vx-home")).toBeVisible();
  await expect(scene).toHaveAttribute("data-world-material", "lattice");
  await expect.poll(async () => Number(await scene.getAttribute("data-world-frames"))).toBeGreaterThan(firstFrame);
  const returnedFrame = Number(await scene.getAttribute("data-world-frames"));
  await expect.poll(async () => Number(await scene.getAttribute("data-world-frames"))).toBeGreaterThan(returnedFrame);
  const final = await settledHomeResources(page); snapshots.push(final);
  await writeFile(resolve(directory, "gpu-resources.json"), JSON.stringify({ baseline, final, snapshots, errors }, null, 2));
  expect(await canvas.evaluate((node, previous) => node === previous, originalCanvas)).toBe(true);
  for (const snapshot of snapshots) {
    expect(snapshot.worldCanvasCount).toBe(1); expect(snapshot.worldContexts).toBe(1); expect(snapshot.contextId).toBe(baseline.contextId);
    expect(snapshot.duplicateDeletes).toBe(0); expect(snapshot.glErrors).toEqual([]); expect(snapshot.live.query).toBeLessThanOrEqual(4);
  }
  for (const kind of Object.keys(baseline.live).filter(kind => kind !== "query"))
    expect(final.live[kind], `${kind}: live allocation count must return to the lattice baseline`).toBe(baseline.live[kind]);
  // Compare the same home state by target, event type and capture mode. This is
  // the declared persistent-listener scope; once/signal registrations are reported
  // separately rather than being misrepresented as lifecycle-complete coverage.
  expect(final.listenerScope).toBe(baseline.listenerScope);
  for (const key of new Set([...Object.keys(baseline.persistentListeners), ...Object.keys(final.persistentListeners)]))
    expect(final.persistentListeners[key] ?? 0, `${key}: persistent listeners must return to the home baseline`)
      .toBe(baseline.persistentListeners[key] ?? 0);
  expect(errors).toEqual([]);
});
