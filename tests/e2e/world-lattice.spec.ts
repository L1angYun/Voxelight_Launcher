// SPDX-License-Identifier: GPL-3.0-only
import { expect, test, type Page } from "@playwright/test";
import { installLauncherFixture } from "./fixtures";
import { changedPixels, withWorldView, worldStructure } from "./helpers/world-image";
import { selectValue } from "./select-helpers";
import { writeFile } from "node:fs/promises";
import { decodePng } from "./helpers/glass-pixel-probe.mjs";

test.use({ viewport: { width: 1280, height: 720 } });

type IntroProbe = {
  events: { state: string; at: number; page: string | null }[];
  firstInteractive: { launch: { visible: boolean; enabled: boolean; hit: boolean }; navigation: { visible: boolean; enabled: boolean; hit: boolean }[]; titleOpacity: string } | null;
  presses: { state: string | undefined; page: string | null; launch: boolean }[];
  gpu: { active: number; at: number }[];
  captureClocks: { phaseTime: string; wallAt: string; rafTimestamp: string; callbackStartedAt: string };
  drawFrames: { contextId: number; active: number | null; toWord: number | null; phaseTime: number | null; wallAt: number;
    intro: string | null; rafTimestamp: number | null; callbackStartedAt: number | null }[];
  phaseCompleteness: { total: number; complete: number; missingActive: number; missingToWord: number; missingPhaseTime: number };
  collectionTiming?: {
    clockNote: string;
    readinessWaitNodeStart: { performanceNow: number; epochMs: number };
    firstActiveDraw?: IntroProbe["drawFrames"][number]; readyObservedAt?: number;
    collectorWaitNodeStart?: { performanceNow: number; epochMs: number }; collectorFirstEvaluatedAt?: number;
  };
  encodingErrors: string[];
  captures: { source: "gpu-default-framebuffer"; active: number; toWord: number; phaseTime: number; wallAt: number; intro: string | undefined; url: string | null;
    snapshotRequestedAt?: number; snapshotReturnedAt?: number; readbackMethod?: "pixel-pack-buffer";
    readbackWidth?: number; readbackHeight?: number; readbackByteLength?: number; readbackPolls?: number;
    readbackReadyAt?: number; readbackCopiedAt?: number; pngEncodingStartedAt?: number; blobReadyAt?: number; encodedAt?: number; encodingError?: string }[];
};

async function observeWorldIntro(page: Page, captureFrames = false) {
  await page.addInitScript((captureFrames: boolean) => {
    const probe: IntroProbe = { events: [], firstInteractive: null, presses: [], gpu: [], captures: [], encodingErrors: [], drawFrames: [],
      phaseCompleteness: { total: 0, complete: 0, missingActive: 0, missingToWord: 0, missingPhaseTime: 0 }, captureClocks: {
      phaseTime: "uIntroTime uniform, seconds since the current gather/return stage began; uToWord=1 selects gather",
      wallAt: "performance.now() milliseconds after the real default-framebuffer draw, before PIXEL_PACK_BUFFER submission; fence polling and PNG completion are asynchronous",
      rafTimestamp: "The browser-provided requestAnimationFrame timestamp of the currently executing callback; null for draws outside a RAF callback",
      callbackStartedAt: "performance.now() milliseconds at entry to that actual RAF callback; the callback timestamp and scheduling are unchanged",
    } };
    (window as unknown as { __worldIntroProbe: IntroProbe }).__worldIntroProbe = probe;
    const operable = (element: HTMLButtonElement) => {
      const box = element.getBoundingClientRect();
      return { visible: box.width > 0 && box.height > 0 && element.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
        enabled: !element.disabled, hit: element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)) };
    };
    const sample = () => {
      const root = document.documentElement;
      if (!root) return;
      const state = root.dataset.worldIntro;
      if (state !== "on" && state !== "off") return;
      if (probe.events.at(-1)?.state !== state) probe.events.push({ state, at: performance.now(), page: document.querySelector<HTMLElement>(".vx-app-body")?.dataset.currentPage ?? null });
      const launch = document.querySelector<HTMLButtonElement>("button[data-launch-primary]");
      const navigation = [...document.querySelectorAll<HTMLButtonElement>("nav button[data-page]")];
      if (state === "on" && !probe.firstInteractive && launch && navigation.length) {
        probe.firstInteractive = { launch: operable(launch), navigation: navigation.map(operable),
          titleOpacity: getComputedStyle(document.querySelector(".vx-home__identity")!).opacity };
      }
    };
    new MutationObserver(sample).observe(document, { attributes: true, attributeFilter: ["data-world-intro", "data-current-page"], childList: true, subtree: true });
    document.addEventListener("pointerdown", event => {
      const target = event.target instanceof Element ? event.target : null;
      probe.presses.push({ state: document.documentElement?.dataset.worldIntro, page: target?.closest<HTMLButtonElement>("button[data-page]")?.dataset.page ?? null,
        launch: Boolean(target?.closest("button[data-launch-primary]")) });
    }, true);
    const collectPng = (canvas: HTMLCanvasElement, capture: IntroProbe["captures"][number], finished: () => void, gl: WebGL2RenderingContext) => {
      let settled = false, buffer: WebGLBuffer | null = null, sync: WebGLSync | null = null;
      let pollTimer: ReturnType<typeof setTimeout> | null = null;
      const cleanup = () => {
        if (pollTimer !== null) { clearTimeout(pollTimer); pollTimer = null; }
        const errors: string[] = [];
        if (sync !== null) {
          const owned = sync; sync = null;
          try { gl.deleteSync(owned); } catch (error) { errors.push(String(error)); }
        }
        if (buffer !== null) {
          const owned = buffer; buffer = null;
          try { gl.deleteBuffer(owned); } catch (error) { errors.push(String(error)); }
        }
        if (errors.length) throw new Error(`Readback cleanup failed: ${errors.join("; ")}`);
      };
      const fail = (reason: string) => {
        if (settled) return;
        settled = true;
        try { cleanup(); } catch (error) { reason += `; ${String(error)}`; }
        capture.encodedAt = performance.now();
        capture.encodingError = `Intro PNG encoding failed (active=${capture.active}, phaseTime=${capture.phaseTime}): ${reason}`;
        probe.encodingErrors.push(capture.encodingError);
        finished();
      };
      const checkError = (stage: string) => {
        const error = gl.getError();
        if (error !== gl.NO_ERROR) throw new Error(`WebGL error 0x${error.toString(16)} after ${stage}`);
      };
      const encode = async (bytes: Uint8Array, width: number, height: number) => {
        const stride = width * 4, pixels = new Uint8ClampedArray(bytes.length);
        for (let row = 0; row < height; row++)
          pixels.set(bytes.subarray((height - row - 1) * stride, (height - row) * stride), row * stride);
        const output = new OffscreenCanvas(width, height), context = output.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("OffscreenCanvas 2D context is unavailable");
        context.putImageData(new ImageData(pixels, width, height), 0, 0);
        capture.pngEncodingStartedAt = performance.now();
        const blob = await output.convertToBlob({ type: "image/png" });
        capture.blobReadyAt = performance.now();
        if (blob.type !== "image/png" || blob.size === 0) throw new Error("OffscreenCanvas did not return a nonempty PNG");
        const reader = new FileReader();
        reader.onerror = () => fail(reader.error?.message ?? "FileReader failed");
        reader.onabort = () => fail("FileReader aborted");
        reader.onload = () => {
          if (settled) return;
          if (typeof reader.result !== "string" || !reader.result.startsWith("data:image/png;base64,")) { fail("FileReader did not return a PNG data URL"); return; }
          settled = true; capture.url = reader.result; capture.encodedAt = performance.now(); finished();
        };
        reader.readAsDataURL(blob);
      };
      try {
        capture.snapshotRequestedAt = performance.now();
        const width = canvas.width, height = canvas.height, byteLength = width * height * 4;
        if (width <= 0 || height <= 0 || width !== gl.drawingBufferWidth || height !== gl.drawingBufferHeight)
          throw new Error("Canvas and WebGL drawing-buffer dimensions must match and be nonzero");
        if (gl.isContextLost()) throw new Error("WebGL context was lost before readback");
        capture.readbackMethod = "pixel-pack-buffer";
        capture.readbackWidth = width; capture.readbackHeight = height; capture.readbackByteLength = byteLength;
        const previousBuffer = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING) as WebGLBuffer | null;
        const previousRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
        const packNames = [gl.PACK_ALIGNMENT, gl.PACK_ROW_LENGTH, gl.PACK_SKIP_PIXELS, gl.PACK_SKIP_ROWS];
        const previousPack = packNames.map(name => gl.getParameter(name) as number);
        let defaultReadBuffer: number | undefined;
        buffer = gl.createBuffer();
        if (!buffer) throw new Error("Pixel-pack buffer allocation returned null");
        try {
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
          defaultReadBuffer = gl.getParameter(gl.READ_BUFFER) as number;
          gl.readBuffer(gl.BACK);
          gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
          gl.pixelStorei(gl.PACK_ROW_LENGTH, 0); gl.pixelStorei(gl.PACK_SKIP_PIXELS, 0); gl.pixelStorei(gl.PACK_SKIP_ROWS, 0);
          gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
          gl.bufferData(gl.PIXEL_PACK_BUFFER, byteLength, gl.STREAM_READ);
          // The offset overload snapshots this actual draw in the GL command stream.
          gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, 0);
          checkError("readPixels");
          sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
          if (!sync) throw new Error("Readback fenceSync returned null");
          gl.flush();
        } finally {
          packNames.forEach((name, index) => gl.pixelStorei(name, previousPack[index]));
          gl.bindBuffer(gl.PIXEL_PACK_BUFFER, previousBuffer);
          if (defaultReadBuffer !== undefined) gl.readBuffer(defaultReadBuffer);
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER, previousRead);
        }
        capture.snapshotReturnedAt = performance.now();
        const poll = () => {
          pollTimer = null;
          if (settled) return;
          try {
            if (gl.isContextLost()) throw new Error("WebGL context was lost during readback");
            capture.readbackPolls = (capture.readbackPolls ?? 0) + 1;
            const status = gl.clientWaitSync(sync!, 0, 0);
            if (status === gl.TIMEOUT_EXPIRED) { pollTimer = setTimeout(poll, 0); return; }
            if (status !== gl.ALREADY_SIGNALED && status !== gl.CONDITION_SATISFIED)
              throw new Error(`Readback fence wait failed with status 0x${status.toString(16)}`);
            capture.readbackReadyAt = performance.now();
            const bytes = new Uint8Array(byteLength);
            const currentBuffer = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING) as WebGLBuffer | null;
            try {
              gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
              gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, bytes);
              checkError("getBufferSubData");
            } finally { gl.bindBuffer(gl.PIXEL_PACK_BUFFER, currentBuffer); }
            capture.readbackCopiedAt = performance.now();
            cleanup();
            void encode(bytes, width, height).catch(error => fail(String(error)));
          } catch (error) { fail(String(error)); }
        };
        pollTimer = setTimeout(poll, 0);
      } catch (error) { fail(String(error)); }
    };
    let executingRaf: { timestamp: number; callbackStartedAt: number } | null = null;
    if (captureFrames) {
      const originalRaf = window.requestAnimationFrame;
      window.requestAnimationFrame = function (this: Window, callback: FrameRequestCallback) {
        if (typeof callback !== "function") return originalRaf.call(this, callback);
        return originalRaf.call(this, function (this: Window, timestamp: number) {
          const callbackStartedAt = performance.now();
          const previous = executingRaf;
          executingRaf = { timestamp, callbackStartedAt };
          try { callback.call(this, timestamp); } finally { executingRaf = previous; }
        });
      };
    }
    if (typeof WebGL2RenderingContext !== "undefined") {
      const names = new WeakMap<WebGLUniformLocation, string>();
      const phases = new WeakMap<WebGL2RenderingContext, { active?: number; time?: number; toWord?: number }>();
      const contextIds = new WeakMap<WebGL2RenderingContext, number>();
      let nextContextId = 0;
      const pending = new Set<number>();
      const originalLocation = WebGL2RenderingContext.prototype.getUniformLocation;
      const originalScalar = WebGL2RenderingContext.prototype.uniform1f;
      const originalDraw = WebGL2RenderingContext.prototype.drawArrays;
      WebGL2RenderingContext.prototype.getUniformLocation = function (program, name) {
        const location = originalLocation.call(this, program, name);
        if (location) names.set(location, name);
        return location;
      };
      WebGL2RenderingContext.prototype.uniform1f = function (location, value) {
        if (location && (this.canvas as HTMLCanvasElement).classList.contains("world-scene__canvas")) {
          const name = names.get(location);
          const phase = phases.get(this) ?? {};
          if (name === "uIntroActive") {
            phase.active = value;
            if (probe.gpu.at(-1)?.active !== value) probe.gpu.push({ active: value, at: performance.now() });
          } else if (name === "uIntroTime") phase.time = value;
          else if (name === "uToWord") phase.toWord = value;
          phases.set(this, phase);
        }
        return originalScalar.call(this, location, value);
      };
      if (captureFrames) WebGL2RenderingContext.prototype.drawArrays = function (mode, first, count) {
        const result = originalDraw.call(this, mode, first, count);
        const canvas = this.canvas as HTMLCanvasElement;
        if (!canvas.classList.contains("world-scene__canvas") || this.getParameter(this.FRAMEBUFFER_BINDING) !== null) return result;
        const phase = phases.get(this), active = phase?.active, phaseTime = phase?.time, toWord = phase?.toWord;
        const intro = document.documentElement?.dataset.worldIntro;
        const now = performance.now();
        let contextId = contextIds.get(this);
        if (contextId === undefined) { contextId = ++nextContextId; contextIds.set(this, contextId); }
        probe.drawFrames.push({ contextId, active: active ?? null, toWord: toWord ?? null, phaseTime: phaseTime ?? null, wallAt: now,
          intro: intro ?? null, rafTimestamp: executingRaf?.timestamp ?? null, callbackStartedAt: executingRaf?.callbackStartedAt ?? null });
        const hasActive = Number.isFinite(active), hasToWord = Number.isFinite(toWord), hasPhaseTime = Number.isFinite(phaseTime);
        probe.phaseCompleteness.total++;
        if (hasActive && hasToWord && hasPhaseTime) probe.phaseCompleteness.complete++;
        if (!hasActive) probe.phaseCompleteness.missingActive++;
        if (!hasToWord) probe.phaseCompleteness.missingToWord++;
        if (!hasPhaseTime) probe.phaseCompleteness.missingPhaseTime++;
        const forming = active === 1 && toWord === 1 && phaseTime !== undefined && phaseTime >= .8 && phaseTime < 1.4 && intro === "on";
        const ended = active === 0 && intro === "off" && probe.captures.some(capture => capture.active === 1);
        if ((forming || ended) && !pending.has(active!) && !probe.captures.some(capture => capture.active === active)) {
          sample();
          pending.add(active!);
          const capture: IntroProbe["captures"][number] = { source: "gpu-default-framebuffer", active: active!, toWord: toWord!, phaseTime: phaseTime!, wallAt: now, intro, url: null };
          probe.captures.push(capture);
          collectPng(canvas, capture, () => pending.delete(active!), this);
        }
        return result;
      };
    }
    sample();
  }, captureFrames);
}

const introProbe = (page: Page) => page.evaluate(() => (window as unknown as { __worldIntroProbe: IntroProbe }).__worldIntroProbe);
const introReport = (probe: IntroProbe) => ({ ...probe, captures: probe.captures.map(({ url: _url, ...capture }) => capture) });
async function pressDuringIntro(page: Page, selector: string) {
  const handle = await page.waitForFunction(selector => {
    const control = document.querySelector<HTMLButtonElement>(selector);
    if (document.documentElement?.dataset.worldIntro !== "on" || !control || control.disabled || !control.checkVisibility({ opacityProperty: true })) return null;
    const box = control.getBoundingClientRect();
    return box.width > 0 && box.height > 0 ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
  }, selector, { timeout: 3000 });
  const point = await handle.jsonValue();
  expect(point).not.toBeNull();
  await page.mouse.move(point!.x, point!.y);
  await page.mouse.down();
}
const runtimeErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const errors: string[] = [];
  runtimeErrors.set(page, errors);
  page.on("pageerror", error => errors.push(error.message));
});
test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  const snapshot = await page.evaluate(() => {
    const probe = (window as unknown as { __worldIntroProbe?: IntroProbe }).__worldIntroProbe;
    return { probe: probe && { ...probe, captures: probe.captures.map(({ url: _url, ...capture }) => capture) },
      html: { ...document.documentElement.dataset }, scene: { ...document.querySelector<HTMLElement>(".vx-global-scene")?.dataset } };
  });
  const report = { ...snapshot, errors: runtimeErrors.get(page) };
  await writeFile(testInfo.outputPath("failure-runtime.json"), JSON.stringify(report, null, 2));
  console.log("Failure runtime:", JSON.stringify(report));
});

test("world intro: plays once on home, keeps first-frame operations usable, and ends within three seconds", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await installLauncherFixture(page);
  await observeWorldIntro(page, true);
  await page.goto("/", { waitUntil: "commit" });
  const scene = page.locator(".vx-global-scene");
  // Cold module/configuration readiness has its own finite wait. The PNG budget
  // stays anchored to the first actual active default-framebuffer submission.
  const readinessWaitNodeStart = { performanceNow: performance.now(), epochMs: Date.now() };
  await page.waitForFunction(nodeStart => {
    const probe = (window as unknown as { __worldIntroProbe?: IntroProbe }).__worldIntroProbe;
    if (!probe) return false;
    probe.collectionTiming ??= {
      clockNote: "Node performanceNow is process-relative; epochMs is the Node wall clock. readyObservedAt, collectorFirstEvaluatedAt and draw/capture timestamps use the page performance.now() clock; their values are never rewritten.",
      readinessWaitNodeStart: nodeStart,
    };
    const firstActiveDraw = probe.drawFrames.find(draw => draw.active === 1);
    if (!firstActiveDraw || !probe.firstInteractive) return false;
    probe.collectionTiming.firstActiveDraw ??= firstActiveDraw;
    probe.collectionTiming.readyObservedAt ??= performance.now();
    return true;
  }, readinessWaitNodeStart, { timeout: 5000 });
  // The real default-framebuffer hook captures inside the finite entrance frame.
  const collectorWaitNodeStart = { performanceNow: performance.now(), epochMs: Date.now() };
  await page.waitForFunction(nodeStart => {
    const probe = (window as unknown as { __worldIntroProbe?: IntroProbe }).__worldIntroProbe;
    if (probe?.collectionTiming) {
      probe.collectionTiming.collectorWaitNodeStart ??= nodeStart;
      probe.collectionTiming.collectorFirstEvaluatedAt ??= performance.now();
    }
    const scene = document.querySelector<HTMLElement>(".vx-global-scene");
    if (probe?.encodingErrors.length) throw new Error(probe.encodingErrors.join("; "));
    return probe?.captures.some(capture => capture.active === 1 && capture.url !== null) && probe.captures.some(capture => capture.active === 0 && capture.url !== null) &&
      document.documentElement.dataset.worldIntro === "off" && scene?.dataset.worldTier === "animated" && scene?.dataset.worldMaterial === "lattice";
  }, collectorWaitNodeStart, { timeout: 5000 });
  const initial = await introProbe(page);
  const forming = initial.captures.find(capture => capture.active === 1)!;
  const finished = initial.captures.find(capture => capture.active === 0)!;
  const firstActiveDraw = initial.collectionTiming!.firstActiveDraw!;
  expect(forming.encodedAt! - firstActiveDraw.wallAt).toBeLessThanOrEqual(5000);
  expect(finished.encodedAt! - firstActiveDraw.wallAt).toBeLessThanOrEqual(5000);
  expect(forming.intro).toBe("on");
  expect(finished.intro).toBe("off");
  expect(forming.toWord).toBe(1);
  expect(forming.phaseTime).toBeGreaterThanOrEqual(.8);
  expect(forming.phaseTime).toBeLessThan(1.4);
  expect(initial.encodingErrors).toEqual([]);
  const duringBytes = Buffer.from(forming.url!.split(",")[1], "base64");
  const finishedBytes = Buffer.from(finished.url!.split(",")[1], "base64");
  await writeFile(testInfo.outputPath("intro-forming-real-world.png"), duringBytes);
  await writeFile(testInfo.outputPath("intro-finished-real-world.png"), finishedBytes);
  const during = decodePng(duringBytes), settled = decodePng(finishedBytes);
  expect(worldStructure(during).range).toBeGreaterThanOrEqual(16);
  expect(worldStructure(during).edges).toBeGreaterThan(100);
  await expect(page.locator("html")).toHaveAttribute("data-world-intro", "off", { timeout: 3000 });
  await expect.poll(async () => (await introProbe(page)).gpu.at(-1)?.active).toBe(0);
  expect(changedPixels(during, settled)).toBeGreaterThan(100);
  const compositor = await withWorldView(page, capture => capture(testInfo.outputPath("intro-finished-compositor-world.png")));
  expect(worldStructure(compositor).range).toBeGreaterThanOrEqual(16);
  expect(worldStructure(compositor).edges).toBeGreaterThan(100);
  const on = initial.events.find(event => event.state === "on")!;
  const off = initial.events.find(event => event.state === "off" && event.at >= on.at)!;
  expect(on.page).toBe("home");
  expect(off.at - on.at).toBeGreaterThan(0);
  expect(off.at - on.at).toBeLessThanOrEqual(3000);
  expect(initial.firstInteractive).not.toBeNull();
  expect(initial.firstInteractive!.launch).toEqual({ visible: true, enabled: true, hit: true });
  expect(initial.firstInteractive!.navigation.length).toBeGreaterThanOrEqual(7);
  for (const control of initial.firstInteractive!.navigation) expect(control).toEqual({ visible: true, enabled: true, hit: true });
  expect(initial.firstInteractive!.titleOpacity).toBe("0");
  await expect(page.locator(".vx-home__identity")).toHaveCSS("opacity", "1");
  for (let index = 0; index < 2; index++) {
    await page.locator('button[data-page="library"]').click();
    await page.locator('button[data-page="home"]').click();
    await expect(page.locator("html")).toHaveAttribute("data-world-intro", "off");
  }
  const final = await introProbe(page);
  expect(final.events.filter(event => event.state === "on")).toHaveLength(1);
  expect(runtimeErrors.get(page)).toEqual([]);
  await writeFile(testInfo.outputPath("intro-lifecycle.json"), JSON.stringify(introReport(final), null, 2));
  await page.screenshot({ path: testInfo.outputPath("intro-finished-no-replay.png") });
});

test("world intro: the first launch press skips the intro and keeps the real launch action", async ({ page }, testInfo) => {
  await installLauncherFixture(page, { launchDelay: 10_000 });
  await makeFixtureLaunchCancellable(page);
  await observeWorldIntro(page);
  await page.goto("/", { waitUntil: "commit" });
  await pressDuringIntro(page, "button[data-launch-primary]");
  await expect(page.locator("html")).toHaveAttribute("data-world-intro", "off", { timeout: 1000 });
  await expect(page.locator(".vx-global-scene")).toHaveAttribute("data-world-phase", "idle");
  await page.mouse.up();
  await expect(page.locator(".vx-launch-console__progress-text")).toHaveText("37%");
  await expect(page.locator(".vx-global-scene")).toHaveAttribute("data-world-phase", "preparing");
  expect((await introProbe(page)).presses.some(press => press.launch && press.state === "on")).toBe(true);
  await page.getByRole("button", { name: "取消准备", exact: true }).click();
  await expect(page.locator(".vx-global-scene")).toHaveAttribute("data-world-phase", "idle");
  await page.locator('button[data-page="library"]').click();
  await page.locator('button[data-page="home"]').click();
  await expect(page.locator("html")).toHaveAttribute("data-world-intro", "off");
  const probe = await introProbe(page);
  expect(probe.events.filter(event => event.state === "on")).toHaveLength(1);
  expect(runtimeErrors.get(page)).toEqual([]);
  await writeFile(testInfo.outputPath("intro-launch-skip.json"), JSON.stringify(introReport(probe), null, 2));
});

test("world intro: a first navigation press skips without blocking navigation or replaying on return", async ({ page }, testInfo) => {
  await installLauncherFixture(page);
  await observeWorldIntro(page);
  await page.goto("/", { waitUntil: "commit" });
  await pressDuringIntro(page, 'button[data-page="library"]');
  await expect(page.locator("html")).toHaveAttribute("data-world-intro", "off", { timeout: 1000 });
  await expect(page.locator(".vx-app-body")).toHaveAttribute("data-current-page", "home");
  await page.mouse.up();
  await expect(page.locator(".vx-library-page")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-world-intro", "off", { timeout: 1000 });
  expect((await introProbe(page)).presses.some(press => press.page === "library" && press.state === "on")).toBe(true);
  await page.locator('button[data-page="home"]').click();
  await expect(page.locator("html")).toHaveAttribute("data-world-intro", "off");
  const probe = await introProbe(page);
  expect(probe.events.filter(event => event.state === "on")).toHaveLength(1);
  expect(runtimeErrors.get(page)).toEqual([]);
  await writeFile(testInfo.outputPath("intro-navigation-skip.json"), JSON.stringify(introReport(probe), null, 2));
});

async function openAppearance(page: Page) {
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "设置", exact: true }).click();
  await page.locator(".vx-settings-nav").getByRole("button", { name: "外观", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "世界材质", exact: true })).toBeVisible();
}

async function makeFixtureLaunchCancellable(page: Page) {
  await page.addInitScript(() => {
    const api = (window as unknown as {
      __TAURI_INTERNALS__: { invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown> };
    }).__TAURI_INTERNALS__;
    const original = api.invoke;
    let generation = 0;
    let cancel: (() => void) | null = null;
    api.invoke = async (name, args) => {
      if (name === "cancel_download_task") {
        generation++;
        cancel?.();
      }
      if (name !== "launch_game") return original(name, args);
      const token = ++generation;
      const cancelled = new Promise<never>((_, reject) => {
        cancel = () => reject(new Error("任务已取消，已校验文件保留供下次复用"));
      });
      try {
        const result = await Promise.race([original(name, args), cancelled]);
        if (token !== generation) throw new Error("任务已取消，已校验文件保留供下次复用");
        return result;
      } finally {
        cancel = null;
      }
    };
  });
}

test("default lattice renders real animated terrain and continues through pointer movement", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await installLauncherFixture(page);
  await page.goto("/");
  const scene = page.locator(".vx-global-scene");
  await expect(scene.locator(".world-scene__canvas")).toBeVisible();
  await expect(scene).toHaveAttribute("data-world-material", "lattice");
  await expect(scene).toHaveAttribute("data-world-tier", "animated");
  await expect.poll(async () => Number(await scene.getAttribute("data-world-frames"))).toBeGreaterThan(0);
  await withWorldView(page, async capture => {
    const before = await capture(testInfo.outputPath("lattice-before.png"));
    const structure = worldStructure(before);
    expect(structure.range).toBeGreaterThanOrEqual(16);
    expect(structure.edges).toBeGreaterThan(100);
    const frames = Number(await scene.getAttribute("data-world-frames"));
    for (let x = 620; x <= 1040; x += 35) await page.mouse.move(x, 650 + Math.sin(x / 50) * 50);
    await page.waitForTimeout(900);
    const after = await capture(testInfo.outputPath("lattice-after.png"));
    expect(Number(await scene.getAttribute("data-world-frames"))).toBeGreaterThan(frames);
    expect(changedPixels(before, after)).toBeGreaterThan(100);
  });
  await expect(page.getByRole("button", { name: "启动游戏", exact: true })).toBeEnabled();
  expect(errors).toEqual([]);
});

test("no float targets uses solid while preserving the requested lattice preference and localized explanation", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await installLauncherFixture(page);
  await page.addInitScript(() => {
    const getExtension = WebGL2RenderingContext.prototype.getExtension as (this: WebGL2RenderingContext, name: string) => unknown;
    WebGL2RenderingContext.prototype.getExtension = function (this: WebGL2RenderingContext, name: string) {
      return name === "EXT_color_buffer_float" ? null : getExtension.call(this, name);
    } as typeof WebGL2RenderingContext.prototype.getExtension;
  });
  await page.goto("/");
  const scene = page.locator(".vx-global-scene");
  await expect(scene).toHaveAttribute("data-world-material", "solid");
  await expect(scene).toHaveAttribute("data-world-tier", "animated");
  await openAppearance(page);
  await expect(page.getByRole("combobox", { name: "世界材质", exact: true })).toContainText("点阵");
  const chineseExplanation = page.getByRole("status").filter({ hasText: "当前设备无法使用浮点粒子渲染" });
  await expect(chineseExplanation).toBeVisible();
  await expect(chineseExplanation).toContainText("已暂用实体材质");
  await expect(chineseExplanation).toContainText("点阵选择仍会保留");
  await selectValue(page, "界面语言", "en-US");
  const englishExplanation = page.getByRole("status").filter({ hasText: "Floating-point particle rendering is unavailable on this device." });
  await expect(englishExplanation).toBeVisible();
  await expect(englishExplanation).toContainText("Solid is used temporarily");
  await expect(englishExplanation).toContainText("your Lattice preference is preserved");
  await expect(page.getByRole("combobox", { name: "World material", exact: true })).toContainText("Lattice");
  await page.getByRole("button", { name: "Save settings", exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    const fixture = (window as unknown as {
      __appearanceFixtures: { calls: { name: string; args?: { config?: { worldMaterial?: string; language?: string } } }[] };
    }).__appearanceFixtures;
    return fixture.calls.filter(call => call.name === "save_config").at(-1)?.args?.config;
  })).toMatchObject({ worldMaterial: "lattice", language: "en-US" });
  await expect(page.getByRole("button", { name: "Save settings", exact: true })).toBeDisabled();
  await expect(scene).toHaveAttribute("data-world-material", "solid");
  expect(errors).toEqual([]);
});

test("appearance switches world material and scene without replacing its canvas or WebGL context", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await installLauncherFixture(page);
  await page.goto("/");
  const scene = page.locator(".vx-global-scene");
  const canvas = scene.locator(".world-scene__canvas");
  await expect(scene).toHaveAttribute("data-world-material", "lattice");
  const originalCanvas = await canvas.elementHandle();
  const originalContext = await canvas.evaluateHandle(node => (node as HTMLCanvasElement).getContext("webgl2"));
  expect(await originalContext.evaluate(context => context !== null)).toBe(true);
  await openAppearance(page);
  await page.getByRole("checkbox", { name: "声音效果", exact: true }).check();
  const before = await withWorldView(page, capture => capture(testInfo.outputPath("settings-lattice-horizon.png")));
  const frames = Number(await scene.getAttribute("data-world-frames"));
  await selectValue(page, "世界材质", "solid");
  await expect(scene).toHaveAttribute("data-world-material", "solid");
  await selectValue(page, "世界场景", "massif");
  await expect(page.getByRole("combobox", { name: "世界场景", exact: true })).toContainText("山体");
  await expect(page.getByRole("checkbox", { name: "声音效果", exact: true })).toBeChecked();
  await expect(page.getByRole("heading", { name: "设置", exact: true })).toBeVisible();
  await page.waitForTimeout(1200);
  const after = await withWorldView(page, capture => capture(testInfo.outputPath("settings-solid-massif.png")));
  expect(changedPixels(before, after)).toBeGreaterThan(100);
  await expect.poll(async () => Number(await scene.getAttribute("data-world-frames"))).toBeGreaterThan(frames);
  expect(await canvas.evaluate((node, previous) => node === previous, originalCanvas)).toBe(true);
  expect(await canvas.evaluate((node, previous) => (node as HTMLCanvasElement).getContext("webgl2") === previous, originalContext)).toBe(true);
  expect(await originalContext.evaluate(context => context?.isContextLost())).toBe(false);
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    const fixture = (window as unknown as {
      __appearanceFixtures: { calls: { name: string; args?: { config?: Record<string, unknown> } }[] };
    }).__appearanceFixtures;
    return fixture.calls.filter(call => call.name === "save_config").at(-1)?.args?.config;
  })).toMatchObject({ worldMaterial: "solid", worldScene: "massif", soundEnabled: true });
  await expect(page.getByRole("button", { name: "保存设置", exact: true })).toBeDisabled();
  expect(errors).toEqual([]);
});

test("runtime accent changes keep real lattice pixels updating without a context restart", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await installLauncherFixture(page);
  await page.goto("/");
  const scene = page.locator(".vx-global-scene");
  const canvas = scene.locator(".world-scene__canvas");
  await expect(scene).toHaveAttribute("data-world-material", "lattice");
  const originalContext = await canvas.evaluateHandle(node => (node as HTMLCanvasElement).getContext("webgl2"));
  await withWorldView(page, async capture => {
    const before = await capture(testInfo.outputPath("accent-before.png"));
    const frames = Number(await scene.getAttribute("data-world-frames"));
    await page.evaluate(() => document.documentElement.style.setProperty("--accent", "#ff2b83"));
    for (let x = 540; x <= 1020; x += 40) await page.mouse.move(x, 580 + Math.sin(x / 60) * 40);
    await page.waitForTimeout(700);
    const after = await capture(testInfo.outputPath("accent-after.png"));
    expect(changedPixels(before, after)).toBeGreaterThan(100);
    expect(Number(await scene.getAttribute("data-world-frames"))).toBeGreaterThan(frames);
  });
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim())).toBe("#ff2b83");
  expect(await canvas.evaluate((node, previous) => (node as HTMLCanvasElement).getContext("webgl2") === previous, originalContext)).toBe(true);
  await expect(scene).toHaveAttribute("data-world-tier", "animated");
  expect(errors).toEqual([]);
});

test("holding and dragging the home title preserves native text selection", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await installLauncherFixture(page);
  await page.goto("/");
  const scene = page.locator(".vx-global-scene");
  await expect(scene).toHaveAttribute("data-world-material", "lattice");
  await expect(scene).toHaveCSS("pointer-events", "none");
  const title = page.locator(".vx-home__console-name");
  await expect(title).toHaveText("合成测试世界");
  const text = await title.innerText();
  const bounds = await title.evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const rect = range.getBoundingClientRect();
    return { left: rect.left, right: rect.right, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(bounds.left + 1, bounds.y);
  await page.mouse.down();
  await page.waitForTimeout(400);
  await page.mouse.move(bounds.right - 1, bounds.y, { steps: 16 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(text);
  await expect(page.getByRole("button", { name: "启动游戏", exact: true })).toBeEnabled();
  expect(errors).toEqual([]);
});

for (const mode of ["lite effects", "system reduced motion", "high contrast"] as const) {
  test(`${mode} keeps a real static world unchanged during pointer activity`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.emulateMedia({
      reducedMotion: mode === "system reduced motion" ? "reduce" : "no-preference",
      contrast: mode === "high contrast" ? "more" : "no-preference",
    });
    await installLauncherFixture(page, { effects: mode === "lite effects" ? "lite" : "full" });
    await observeWorldIntro(page);
    await page.goto("/");
    const scene = page.locator(".vx-global-scene");
    await expect(scene.locator(".world-scene__canvas")).toBeVisible();
    await expect(scene).toHaveAttribute("data-world-tier", "static");
    await expect(page.locator("html")).toHaveAttribute("data-world-intro", "off");
    await expect(page.locator(".vx-home__console-name")).toHaveText("合成测试世界");
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await expect(page.locator("html")).toHaveAttribute("data-high-contrast", String(mode === "high contrast"));
    await expect.poll(async () => Number(await scene.getAttribute("data-world-frames"))).toBeGreaterThan(0);
    // Bootstrap, media policy, and the home anchor may each request an initial static redraw.
    await expect.poll(async () => {
      const frames = Number(await scene.getAttribute("data-world-frames"));
      await page.waitForTimeout(400);
      return Number(await scene.getAttribute("data-world-frames")) - frames;
    }).toBe(0);
    await withWorldView(page, async capture => {
      const before = await capture(testInfo.outputPath("static-before.png"));
      const structure = worldStructure(before);
      expect(structure.range).toBeGreaterThanOrEqual(16);
      expect(structure.edges).toBeGreaterThan(100);
      const frames = Number(await scene.getAttribute("data-world-frames"));
      await page.mouse.move(840, 610);
      await page.mouse.down();
      await page.waitForTimeout(400);
      await page.mouse.move(1020, 620, { steps: 4 });
      await page.mouse.up();
      const after = await capture(testInfo.outputPath("static-after.png"));
      expect(Number(await scene.getAttribute("data-world-frames"))).toBe(frames);
      expect(changedPixels(before, after, 0)).toBe(0);
    });
    expect((await introProbe(page)).events.filter(event => event.state === "on")).toHaveLength(0);
    expect(errors).toEqual([]);
  });
}

test("launch state: home preparation follows real 37% progress and cancellation restores idle", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await installLauncherFixture(page, { launchDelay: 10_000 });
  await makeFixtureLaunchCancellable(page);
  await page.goto("/");
  const scene = page.locator(".vx-global-scene");
  await expect(scene).toHaveAttribute("data-world-phase", "idle");
  await page.getByRole("button", { name: "启动游戏", exact: true }).click();
  await expect(page.getByText("37%", { exact: true })).toBeVisible();
  const progress = page.locator(".vx-launch-console__progress-text");
  await expect(progress).toHaveText("37%");
  const typography = await progress.evaluate(async element => {
    const style = getComputedStyle(element);
    const faces = await document.fonts.load(`${style.fontWeight} ${style.fontSize} "Doto"`, "37%");
    return { family: style.fontFamily, size: parseFloat(style.fontSize), loaded: faces.length, statuses: faces.map(face => face.status) };
  });
  expect(typography.family).toContain("Doto");
  expect(typography.size).toBeGreaterThanOrEqual(15);
  expect(typography.loaded).toBeGreaterThan(0);
  expect(typography.statuses.every(status => status === "loaded")).toBe(true);
  await expect(scene).toHaveAttribute("data-world-phase", "preparing");
  await expect.poll(async () => Number(await scene.getAttribute("data-world-front"))).toBeGreaterThan(0);
  await expect.poll(async () => Number(await scene.getAttribute("data-world-front")), { timeout: 8000 }).toBe(61);
  await page.getByRole("button", { name: "取消准备", exact: true }).click();
  await expect(scene).toHaveAttribute("data-world-phase", "idle", { timeout: 3000 });
  await expect(scene).toHaveAttribute("data-world-front", "0", { timeout: 3000 });
  await expect(page.getByRole("button", { name: "启动游戏", exact: true })).toBeEnabled();
  // The original fixture timer still resolves. Its stale success must not revive a cancelled launch.
  await page.waitForTimeout(10_100);
  await expect(scene).toHaveAttribute("data-world-phase", "idle");
  await expect(scene).toHaveAttribute("data-world-front", "0");
  await expect(page.getByRole("button", { name: "停止", exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("launch state: success fills the world, freezes its rendered frames, and Stop restores idle", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await installLauncherFixture(page, { launchDelay: 3000 });
  await page.goto("/");
  const scene = page.locator(".vx-global-scene");
  await expect(scene).toHaveAttribute("data-world-phase", "idle");
  await expect(scene).toHaveAttribute("data-world-front", "0");
  const idle = await withWorldView(page, capture => capture(testInfo.outputPath("launch-idle.png")));
  await page.getByRole("button", { name: "启动游戏", exact: true }).click();
  await expect(page.getByText("37%", { exact: true })).toBeVisible();
  await expect(scene).toHaveAttribute("data-world-phase", "preparing");
  await expect.poll(async () => Number(await scene.getAttribute("data-world-front"))).toBeGreaterThan(0);
  await expect(scene).toHaveAttribute("data-world-phase", "running");
  // The director unit test checks the 600 ms logical duration; this software-rendered E2E observes its completed result.
  await expect(scene).toHaveAttribute("data-world-front", "165");
  await expect(page.getByRole("button", { name: "停止", exact: true })).toBeEnabled();
  // Exclude the legacy 830 ms Overture pause from the settled-world observation.
  await page.waitForTimeout(1000);
  await expect(scene).toHaveAttribute("data-paused", "false");
  await expect.poll(async () => {
    const before = Number(await scene.getAttribute("data-world-frames"));
    await page.waitForTimeout(700);
    return Number(await scene.getAttribute("data-world-frames")) - before;
  }, { timeout: 15_000 }).toBe(0);
  await withWorldView(page, async capture => {
    const before = await capture(testInfo.outputPath("launch-running-frozen.png"));
    const frames = Number(await scene.getAttribute("data-world-frames"));
    await page.waitForTimeout(1000);
    const after = await capture(testInfo.outputPath("launch-running-still.png"));
    expect(Number(await scene.getAttribute("data-world-frames"))).toBe(frames);
    expect(changedPixels(before, after, 0)).toBe(0);
    expect(changedPixels(idle, before)).toBeGreaterThan(100);
  });
  const stoppedFrames = Number(await scene.getAttribute("data-world-frames"));
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await expect(scene).toHaveAttribute("data-world-phase", "idle");
  await expect(scene).toHaveAttribute("data-world-front", "0");
  await expect.poll(async () => Number(await scene.getAttribute("data-world-frames"))).toBeGreaterThan(stoppedFrames);
  await expect(page.getByRole("button", { name: "启动游戏", exact: true })).toBeEnabled();
  expect(errors).toEqual([]);
});

test("launch state: launching from the library drives the shared world across navigation", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await installLauncherFixture(page, { launchDelay: 5000 });
  await page.goto("/");
  const scene = page.locator(".vx-global-scene");
  const canvas = scene.locator(".world-scene__canvas");
  const originalCanvas = await canvas.elementHandle();
  await page.locator('button[data-page="library"]').click();
  await expect(page.locator(".vx-library-page")).toBeVisible();
  await page.locator('[data-instance-id="fixture-world"]').getByRole("button", { name: "启动游戏", exact: true }).click();
  await expect(page.locator(".vx-launch-status")).toContainText("37%");
  await expect(scene).toHaveAttribute("data-world-phase", "preparing");
  await expect.poll(async () => Number(await scene.getAttribute("data-world-front"))).toBeGreaterThan(0);
  await page.locator('button[data-page="downloads"]').click();
  await expect(page.locator(".vx-downloads-page")).toBeVisible();
  await expect(scene).toHaveAttribute("data-world-phase", "preparing");
  await expect(scene).toHaveAttribute("data-world-phase", "running", { timeout: 8000 });
  await expect(scene).toHaveAttribute("data-world-front", "165");
  await page.locator('button[data-page="home"]').click();
  await expect(page.getByRole("button", { name: "停止", exact: true })).toBeEnabled();
  await expect(scene).toHaveAttribute("data-world-phase", "running");
  expect(await canvas.evaluate((node, previous) => node === previous, originalCanvas)).toBe(true);
  expect(errors).toEqual([]);
});
