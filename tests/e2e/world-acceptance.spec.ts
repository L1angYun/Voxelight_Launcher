// SPDX-License-Identifier: GPL-3.0-only
import { expect, test, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { installLauncherFixture } from "./fixtures";
import { selectValue } from "./select-helpers";
import { captureTextContrast, type ContrastTarget, type WorldContrastReport } from "./helpers/world-contrast-probe";
import { prepareIntroContrast } from "./helpers/world-intro-compositor";
import { installWorldResourceProbe, snapshotWorldResources, type WorldResourceSnapshot } from "./helpers/world-resource-probe";

const evidence = resolve(process.env.VOXELIGHT_TASK8_EVIDENCE ?? "test-results/world-acceptance");
const targets: ContrastTarget[] = [
  { name: "title", selector: ".vx-home__console-name", minimum: 3, nominalDuringIntro: true },
  { name: "metadata", selector: ".vx-home__meta li", minimum: 4.5, nominalDuringIntro: true },
  { name: "preview source", selector: ".vx-home__preview-source", minimum: 4.5 },
  { name: "operation", selector: ".vx-launch-console__actions .vx-button__label, .vx-launch-console__running .vx-button__label", minimum: 4.5 },
  { name: "preparation", selector: ".vx-launch-console__progress-heading > span, .vx-launch-console__file-count", minimum: 4.5, optional: true },
  { name: "progress value", selector: ".vx-launch-console__progress-text", minimum: 4.5, optional: true },
  { name: "running", selector: ".vx-launch-console__running > span", minimum: 4.5, optional: true },
];

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

async function captureState(page: Page, directory: string, state: string, recorded?: WorldContrastReport): Promise<WorldContrastReport> {
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
  const report = recorded ?? await captureTextContrast(page, targets, resolve(directory, `${state}-under-text.png`));
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
    // preview source and the actual launch label remain visible and are also tested.
    await expect(page.locator("html")).toHaveAttribute("data-world-intro", "off", { timeout: 3500 });
    await expect(page.locator(".vx-home__identity")).toHaveCSS("opacity", "1");
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const reports: Record<string, WorldContrastReport> = { intro };
    reports.idle = await captureState(page, directory, "idle");
    await page.screenshot({ path: resolve(directory, "idle-visible.png"), scale: "css" });

    const scene = page.locator(".vx-global-scene");
    await page.getByRole("button", { name: "启动游戏", exact: true }).click();
    await expect(scene).toHaveAttribute("data-world-phase", "preparing");
    await expect(page.getByText("37%", { exact: true })).toBeVisible();
    await expect.poll(async () => Number(await scene.getAttribute("data-world-front")), { timeout: 30_000 }).toBe(61);
    reports["front-37"] = await captureState(page, directory, "front-37");
    expect(Number(reports["front-37"].before.front)).toBe(61);
    for (const [fraction, percent, low, high] of [[.7, "70%", 115, 116], [.95, "95%", 157, 157]] as const) {
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
      return Number(await scene.getAttribute("data-world-frames")) - before;
    }, { timeout: 15_000 }).toBe(0);
    reports["running-settled"] = await captureState(page, directory, "running-settled");
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
