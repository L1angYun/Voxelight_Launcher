// SPDX-License-Identifier: GPL-3.0-only
import { chromium, expect, test, type CDPSession, type Page, type TestInfo } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { installLauncherFixture } from "./fixtures";
import { MOTION } from "../../src/design/motion";
import { stopScreencast } from "./helpers/stop-screencast";
import { evidenceDirectory } from "./helpers/evidence-directory";

const EVIDENCE = evidenceDirectory("transitions");
const HARDWARE = process.env.VOXELIGHT_TRANSITION_HARDWARE === "1";
const hardwareLaunchOptions = {
  channel: "chromium",
  headless: process.env.VOXELIGHT_TRANSITION_HEADED !== "1",
  args: process.platform === "win32" ? ["--enable-automation", "--use-angle=d3d11"] : ["--enable-automation"],
  ignoreDefaultArgs: ["--enable-unsafe-swiftshader"],
};
const drillTest = test.extend<{ drillHardware: boolean }>({
  drillHardware: [false, { option: true }],
  context: async ({ drillHardware, baseURL }, use) => {
    if (!drillHardware) throw new Error("Full drill geometry requires its hardware Chromium fixture");
    const browser = await chromium.launch(hardwareLaunchOptions);
    try { await use(await browser.newContext({ baseURL })); }
    finally { await browser.close(); }
  },
});
type Rect = { x: number; y: number; width: number; height: number };
type TraceParams = { trigger: string; source?: string; target?: string };
type FrameBoundary = { rafTimestamp: number; callbackStartedAt: number; observedAt: number };
type ProjectionWrite = { at: number; rafTimestamp: number | null; callbackStartedAt: number | null;
  transform: string; transformOrigin: string; bounds: Rect };
type IdentityHit = { matches: boolean; hit: string | null; pointerEvents: string;
  cardFlight: boolean; cardZIndex: string | null; ancestry: {
  element: string; position: string; zIndex: string; opacity: string; transform: string; isolation: string;
}[] };
type Sample = {
  at: number; rafTimestamp: number | null; callbackStartedAt: number | null;
  stageOpacity: number | null; stageTransform: string | null; stageAnimationCount: number;
  mainAnimationCount: number; source: Rect | null; target: Rect | null; targetTransform: string | null;
  identityHit: IdentityHit | null;
  mainScrollTop: number; lens: Rect | null; nav: Rect | null; logo: Rect | null;
  characterOpacity: number | null; characterState: string | null; worldAnchor: Rect | null;
};
type Trace = {
  timeOrigin: number; startedAt: number; inputAt: number | null; lastInputAt: number | null;
  actionCompletedAt: number | null; finishedAt: number | null; params: TraceParams;
  inputs: { at: number; type: string; page: string | null; key: string | null; trusted: boolean }[];
  inputFrameBaseline: FrameBoundary | null;
  sourceAtInput: Rect | null; frames: Sample[]; commits: Sample[];
  projectionWrites: ProjectionWrite[]; projectionErrors: string[];
};
type Harness = { start(params: TraceParams): void; actionComplete(): void; done(): boolean; stop(): Trace };
declare global { interface Window { __transitionHarness?: Harness } }

const pageErrors = new WeakMap<Page, string[]>();
const navSelector = (id: string) => 'nav button[data-page="' + id + '"]';
const softwareRenderer = (renderer: string) => /swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer);
const identityTransform = (value: string | null) => !value || value === "none" || /^matrix\(1,\s*0,\s*0,\s*1,\s*0,\s*0\)$/.test(value);

async function installRecorder(page: Page) {
  await page.addInitScript(() => {
    const nativeRaf = window.requestAnimationFrame;
    const nativeCancel = window.cancelAnimationFrame;
    let current: (Omit<Trace, "frames"> & { frameMap: Map<number, Sample>; done: boolean }) | null = null;
    let scheduled: number | null = null;
    let lastNativeFrame: FrameBoundary | null = null;
    let executingRaf: FrameBoundary | null = null;
    let restoreProjectionObserver: (() => void) | null = null;
    const rect = (selector?: string): Rect | null => {
      const element = selector ? document.querySelector<HTMLElement>(selector) : null;
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    };
    const observeProjection = () => {
      // Chromium exposes transformOrigin as a named CSS property, without a
      // prototype setter. Observe the complete Motion write via the exact
      // destination's native style object, before any batched RAF/MO sample.
      const key = "style";
      let owner: object | null = Object.getPrototypeOf(document.createElement("span"));
      let descriptor: PropertyDescriptor | undefined;
      while (owner && !(descriptor = Object.getOwnPropertyDescriptor(owner, key))) owner = Object.getPrototypeOf(owner);
      if (!owner || !descriptor?.get || !descriptor.configurable)
        throw new Error("The native HTMLElement.style getter is not observable for synchronous identity projection");
      const prototype = owner, original = descriptor, read = descriptor.get;
      const proxies = new WeakMap<CSSStyleDeclaration, CSSStyleDeclaration>();
      let observing = true;
      Object.defineProperty(prototype, key, { ...original, get(this: HTMLElement) {
        const nativeStyle: CSSStyleDeclaration = read.call(this);
        const trace = current;
        const selector = trace?.params.target;
        if (!observing || !trace || trace.done || !selector || this.localName !== "span" || !this.matches(selector)) return nativeStyle;
        const existing = proxies.get(nativeStyle);
        if (existing) return existing;
        const element = this;
        const methods = new Map<Function, Function>();
        const proxy = new Proxy(nativeStyle, {
          get(style, property) {
            const value = Reflect.get(style, property, style);
            if (typeof value !== "function" || property === "constructor") return value;
            if (!methods.has(value)) methods.set(value, value.bind(style));
            return methods.get(value);
          },
          set(style, property, value) {
            const applied = Reflect.set(style, property, value, style);
            if (applied && property === "transformOrigin" && observing && current === trace &&
              !trace.done && trace.inputAt !== null && element.isConnected && element.matches(selector)) {
              try {
                const box = element.getBoundingClientRect(), computed = getComputedStyle(element);
                trace.projectionWrites.push({ at: performance.now(), rafTimestamp: executingRaf?.rafTimestamp ?? null,
                  callbackStartedAt: executingRaf?.callbackStartedAt ?? null, transform: computed.transform,
                  transformOrigin: computed.transformOrigin, bounds: { x: box.x, y: box.y, width: box.width, height: box.height } });
              } catch (error) { trace.projectionErrors.push(String(error)); }
            }
            return applied;
          },
        });
        proxies.set(nativeStyle, proxy);
        return proxy;
      } });
      return () => { observing = false; Object.defineProperty(prototype, key, original); };
    };
    const sample = (rafTimestamp: number | null, callbackStartedAt: number | null): Sample | null => {
      if (!current || current.done) return null;
      const main = document.querySelector<HTMLElement>("#main-content");
      const stage = main?.querySelector<HTMLElement>(":scope > .vx-page-stage");
      const style = stage ? getComputedStyle(stage) : null;
      const target = current.params.target ? document.querySelector<HTMLElement>(current.params.target) : null;
      const identify = (element: Element) => element.localName + (element.id ? "#" + element.id : "") +
        Array.from(element.classList).map(value => "." + value).join("");
      let identityHit: IdentityHit | null = null;
      if (target) {
        const bounds = target.getBoundingClientRect();
        const card = target.closest<HTMLElement>(".vx-instance-card");
        const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        const matches = hit !== null && (hit === target || target.contains(hit));
        const ancestry: IdentityHit["ancestry"] = [];
        if (!matches) for (let ancestor: Element | null = target; ancestor; ancestor = ancestor.parentElement) {
          const computed = getComputedStyle(ancestor);
          ancestry.push({ element: identify(ancestor), position: computed.position, zIndex: computed.zIndex,
            opacity: computed.opacity, transform: computed.transform, isolation: computed.isolation });
        }
        identityHit = { matches, hit: hit ? identify(hit) : null, pointerEvents: getComputedStyle(target).pointerEvents,
          cardFlight: card?.hasAttribute("data-identity-flight") ?? false,
          cardZIndex: card ? getComputedStyle(card).zIndex : null, ancestry };
      }
      const mainAnimations = main?.getAnimations({ subtree: true }).filter(animation => {
        const element = (animation.effect as KeyframeEffect | null)?.target;
        return animation.playState === "running" && element instanceof Element && Boolean(main?.contains(element)) && !element.closest("dialog");
      }) ?? [];
      return {
        at: performance.now(), rafTimestamp, callbackStartedAt,
        stageOpacity: style ? Number(style.opacity) : null, stageTransform: style?.transform ?? null,
        stageAnimationCount: mainAnimations.filter(animation => (animation.effect as KeyframeEffect | null)?.target === stage).length,
        mainAnimationCount: mainAnimations.length,
        source: rect(current.params.source), target: rect(current.params.target),
        targetTransform: target ? getComputedStyle(target).transform : null,
        identityHit,
        mainScrollTop: main?.scrollTop ?? 0,
        lens: rect(".vx-floating-nav__indicator-slot"), nav: rect(".vx-floating-nav"), logo: rect(".vx-window-chrome__identity"),
        characterOpacity: document.querySelector(".vx-home__character-panel")
          ? Number(getComputedStyle(document.querySelector(".vx-home__character-panel")!).opacity) : null,
        characterState: document.querySelector<HTMLElement>(".vx-home [data-character-state]")?.dataset.characterState ?? null,
        worldAnchor: rect("[data-world-anchor]"),
      };
    };
    const commitSample = () => {
      const value = sample(null, null);
      if (value && current) current.commits.push(value);
    };
    new MutationObserver(records => {
      const main = document.querySelector("#main-content");
      if (main && records.some(record => record.target === main || main.contains(record.target))) commitSample();
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["style", "class"] });
    // Observe actual native callbacks without changing timestamps, order, or IDs.
    // Keep the last post-callback observation for each real RAF timestamp.
    window.requestAnimationFrame = function (this: Window, callback: FrameRequestCallback) {
      if (typeof callback !== "function") return nativeRaf.call(this, callback);
      return nativeRaf.call(this, function (this: Window, timestamp: number) {
        const callbackStartedAt = performance.now();
        lastNativeFrame = { rafTimestamp: timestamp, callbackStartedAt, observedAt: callbackStartedAt };
        const previous = executingRaf;
        executingRaf = lastNativeFrame;
        try { callback.call(this, timestamp); } finally {
          executingRaf = previous;
          queueMicrotask(() => {
            const value = sample(timestamp, callbackStartedAt);
            if (value && current) current.frameMap.set(timestamp, value);
          });
        }
      });
    };
    const beginInput = (event: Event) => {
      if (!current || current.done || !event.isTrusted) return;
      if (event instanceof KeyboardEvent && event.key !== "Enter" && event.key !== " ") return;
      if (!(event.target instanceof Element) || !event.target.closest(current.params.trigger)) return;
      const at = performance.now();
      if (current.inputAt === null) {
        current.inputAt = at;
        current.sourceAtInput = rect(current.params.source);
        current.inputFrameBaseline = lastNativeFrame ? { ...lastNativeFrame } : null;
      }
      current.lastInputAt = at;
      current.inputs.push({ at, type: event.type, page: event.target.closest<HTMLElement>("button[data-page]")?.dataset.page ?? null,
        key: event instanceof KeyboardEvent ? event.key : null, trusted: event.isTrusted });
      commitSample();
    };
    document.addEventListener("pointerdown", beginInput, true);
    document.addEventListener("keydown", beginInput, true);
    const tick = (timestamp: number) => {
      if (!current || current.done) return;
      const callbackStartedAt = performance.now();
      lastNativeFrame = { rafTimestamp: timestamp, callbackStartedAt, observedAt: callbackStartedAt };
      const value = sample(timestamp, callbackStartedAt);
      if (value) current.frameMap.set(timestamp, value);
      const anchor = current.actionCompletedAt;
      // Slow renderers can spend the whole interval between two callbacks.
      // Keep collecting actual frames within the existing outer timeout.
      if (anchor !== null && performance.now() - anchor >= 1100 && current.frameMap.size > 2) {
        current.finishedAt = performance.now(); current.done = true; scheduled = null;
      } else scheduled = nativeRaf.call(window, tick);
    };
    window.__transitionHarness = {
      start(params) {
        if (scheduled !== null) nativeCancel.call(window, scheduled);
        restoreProjectionObserver?.();
        restoreProjectionObserver = null;
        current = { timeOrigin: performance.timeOrigin, startedAt: performance.now(), inputAt: null, lastInputAt: null,
          actionCompletedAt: null, inputs: [], finishedAt: null, params, sourceAtInput: null,
          inputFrameBaseline: null,
          frameMap: new Map(), commits: [], projectionWrites: [], projectionErrors: [], done: false };
        try {
          if (params.target) restoreProjectionObserver = observeProjection();
          commitSample();
          scheduled = nativeRaf.call(window, tick);
        } catch (error) {
          current.done = true;
          restoreProjectionObserver?.();
          restoreProjectionObserver = null;
          throw error;
        }
      },
      actionComplete() {
        if (!current) throw new Error("Transition recorder was never started");
        current.actionCompletedAt = performance.now();
        commitSample();
      },
      done() { return current?.done ?? false; },
      stop() {
        if (!current) throw new Error("Transition recorder was never started");
        if (scheduled !== null) nativeCancel.call(window, scheduled);
        scheduled = null; current.done = true;
        restoreProjectionObserver?.();
        restoreProjectionObserver = null;
        const { frameMap, done: _done, ...trace } = current;
        return { ...trace, frames: [...frameMap.values()].sort((a, b) => a.rafTimestamp! - b.rafTimestamp!) };
      },
    };
  });
}

async function renderer(page: Page) {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(".world-scene__canvas");
    const gl = canvas?.getContext("webgl2");
    if (!gl) return { renderer: "unavailable", vendor: "unavailable" };
    const extension = gl.getExtension("WEBGL_debug_renderer_info");
    return { renderer: extension ? String(gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)) : "unavailable",
      vendor: extension ? String(gl.getParameter(extension.UNMASKED_VENDOR_WEBGL)) : "unavailable" };
  });
}

async function prepare(page: Page, options: NonNullable<Parameters<typeof installLauncherFixture>[1]> = {}) {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 720 });
  await installLauncherFixture(page, options);
  await installRecorder(page);
  await page.goto("/", { waitUntil: "commit" });
  await expect(page.locator(".vx-home")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-world-intro", "off");
  await expect(page.locator(".vx-home [data-character-state]")).toHaveAttribute("data-character-state", "ready");
  await settle(page);
}

async function settle(page: Page) {
  await expect(page.locator("#main-content > .vx-page-stage")).toHaveCount(1);
  await expect.poll(() => page.locator("#main-content > .vx-page-stage").evaluate(element => {
    const style = getComputedStyle(element);
    return Number(style.opacity) === 1 && (style.transform === "none" || style.transform === "matrix(1, 0, 0, 1, 0, 0)") &&
      !style.willChange.split(",").some(property => property.trim() === "opacity") &&
      element.getAnimations().every(animation => animation.playState !== "running");
  })).toBe(true);
  await expect(page.locator("nav.vx-floating-nav")).toHaveAttribute("data-motion-settled", "true");
}

type Recorded = Trace & {
  renderer: string; vendor: string; contentAnimFrames: number; maxFrameGapMs: number;
  frameGapBaseline: FrameBoundary | null; frameIntervalsMs: number[]; firstPostInputCallbackGapMs: number | null;
  sampledSpanMs: number; errors: string[]; captureErrors: string[]; hardware40ms: string;
};

async function capture(page: Page, info: TestInfo, label: string, params: TraceParams, action: () => Promise<unknown>, screencast = true): Promise<Recorded> {
  const directory = join(EVIDENCE, info.title.replace(/[^a-zA-Z0-9_-]+/g, "-"), label);
  await mkdir(directory, { recursive: true });
  let cdp: CDPSession | null = null;
  const shots: { timestamp: number; data: string }[] = [];
  const acknowledgements: Promise<unknown>[] = [];
  const captureErrors: string[] = [];
  let acknowledgeFirstFrame: (() => void) | undefined;
  const firstNativeFrame = new Promise<void>(done => { acknowledgeFirstFrame = done; });
  let postInputEpoch: number | null = null;
  let acknowledgePostInputFrame: (() => void) | undefined;
  const postInputFrame = new Promise<void>(done => { acknowledgePostInputFrame = done; });
  const onFrame = (frame: { metadata: { timestamp?: number }; data: string; sessionId: number }) => {
    const timestamp = frame.metadata.timestamp;
    if (timestamp === undefined || !Number.isFinite(timestamp)) captureErrors.push("CDP screencast frame has no finite native timestamp");
    else {
      shots.push({ timestamp, data: frame.data }); acknowledgeFirstFrame?.();
      if (postInputEpoch !== null && timestamp >= postInputEpoch) acknowledgePostInputFrame?.();
    }
    acknowledgements.push(cdp!.send("Page.screencastFrameAck", { sessionId: frame.sessionId })
      .catch(error => { captureErrors.push("CDP frame acknowledgement failed: " + String(error)); }));
  };
  let failure: unknown;
  let recordedTrace: Trace | undefined;
  let recorderStarted = false, screencastStarted = false;
  let collectionWaitNodeStart: { performanceNow: number; epochMs: number } | null = null;
  let collectionWaitNodeFinishedAt: number | null = null;
  try {
  if (screencast) {
    cdp = await page.context().newCDPSession(page);
    cdp.on("Page.screencastFrame", onFrame);
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 85, everyNthFrame: 1 });
    screencastStarted = true;
    let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([firstNativeFrame, new Promise<never>((_, reject) => {
        handshakeTimer = setTimeout(() => reject(new Error("CDP screencast did not deliver a native first frame within 5000ms")), 5000);
      })]);
      await Promise.all(acknowledgements);
    } finally { if (handshakeTimer !== undefined) clearTimeout(handshakeTimer); }
  }
  await page.evaluate(params => window.__transitionHarness!.start(params), params);
  recorderStarted = true;
    await action();
    await page.evaluate(() => window.__transitionHarness!.actionComplete());
    collectionWaitNodeStart = { performanceNow: performance.now(), epochMs: Date.now() };
    await page.waitForFunction(() => window.__transitionHarness!.done(), null, { timeout: 7000 });
    recordedTrace = await page.evaluate(() => window.__transitionHarness!.stop());
    if (cdp && recordedTrace.inputAt !== null) {
      postInputEpoch = (recordedTrace.timeOrigin + recordedTrace.inputAt) / 1000;
      if (shots.some(shot => shot.timestamp >= postInputEpoch!)) acknowledgePostInputFrame?.();
      const remaining = 7000 - (performance.now() - collectionWaitNodeStart.performanceNow);
      if (remaining <= 0) throw new Error("The shared 7000ms collection budget expired before post-input compositor evidence was collected");
      let postFrameTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([postInputFrame, new Promise<never>((_, reject) => {
          postFrameTimer = setTimeout(() => reject(new Error("No native post-input compositor frame arrived inside the shared 7000ms collection budget")), remaining);
        })]);
      } finally { if (postFrameTimer !== undefined) clearTimeout(postFrameTimer); }
    }
  } catch (error) { failure = error; }
  finally {
    collectionWaitNodeFinishedAt = performance.now();
    if (cdp) {
      const session = cdp;
      await stopScreencast({
        stop: screencastStarted ? () => session.send("Page.stopScreencast") : undefined,
        removeFrameListener: () => { session.off("Page.screencastFrame", onFrame); },
        acknowledgements,
        detach: () => session.detach(),
        recordError: (stage, error) => captureErrors.push(`CDP ${stage} failed: ${String(error)}`),
      });
    }
  }
  if (!recorderStarted) {
    await writeFile(join(directory, "capture-setup-failure.json"), JSON.stringify({ captureErrors,
      screencastTimestamps: shots.map(shot => shot.timestamp),
      failure: failure instanceof Error ? failure.message : String(failure) }, null, 2));
    throw failure ?? new Error("Transition recorder setup did not complete");
  }
  const trace = recordedTrace ?? await page.evaluate(() => window.__transitionHarness!.stop());
  const device = await renderer(page);
  const frames = trace.frames.filter(frame => trace.inputAt !== null && frame.at >= trace.inputAt);
  // Include the real callback just before input: otherwise a synchronous mount
  // can block the first post-input RAF and disappear from a post-only gap list.
  let baseline = trace.inputFrameBaseline;
  const lastBeforeInput = trace.frames.filter(frame => trace.inputAt !== null && frame.at < trace.inputAt).at(-1);
  if (lastBeforeInput && lastBeforeInput.rafTimestamp !== null && lastBeforeInput.callbackStartedAt !== null &&
    (!baseline || lastBeforeInput.callbackStartedAt > baseline.callbackStartedAt))
    baseline = { rafTimestamp: lastBeforeInput.rafTimestamp, callbackStartedAt: lastBeforeInput.callbackStartedAt, observedAt: lastBeforeInput.at };
  const timestamps = [...(baseline ? [baseline.rafTimestamp] : []), ...frames.map(frame => frame.rafTimestamp!)];
  const gaps = timestamps.slice(1).map((timestamp, index) => timestamp - timestamps[index]);
  const result: Recorded = { ...trace, ...device,
    contentAnimFrames: frames.filter(frame => frame.stageOpacity !== null && frame.stageOpacity > 0 && frame.stageOpacity < 1 ||
      frame.stageTransform !== null && !identityTransform(frame.stageTransform) || frame.stageAnimationCount > 0).length,
    maxFrameGapMs: gaps.length ? Math.max(...gaps) : 0,
    frameGapBaseline: baseline, frameIntervalsMs: gaps,
    firstPostInputCallbackGapMs: trace.inputAt !== null && frames[0]?.callbackStartedAt !== null && frames[0]?.callbackStartedAt !== undefined
      ? frames[0].callbackStartedAt - trace.inputAt : null,
    sampledSpanMs: frames.length > 1 ? frames.at(-1)!.rafTimestamp! - frames[0].rafTimestamp! : 0,
    errors: [...(pageErrors.get(page) ?? [])], captureErrors,
    hardware40ms: softwareRenderer(device.renderer) ? "NOT_EVALUATED_SOFTWARE_RENDERER" : HARDWARE ? "STRICT_HARDWARE_CASE" : "NOT_EVALUATED_FUNCTIONAL_CAPTURE",
  };
  const inputEpochSeconds = trace.inputAt === null ? null : (trace.timeOrigin + trace.inputAt) / 1000;
  const relevant = shots.filter(shot => inputEpochSeconds !== null && shot.timestamp >= inputEpochSeconds);
  const picks = relevant.length <= 8 ? relevant : Array.from({ length: 8 }, (_, index) => relevant[Math.floor(index * (relevant.length - 1) / 7)]);
  for (const [index, shot] of picks.entries()) await writeFile(join(directory, String(index).padStart(2, "0") + "-" +
    Math.round((shot.timestamp - inputEpochSeconds!) * 1000) + "ms.jpg"), Buffer.from(shot.data, "base64"));
  const beforeScreenshot = await page.evaluate(() => ({ at: performance.now(), page: document.querySelector<HTMLElement>(".vx-app-body")?.dataset.currentPage,
    mainScrollTop: document.querySelector<HTMLElement>("#main-content")?.scrollTop }));
  await page.screenshot({ path: join(directory, "settled.png") });
  const afterScreenshot = await page.evaluate(() => ({ at: performance.now(), page: document.querySelector<HTMLElement>(".vx-app-body")?.dataset.currentPage,
    mainScrollTop: document.querySelector<HTMLElement>("#main-content")?.scrollTop }));
  await writeFile(join(directory, "trace.json"), JSON.stringify({ ...result, screencastFrames: relevant.length,
    screencastTimestamps: shots.map(shot => shot.timestamp), inputEpochSeconds,
    collectionWaitNodeStart, collectionWaitNodeFinishedAt,
    postActionScreenshot: { before: beforeScreenshot, after: afterScreenshot },
    failure: failure instanceof Error ? failure.message : failure ?? null }, null, 2));
  if (failure) throw failure;
  expect(result.inputAt, label + " must include real pointer/keyboard input").not.toBeNull();
  expect(result.actionCompletedAt).not.toBeNull();
  expect(beforeScreenshot.at).toBeGreaterThanOrEqual(result.actionCompletedAt!);
  expect(result.frames.length, label + " must contain real RAF observations").toBeGreaterThan(2);
  expect(result.errors).toEqual([]);
  expect(result.captureErrors).toEqual([]);
  if (screencast) expect(relevant.length, label + " must save actual compositor frames").toBeGreaterThan(0);
  return result;
}

async function navigate(page: Page, id: string) {
  await page.locator(navSelector(id)).click();
  await expect(page.locator(".vx-app-body")).toHaveAttribute("data-current-page", id);
  await settle(page);
}

async function secondSettingsVisit(page: Page, info: TestInfo) {
  await navigate(page, "settings");
  await page.locator(".vx-settings-nav button").nth(1).click();
  await expect(page.locator(".vx-settings-nav button").nth(1)).toHaveAttribute("aria-current", "page");
  await navigate(page, "home");
  await navigate(page, "settings");
  return capture(page, info, "second-settings-section", { trigger: ".vx-settings-nav button" },
    () => page.locator(".vx-settings-nav button").nth(1).click(), false);
}

async function verifyHardwareRenderer(page: Page, directory: string) {
  const browser = page.context().browser();
  if (!browser) throw new Error("Hardware acceptance requires the launched Chromium browser");
  const device = await renderer(page);
  const browserCdp = await browser.newBrowserCDPSession();
  let browserArguments: string[];
  try { browserArguments = (await browserCdp.send("Browser.getBrowserCommandLine")).arguments; }
  finally { await browserCdp.detach(); }
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "hardware-renderer.json"), JSON.stringify({ ...device, browserArguments }, null, 2));
  expect(browserArguments.filter(argument => /swiftshader/i.test(argument)), "Hardware Chromium must not inherit SwiftShader flags").toEqual([]);
  expect(device.renderer).not.toBe("unavailable");
  expect(softwareRenderer(device.renderer), "Hardware acceptance requires a real non-software renderer").toBe(false);
  if (process.platform === "win32") {
    expect(browserArguments[0]).toMatch(/[\\/]chrome\.exe$/i);
    expect(browserArguments).toContain("--use-angle=d3d11");
    expect(device.renderer).toMatch(/\b(?:Direct3D11|D3D11)\b/i);
  }
}

if (HARDWARE) {
  test("transitions: hardware second settings visit stays below 40ms", async ({}, info) => {
    const browser = await chromium.launch(hardwareLaunchOptions);
    const page = await browser.newPage();
    try {
      await prepare(page);
      await verifyHardwareRenderer(page, EVIDENCE);
      const measured = await secondSettingsVisit(page, info);
      expect(measured.sampledSpanMs).toBeGreaterThanOrEqual(1000);
      expect(measured.frames.length).toBeGreaterThan(25);
      expect(measured.frameGapBaseline, "The last real pre-input RAF must be retained").not.toBeNull();
      expect(measured.frameIntervalsMs.every(gap => gap >= 0)).toBe(true);
      expect(measured.maxFrameGapMs).toBeLessThan(40);
      if (measured.firstPostInputCallbackGapMs === null) throw new Error("No real first-post-input callback latency was captured");
      expect(measured.firstPostInputCallbackGapMs).toBeGreaterThanOrEqual(0);
      expect(measured.firstPostInputCallbackGapMs).toBeLessThan(40);
    } finally { await browser.close(); }
  });
} else {
  test("page stage exists for the active route", async ({ page }) => {
    await installLauncherFixture(page);
    await page.goto("/", { waitUntil: "commit" });
    await page.locator(navSelector("library")).click();
    await expect(page.getByRole("heading", { name: "游戏库", exact: true })).toBeVisible();
    await expect(page.locator("#main-content > .vx-page-stage")).toHaveCount(1);
  });

  test("transitions: page five route changes animate real content and keep the lens inside navigation", async ({ page }, info) => {
    await prepare(page);
    for (const [from, to] of [["home", "library"], ["library", "discover"], ["discover", "settings"], ["settings", "downloads"], ["downloads", "home"]]) {
      const measured = await capture(page, info, from + "-to-" + to, { trigger: navSelector(to) }, () => page.locator(navSelector(to)).click());
      expect(measured.contentAnimFrames, from + " to " + to + " must animate the actual page stage").toBeGreaterThan(0);
      for (const frame of measured.frames) {
        if (!frame.lens || !frame.nav || !frame.logo) continue;
        expect(frame.lens.x).toBeGreaterThanOrEqual(frame.nav.x - .5);
        expect(frame.lens.x + frame.lens.width).toBeLessThanOrEqual(frame.nav.x + frame.nav.width + .5);
        const overlapX = Math.max(0, Math.min(frame.lens.x + frame.lens.width, frame.logo.x + frame.logo.width) - Math.max(frame.lens.x, frame.logo.x));
        const overlapY = Math.max(0, Math.min(frame.lens.y + frame.lens.height, frame.logo.y + frame.logo.height) - Math.max(frame.lens.y, frame.logo.y));
        expect(overlapX * overlapY, "lens must not cover the Voxelight identity").toBeLessThanOrEqual(.5);
      }
      expect(measured.frames.some(frame => frame.lens && frame.nav && frame.logo)).toBe(true);
      await expect(page.locator(".vx-app-body")).toHaveAttribute("data-current-page", to);
      await settle(page);
    }
    await expect(page.locator("nav.vx-floating-nav")).toHaveAttribute("data-visual-owner", "lens");
    await expect(page.locator(".vx-window-chrome__bar")).not.toHaveAttribute("data-visual-owner", "lens");
  });

  test("transitions: rapid navigation keeps the last requested page", async ({ page }, info) => {
    await prepare(page);
    const recorded = await capture(page, info, "rapid-latest-target", { trigger: "nav button[data-page]" }, async () => {
      // Trial-free dispatch: real sequential mouse presses, without waiting for each page animation.
      for (const id of ["library", "discover", "settings", "downloads", "home", "library"]) {
        const box = await page.locator(navSelector(id)).boundingBox();
        expect(box).not.toBeNull();
        await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
      }
    });
    expect(recorded.inputs.map(input => input.page)).toEqual(["library", "discover", "settings", "downloads", "home", "library"]);
    await expect(page.locator(".vx-app-body")).toHaveAttribute("data-current-page", "library");
    await expect(page.locator(".vx-library-page")).toBeVisible();
    await expect(page.locator("#main-content > .vx-page-stage")).toHaveCount(1);
    await settle(page);
  });

  test("transitions: nav current page returns the main scroll to the top", async ({ page }, info) => {
    await prepare(page, { instanceCount: 48 });
    await navigate(page, "library");
    const main = page.locator("#main-content");
    await main.evaluate(element => { element.scrollTop = element.scrollHeight; });
    expect(await main.evaluate(element => element.scrollTop)).toBeGreaterThan(100);
    await capture(page, info, "current-library-to-top", { trigger: navSelector("library") }, () => page.locator(navSelector("library")).click());
    await expect.poll(() => main.evaluate(element => element.scrollTop)).toBe(0);
    await expect(page.locator(".vx-library-page")).toBeVisible();
  });

  for (const mode of ["lite", "reduced-motion", "reduced-transparency", "high-contrast"] as const) {
    test("transitions: tier " + mode + " preserves its distinct degradation and keyboard marker", async ({ page }, info) => {
      if (mode === "reduced-motion") await page.emulateMedia({ reducedMotion: "reduce" });
      if (mode === "high-contrast") await page.emulateMedia({ contrast: "more" });
      if (mode === "reduced-transparency") await page.addInitScript(() => {
        const original = window.matchMedia;
        window.matchMedia = query => {
          const media = original.call(window, query);
          if (query !== "(prefers-reduced-transparency: reduce)") return media;
          return new Proxy(media, { get(target, property, receiver) {
            if (property === "matches") return true;
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          } });
        };
      });
      await prepare(page, { effects: mode === "lite" ? "lite" : "full" });
      const staticScene = mode !== "reduced-transparency";
      await expect(page.locator(".vx-home")).toHaveAttribute("data-motion", staticScene ? "reduced" : "full");
      const measured = await capture(page, info, "home-to-library-" + mode, { trigger: navSelector("library") }, () => page.locator(navSelector("library")).click());
      expect(measured.frames.every(frame => identityTransform(frame.stageTransform))).toBe(true);
      if (mode === "reduced-motion" || mode === "high-contrast")
        expect(measured.frames.filter(frame => frame.stageOpacity !== null && frame.stageOpacity > 0 && frame.stageOpacity < 1)).toHaveLength(0);
      else expect(measured.contentAnimFrames, "flat content retains the allowed Lite fade").toBeGreaterThan(0);
      const card = page.locator('article[data-instance-id="fixture-world"]');
      await page.keyboard.press("Tab");
      await card.locator(".vx-instance-card__select").focus();
      await expect(card.locator('.vx-lattice-frame[data-selected="true"]')).toBeVisible();
      await expect(card.locator('.vx-lattice-frame[data-selected="true"]')).toHaveCSS("border-top-style", "dotted");
      await expect(card.locator(":scope > .vx-lattice-frame")).toHaveAttribute("data-focused", "true");
      await expect(card.locator(":scope > .vx-lattice-frame")).toHaveCSS("outline-style", "solid");
      await navigate(page, "home");
      await expect(page.locator(".vx-home [data-character-paused]")).toHaveAttribute("data-character-paused", String(staticScene));
    });
  }

  test("transitions: page records second settings timing without claiming software is hardware", async ({ page }, info) => {
    await prepare(page);
    const measured = await secondSettingsVisit(page, info);
    expect(measured.sampledSpanMs).toBeGreaterThanOrEqual(1000);
    if (softwareRenderer(measured.renderer)) expect(measured.hardware40ms).toBe("NOT_EVALUATED_SOFTWARE_RENDERER");
    info.annotations.push({ type: "hardware-acceptance", description: "40ms is assessed only with VOXELIGHT_TRANSITION_HARDWARE=1 and a verified hardware renderer." });
  });
}

async function tabTo(page: Page, selector: string) {
  await page.locator(".vx-library-page h1").evaluate(element => element.focus({ preventScroll: true }));
  for (let index = 0; index < 160; index++) {
    if (await page.locator(selector).evaluate(element => document.activeElement === element)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error("Keyboard Tab traversal never reached " + selector);
}

const fields = ["x", "y", "width", "height"] as const;
const rectangleError = (actual: Rect, expected: Rect) => Math.max(...fields.map(field => Math.abs(actual[field] - expected[field])));

async function assertDrillGeometry(recorded: Recorded, finalRect: Rect, info: TestInfo, label: string) {
  const source = recorded.sourceAtInput;
  expect(source, "identity origin must be captured synchronously before the real input handler").not.toBeNull();
  const firstProjected = recorded.projectionWrites.find(sample => !identityTransform(sample.transform));
  const frames = recorded.frames.filter((sample): sample is Sample & { target: Rect } => sample.target !== null);
  const delta = fields.map(field => finalRect[field] - source![field]);
  const distance = Math.hypot(...delta);
  expect(distance, "fixture must exercise a genuine spatial drill").toBeGreaterThan(20);
  const progress = (box: Rect) => fields.reduce((sum, field, index) => sum + (box[field] - source![field]) * delta[index], 0) / (distance * distance);
  const values = frames.map(sample => ({ ...sample, progress: progress(sample.target) }));
  const intermediate = values.filter(sample => sample.progress > .001 && sample.progress < .999);
  const intermediatePositions = new Set(intermediate.map(sample => fields.map(field => sample.target[field].toFixed(2)).join("|")));
  const alpha = MOTION.identity.damping / 2;
  const beta = Math.sqrt(MOTION.identity.stiffness - alpha * alpha);
  const peakAt = Math.atan(beta / alpha) / beta;
  const peakVelocity = MOTION.identity.stiffness / beta * Math.exp(-alpha * peakAt) * Math.sin(beta * peakAt);
  const directory = join(EVIDENCE, info.title.replace(/[^a-zA-Z0-9_-]+/g, "-"), label);
  await writeFile(join(directory, "drill-geometry.json"), JSON.stringify({ source, finalRect, firstProjected, intermediateFrames: intermediate.length, distinctIntermediatePositions: intermediatePositions.size, projectionErrors: recorded.projectionErrors,
    peakNormalizedVelocityPerSecond: peakVelocity, frames: values }, null, 2));
  expect(recorded.projectionErrors).toEqual([]);
  if (!firstProjected) throw new Error("The first applied projection was not observed synchronously");
  expect(rectangleError(firstProjected.bounds, source!), "initial projected identity must coincide with the source span in all four coordinates").toBeLessThanOrEqual(.1);
  const earlyFrames = frames.filter(sample => sample.at < firstProjected.at);
  expect(earlyFrames.every(sample => rectangleError(sample.target, source!) <= .1),
    "no real RAF may expose the unprojected destination before the initial projection").toBe(true);
  expect(intermediatePositions.size, "real RAF geometry must contain multiple distinct intermediate positions").toBeGreaterThan(1);
  const firstFrame = frames.find(sample => sample.at >= firstProjected.at);
  if (!firstFrame) throw new Error("No real RAF followed the synchronous projection");
  // The synchronous style write proves the origin, but is not Motion's
  // internal start clock. The actual input is the earliest possible start;
  // callback entry uses the same performance clock even for a stale RAF stamp.
  if (recorded.inputAt === null || firstFrame.callbackStartedAt === null) throw new Error("First projection needs actual input and callback clocks");
  const elapsedUpperBound = (firstFrame.callbackStartedAt - recorded.inputAt) / 1000;
  expect(elapsedUpperBound).toBeGreaterThanOrEqual(0);
  const firstStep = Math.hypot(...fields.map(field => firstFrame.target[field] - firstProjected.bounds[field])) / distance;
  await writeFile(join(directory, "first-step-clock.json"), JSON.stringify({ inputAt: recorded.inputAt,
    projectionObservedAt: firstProjected.at, callbackStartedAt: firstFrame.callbackStartedAt,
    rafTimestamp: firstFrame.rafTimestamp, elapsedUpperBound, firstStep }, null, 2));
  expect(firstStep, "first real RAF must continue from the captured projection origin").toBeLessThanOrEqual(peakVelocity * elapsedUpperBound + .2 / distance);
  expect(rectangleError(frames.at(-1)!.target, finalRect)).toBeLessThanOrEqual(.1);
  for (const sample of values) {
    expect(sample.progress).toBeGreaterThanOrEqual(-.002);
    expect(sample.progress).toBeLessThanOrEqual(1.002);
  }
  // Motion's batcher samples performance.now() inside the callback, not the
  // native RAF timestamp, and JSAnimation rounds elapsed time to milliseconds.
  // Bound that real clock by callback entry and the observed projection write.
  const clocks = values.map(sample => {
    for (let index = recorded.projectionWrites.length - 1; index >= 0; index--) {
      const write = recorded.projectionWrites[index];
      if (write.at <= sample.at && write.rafTimestamp === sample.rafTimestamp &&
        write.callbackStartedAt !== null && rectangleError(write.bounds, sample.target) <= .01)
        return { earliest: write.callbackStartedAt, latest: write.at, projectionWrite: true };
    }
    if (sample.callbackStartedAt === null) throw new Error("A real geometry frame is missing its callback entry time");
    return { earliest: sample.callbackStartedAt, latest: sample.at, projectionWrite: false };
  });
  await writeFile(join(directory, "motion-clock-bounds.json"), JSON.stringify(clocks, null, 2));
  for (let index = 1; index < values.length; index++) {
    const before = values[index - 1], after = values[index];
    const elapsed = (clocks[index].latest - clocks[index - 1].earliest + 1) / 1000;
    expect(elapsed).toBeGreaterThanOrEqual(0);
    const step = Math.hypot(...fields.map(field => after.target[field] - before.target[field])) / distance;
    expect(step, "one real RAF must not teleport farther than the specified spring permits").toBeLessThanOrEqual(peakVelocity * elapsed + .2 / distance);
  }
}

function assertDrillIdentityVisible(recorded: Recorded, label: string) {
  const frames = recorded.frames.filter(frame => frame.target !== null && frame.at >= recorded.inputAt!);
  expect(frames.length, label + " needs real RAF identity samples").toBeGreaterThan(2);
  expect.soft(frames.filter(frame => !frame.identityHit?.matches).map(frame => ({
    at: frame.at, rafTimestamp: frame.rafTimestamp, bounds: frame.target,
    hit: frame.identityHit?.hit, pointerEvents: frame.identityHit?.pointerEvents,
  })), label + " identity center must hit the identity or its descendant on every real RAF").toEqual([]);
}

if (!HARDWARE) {
  drillTest.describe("hardware drill geometry", () => {
    // Built-in browser launch options are worker-scoped. Keep the override
    // local to these eight tests through a test-scoped context fixture.
    drillTest.use({ drillHardware: true });
    for (const kind of ["instance", "version-directory"] as const) {
      for (const view of ["grid", "list"] as const) {
        for (const input of ["mouse", "keyboard"] as const) {
          drillTest("transitions: drill " + kind + " " + view + " " + input + " preserves scrolled origin and return focus", async ({ page }, info) => {
            await prepare(page, { instanceCount: 30, versionDirectoryCount: 30 });
            await verifyHardwareRenderer(page, join(EVIDENCE, info.title.replace(/[^a-zA-Z0-9_-]+/g, "-")));
            await navigate(page, "library");
            if (kind === "version-directory") await page.locator(".vx-library-scope button").nth(1).click();
            await page.locator(".vx-library-view button").nth(view === "list" ? 1 : 0).click();
            await expect(page.locator(".vx-instance-sheet--" + view)).toBeVisible();
            const attribute = kind === "instance" ? "data-instance-id" : "data-version-directory";
            const cards = page.locator("article[" + attribute + "]");
            await expect(cards).toHaveCount(30);
            const id = await cards.nth(24).getAttribute(attribute);
            expect(id).not.toBeNull();
            const cardSelector = "article[" + attribute + "=" + JSON.stringify(id) + "]";
            const openSelector = cardSelector + " .vx-instance-card__select";
            const identity = ".vx-instance-identity[data-identity-kind=" + JSON.stringify(kind) + "][data-identity=" + JSON.stringify(id) + "]";
            const cardIdentity = cardSelector + " " + identity;
            const detailIdentity = ".vx-detail-header " + identity;
            const layoutId = kind + "-identity-" + id;
            await expect(page.locator(cardIdentity)).toHaveAttribute("data-layout-id", layoutId);
            await expect(page.locator(cardSelector)).not.toHaveAttribute("data-identity-flight");
            await expect(page.locator(cardSelector)).toHaveCSS("z-index", "auto");
            const main = page.locator("#main-content");
            if (input === "keyboard") await tabTo(page, openSelector);
            else await page.locator(openSelector).scrollIntoViewIfNeeded();
            const savedScrollTop = await main.evaluate(element => element.scrollTop);
            expect(savedScrollTop).toBeGreaterThan(100);
            const openTrace = await capture(page, info, "open", { trigger: openSelector, source: cardIdentity, target: detailIdentity },
              () => input === "keyboard" ? page.keyboard.press("Enter") : page.locator(openSelector).click());
            await expect(page.locator(".vx-detail-header h1")).toBeFocused();
            await expect(page.locator(detailIdentity)).toHaveAttribute("data-layout-id", layoutId);
            await expect.poll(() => main.evaluate(element => element.scrollTop)).toBe(0);
            const finalDetail = await page.locator(detailIdentity).boundingBox();
            expect(finalDetail).not.toBeNull();
            await assertDrillGeometry(openTrace, finalDetail!, info, "open");
            assertDrillIdentityVisible(openTrace, "open");
            if (kind === "instance") {
              const detailContent = page.locator(".vx-detail-layout");
              await expect(detailContent).toHaveCSS("opacity", "1");
              // Finished opacity fills behave like will-change: opacity and can
              // isolate a nested glass control from the backdrop.
              await expect(detailContent).toHaveCSS("animation-fill-mode", "none");
            }
            const backSelector = ".vx-detail-header > button:first-child";
            if (input === "keyboard") {
              await page.keyboard.press("Shift+Tab");
              await expect(page.locator(backSelector)).toBeFocused();
            }
            const backTrace = await capture(page, info, "back", { trigger: backSelector, source: detailIdentity, target: cardIdentity },
              () => input === "keyboard" ? page.keyboard.press("Enter") : page.locator(backSelector).click());
            await expect(page.locator(openSelector)).toBeFocused();
            await expect.poll(() => main.evaluate(element => element.scrollTop)).toBeCloseTo(savedScrollTop, 0);
            const finalCard = await page.locator(cardIdentity).boundingBox();
            expect(finalCard).not.toBeNull();
            await assertDrillGeometry(backTrace, finalCard!, info, "back");
            assertDrillIdentityVisible(backTrace, "back");
            const returnFlight = backTrace.frames.filter(frame => frame.target && !identityTransform(frame.targetTransform));
            expect(returnFlight.length, "return must sample the temporary card elevation").toBeGreaterThan(1);
            expect(returnFlight.every(frame => frame.identityHit?.cardFlight && frame.identityHit.cardZIndex === "2"),
              "only the returning card must stay elevated throughout its identity flight").toBe(true);
            await expect(page.locator(".vx-instance-card[data-identity-flight]")).toHaveCount(0);
            await expect(page.locator(cardSelector)).toHaveCSS("z-index", "auto");
          });
        }
      }
    }
  });

  for (const mode of ["lite", "reduced-motion"] as const) {
    test("transitions: drill " + mode + " keeps keyboard focus without shared layout", async ({ page }, info) => {
      if (mode === "reduced-motion") await page.emulateMedia({ reducedMotion: "reduce" });
      await prepare(page, { effects: mode === "lite" ? "lite" : "full" });
      await navigate(page, "library");
      const card = 'article[data-instance-id="fixture-world"]';
      const identity = '.vx-instance-identity[data-identity-kind="instance"][data-identity="fixture-world"]';
      const cardIdentity = card + " " + identity;
      const detailIdentity = ".vx-detail-header " + identity;
      const open = card + " .vx-instance-card__select";
      const back = ".vx-detail-header > button:first-child";
      expect(await page.locator(cardIdentity).getAttribute("data-layout-id")).toBeNull();
      await tabTo(page, open);
      const opened = await capture(page, info, "open", { trigger: open, source: cardIdentity, target: detailIdentity },
        () => page.keyboard.press("Enter"));
      await expect(page.locator(".vx-detail-header h1")).toBeFocused();
      expect(await page.locator(detailIdentity).getAttribute("data-layout-id")).toBeNull();
      await page.keyboard.press("Shift+Tab");
      await expect(page.locator(back)).toBeFocused();
      const returned = await capture(page, info, "back", { trigger: back, source: detailIdentity, target: cardIdentity },
        () => page.keyboard.press("Enter"));
      await expect(page.locator(open)).toBeFocused();
      expect(await page.locator(cardIdentity).getAttribute("data-layout-id")).toBeNull();
      await expect(page.locator(".vx-instance-card[data-identity-flight]")).toHaveCount(0);
      await expect(page.locator(card)).toHaveCSS("z-index", "auto");
      for (const trace of [opened, returned]) {
        expect(trace.sourceAtInput).not.toBeNull();
        const destinationFrames = trace.frames.filter(frame => frame.target !== null);
        expect(destinationFrames.length).toBeGreaterThan(0);
        expect(trace.projectionErrors).toEqual([]);
        expect(trace.projectionWrites.filter(write => !identityTransform(write.transform))).toHaveLength(0);
        expect(destinationFrames.every(frame => identityTransform(frame.targetTransform))).toBe(true);
      }
    });
  }

  test("transitions: drill current-library navigation resets details without restoring the old scroll", async ({ page }, info) => {
    await prepare(page, { instanceCount: 30, versionDirectoryCount: 30 });
    await navigate(page, "library");
    for (const kind of ["instance", "version-directory"] as const) {
      await page.locator(".vx-library-scope button").nth(kind === "instance" ? 0 : 1).click();
      const attribute = kind === "instance" ? "data-instance-id" : "data-version-directory";
      const open = page.locator("article[" + attribute + "] .vx-instance-card__select").nth(24);
      await open.scrollIntoViewIfNeeded();
      expect(await page.locator("#main-content").evaluate(element => element.scrollTop)).toBeGreaterThan(100);
      await open.click();
      await expect(page.locator(".vx-detail-page")).toBeVisible();
      await capture(page, info, kind + "-nav-reset", { trigger: navSelector("library") }, () => page.locator(navSelector("library")).click());
      await expect(page.locator(".vx-library-page")).toBeVisible();
      await expect(page.locator(".vx-detail-page")).toHaveCount(0);
      await expect.poll(() => page.locator("#main-content").evaluate(element => element.scrollTop)).toBe(0);
    }
  });
}
