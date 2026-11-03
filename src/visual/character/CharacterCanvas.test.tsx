// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlayerObject, WalkingAnimation } from "skinview3d";
import { CharacterCanvas } from "./CharacterCanvas";

const { loadSkin, loadCape, viewers, MockViewer, viewerBackend } = vi.hoisted(() => {
  const loadSkin = vi.fn();
  const loadCape = vi.fn();
  const viewers: MockViewer[] = [];
  const viewerBackend = {
    createPlayer: null as unknown as () => import("skinview3d").PlayerObject,
    createClock: null as unknown as () => import("three").Clock,
  };
  class MockViewer {
    disposed = false;
    _disposed = false;
    _renderPaused = true;
    _animation: import("skinview3d").PlayerAnimation | null = null;
    animationID: number | null = null;
    declare renderPaused: boolean;
    autoRotate = false;
    declare animation: import("skinview3d").PlayerAnimation | null;
    declare draw: () => void;
    playerObject: import("skinview3d").PlayerObject;
    clock: import("three").Clock;
    scene = { traverse: vi.fn() };
    controls = {
      enablePan: false,
      enableDamping: false,
      enableRotate: true,
      enableZoom: true,
      minDistance: 30,
      maxDistance: 140,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      update: vi.fn(),
    };
    playerWrapper = { rotation: { x: 0, y: 0, set: vi.fn() }, visible: true };
    camera = { position: { length: () => 60, multiplyScalar: vi.fn() } };
    composer = { dispose: vi.fn() };
    fxaaPass = { material: { dispose: vi.fn() } };
    renderer = { forceContextLoss: vi.fn(), getContext: () => ({ isContextLost: () => false }) };
    constructor(public options: unknown) {
      this.playerObject = viewerBackend.createPlayer();
      this.clock = viewerBackend.createClock();
      viewers.push(this);
    }
    setSize = vi.fn();
    render = vi.fn();
    dispose = vi.fn(() => {
      this.disposed = true;
      this._disposed = true;
    });
    resetCameraPose = vi.fn();
  }
  return { loadSkin, loadCape, viewers, MockViewer, viewerBackend };
});
let rejectNextSkin = false;
let rejectNextCape = false;

vi.mock("skinview3d", async (importOriginal) => {
  const upstream = await importOriginal<typeof import("skinview3d")>();
  const { Clock } = await import("three");
  viewerBackend.createPlayer = () => new upstream.PlayerObject();
  viewerBackend.createClock = () => new Clock();
  // Keep upstream time, pause, and pose reset behavior real; replace only WebGL.
  for (const property of ["animation", "renderPaused", "draw"]) {
    Object.defineProperty(MockViewer.prototype, property, Object.getOwnPropertyDescriptor(upstream.SkinViewer.prototype, property)!);
  }
  return { ...upstream, SkinViewer: MockViewer };
});

vi.mock("../../components/skinTexture", () => ({
  SkinTextureLoader: class {
    load = loadSkin;
    dispose = vi.fn();
  },
  CapeTextureLoader: class {
    load = loadCape;
    dispose = vi.fn();
  },
}));

let root: Root;
let container: HTMLDivElement;
let intersectionCallback: IntersectionObserverCallback | undefined;
let pageHidden = false;
let reducedMotion = false;
let frameTime = 0;
let nextFrameId = 0;
const scheduledFrames = new Map<number, FrameRequestCallback>();

function advanceFrame(milliseconds: number) {
  frameTime += milliseconds;
  const next = scheduledFrames.entries().next().value;
  if (!next) throw new Error("No scheduled character frame");
  scheduledFrames.delete(next[0]);
  next[1](frameTime);
}

async function render(props: Parameters<typeof CharacterCanvas>[0]) {
  await act(async () => {
    root.render(createElement(CharacterCanvas, props));
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  viewers.length = 0;
  rejectNextSkin = false;
  rejectNextCape = false;
  pageHidden = false;
  reducedMotion = false;
  frameTime = 0;
  nextFrameId = 0;
  scheduledFrames.clear();
  vi.spyOn(performance, "now").mockImplementation(() => frameTime);
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
    const id = ++nextFrameId;
    scheduledFrames.set(id, callback);
    return id;
  }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => scheduledFrames.delete(id)));
  vi.spyOn(document, "hidden", "get").mockImplementation(() => pageHidden);
  loadSkin.mockReset();
  loadCape.mockReset();
  loadSkin.mockImplementation(async () => {
    if (rejectNextSkin) throw new Error("damaged skin");
    return true;
  });
  loadCape.mockImplementation(async () => {
    if (rejectNextCape) throw new Error("damaged cape");
    return true;
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({ matches: reducedMotion, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() })),
  });
  intersectionCallback = undefined;
  Object.defineProperty(globalThis, "IntersectionObserver", {
    configurable: true,
    value: class {
      constructor(callback: IntersectionObserverCallback) {
        intersectionCallback = callback;
      }
      observe = vi.fn();
      disconnect = vi.fn();
    },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("CharacterCanvas", () => {
  it("reports an immediate constructor failure once and waits for explicit retry", async () => {
    const construct = vi.spyOn(viewerBackend, "createPlayer").mockImplementation(() => { throw new Error("WebGL unavailable"); });
    const onError = vi.fn();
    const props = { skinUrl: "skin.png", deferMs: 0, label: "Preview", onError };
    await render(props);
    expect(construct).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledExactlyOnceWith("renderer.unavailable");
    expect(container.querySelector("canvas")).toBeNull();

    await render({ ...props, skinUrl: "replacement.png" });
    expect(construct).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();

    construct.mockRestore();
    await act(async () => container.querySelector<HTMLButtonElement>("[data-character-retry]")!.click());
    expect(viewers).toHaveLength(1);
    expect(loadSkin).toHaveBeenCalledExactlyOnceWith("replacement.png", "auto");
    expect(container.querySelector('[data-character-state="ready"]')).not.toBeNull();
  });

  it("defers the WebGL viewer and resource loads until its requested creation delay", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await render({ skinUrl: "skin.png", capeUrl: "cape.png", deferMs: 280, label: "Preview" });
    expect(viewers).toHaveLength(0);
    expect(loadSkin).not.toHaveBeenCalled();
    expect(container.querySelector("canvas")).toBeNull();
    expect(container.querySelector('[data-character-state="loading"]')).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(279));
    expect(viewers).toHaveLength(0);
    await act(async () => vi.advanceTimersByTime(1));
    expect(viewers).toHaveLength(1);
    expect(loadSkin).toHaveBeenCalledExactlyOnceWith("skin.png", "auto");
    expect(loadCape).toHaveBeenCalledWith("cape.png", "cape");
    expect(container.querySelector('[data-character-state="ready"]')).not.toBeNull();
  });

  it("cancels pending creation when its canvas is removed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await render({ skinUrl: "skin.png", deferMs: 280, label: "Preview" });
    await act(async () => vi.advanceTimersByTime(100));
    await act(async () => root.render(null));
    await act(async () => vi.advanceTimersByTime(1000));
    expect(viewers).toHaveLength(0);
    expect(loadSkin).not.toHaveBeenCalled();
  });

  it.each(["skin", "cape"] as const)("restarts only the pending delay when its %s URL changes", async (resource) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const props = { skinUrl: "old-skin.png", capeUrl: "old-cape.png", deferMs: 280, interactive: true, label: "Preview" };
    await render(props);
    await act(async () => vi.advanceTimersByTime(200));
    const next = { ...props, ...(resource === "skin" ? { skinUrl: "new-skin.png" } : { capeUrl: "new-cape.png" }) };
    await render(next);
    await act(async () => vi.advanceTimersByTime(279));
    expect(viewers).toHaveLength(0);
    await act(async () => vi.advanceTimersByTime(1));
    expect(viewers).toHaveLength(1);
    expect(loadSkin).toHaveBeenCalledExactlyOnceWith(next.skinUrl, "auto");
    expect(loadCape).toHaveBeenCalledWith(next.capeUrl, "cape");
    const viewer = viewers[0];
    await render({ ...next, skinUrl: "later-skin.png", capeUrl: "later-cape.png" });
    expect(viewers).toHaveLength(1);
    expect(viewer.disposed).toBe(false);
    expect(loadSkin).toHaveBeenLastCalledWith("later-skin.png", "auto");
    expect(loadCape).toHaveBeenLastCalledWith("later-cape.png", "cape");
  });

  it("cleans StrictMode's first timer and creates one deferred interactive viewer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await act(async () => root.render(createElement(StrictMode, null,
      createElement(CharacterCanvas, { skinUrl: "skin.png", deferMs: 280, interactive: true, label: "Preview" }))));
    expect(viewers).toHaveLength(0);
    await act(async () => vi.advanceTimersByTime(280));
    expect(viewers).toHaveLength(1);
    expect(loadSkin).toHaveBeenCalledExactlyOnceWith("skin.png", "auto");
    expect(container.querySelector("canvas")!.tabIndex).toBe(0);
    expect(viewers[0].autoRotate).toBe(true);
    await act(async () => root.render(null));
    expect(viewers[0].disposed).toBe(true);
    expect(container.querySelector("canvas")).toBeNull();
  });

  it("uses grounded vanilla running proportions without artificial jumping or whole-body lean", async () => {
    await render({ skinUrl: "skin.png", animation: "run", headPointer: { x: 1, y: 1 }, label: "Preview" });
    const viewer = viewers[0];
    const stride = viewer.animation!;
    const player = viewer.playerObject;
    // Independently calculated from vanilla's .6662 limb phase, 1:1.4 arm/leg
    // amplitudes and .05 arm bob at 20 ticks/sec, starting with neutral legs.
    for (const [progress, leftLeg, rightLeg, leftArm, rightArm, spread] of [
      [0, 0, 0, 0, 0, .1],
      [.11789224908397603, 1.4, -1.4, -1.0078659676, 1.0078659676, .0988784331],
      [.23578449816795205, 0, 0, -.0155360377, .0155360377, .0955640490],
      [.3536767472519281, -1.4, 1.4, .9771808084, -.9771808084, .0902055398],
    ]) {
      stride.progress = progress;
      stride.update(player, 0);
      expect(player.skin.leftLeg.rotation.x).toBeCloseTo(leftLeg);
      expect(player.skin.rightLeg.rotation.x).toBeCloseTo(rightLeg);
      expect(player.skin.leftArm.rotation.x).toBeCloseTo(leftArm);
      expect(player.skin.rightArm.rotation.x).toBeCloseTo(rightArm);
      expect(player.skin.leftArm.rotation.z).toBeCloseTo(spread);
      expect(player.skin.rightArm.rotation.z).toBeCloseTo(-spread);
      expect(player.position.length()).toBe(0);
      expect(player.rotation.x).toBe(0);
      expect(player.rotation.z).toBe(0);
      expect(player.skin.head.rotation.x).toBe(0);
      expect(player.skin.head.rotation.y).toBe(0);
    }
    await render({ skinUrl: "skin.png", animation: "run", headPointer: { x: -1, y: -1 }, label: "Preview" });
    stride.update(player, 0);
    expect(player.rotation.x).toBe(0);
    expect(player.skin.head.rotation.x).toBe(0);
    expect(player.skin.head.rotation.y).toBe(0);
  });

  it("applies walking pointer tracking after each native animation frame", async () => {
    await render({ skinUrl: "skin.png", animation: "walk", headPointer: { x: 0.3, y: 0.5 }, label: "Preview" });
    const viewer = viewers[0];
    viewer.animation!.update(viewer.playerObject, 0.1);
    viewer.animation!.update(viewer.playerObject, 0.1);
    expect(viewer.playerObject.skin.head.rotation.x).toBeCloseTo(-0.175);
    expect(viewer.playerObject.skin.head.rotation.y).toBeCloseTo(0.165);
  });

  it("samples a grounded neutral frame when the running mode is selected while paused", async () => {
    await render({ skinUrl: "skin.png", animation: "idle", paused: true, label: "Preview" });
    await render({ skinUrl: "skin.png", animation: "run", paused: true, label: "Preview" });
    const viewer = viewers[0];
    expect(viewer.playerObject.position.length()).toBe(0);
    expect(viewer.playerObject.skin.leftLeg.rotation.x).toBeCloseTo(0);
    expect(viewer.playerObject.rotation.x).toBe(0);
    expect(viewer.playerObject.skin.head.rotation.x).toBe(0);
    expect(viewer.animation!.progress).toBe(0);
    expect(scheduledFrames.size).toBe(0);
  });

  it("keeps the same grounded pose across different frame partitions at equal elapsed time", async () => {
    for (const intervals of [[150], [25, 25, 50, 50]]) {
      await render({ skinUrl: "skin.png", animation: "idle", label: "Preview" });
      await render({ skinUrl: "skin.png", animation: "run", label: "Preview" });
      const viewer = viewers[0];
      advanceFrame(0);
      for (const interval of intervals) advanceFrame(interval);
      // Upstream evaluates the pose before adding delta; sample the resulting progress.
      advanceFrame(0);
      expect(viewer.animation!.progress).toBeCloseTo(0.15);
      expect(viewer.playerObject.skin.leftLeg.rotation.x).toBeCloseTo(1.2738307975);
      expect(viewer.playerObject.skin.rightLeg.rotation.x).toBeCloseTo(-1.2738307975);
      expect(viewer.playerObject.skin.leftArm.rotation.x).toBeCloseTo(-.9198616060);
    }
  });

  it.each(["pause", "reduced motion"])("keeps the head still when pointer events arrive during %s", async (reason) => {
    reducedMotion = reason === "reduced motion";
    const props = { skinUrl: "skin.png", animation: "idle" as const, paused: reason === "pause", label: "Preview" };
    await render({ ...props, headPointer: null });
    const head = viewers[0].playerObject.skin.head;
    const pitch = head.rotation.x;
    const yaw = head.rotation.y;
    await render({ ...props, headPointer: { x: 1, y: -1 } });
    expect(head.rotation.x).toBe(pitch);
    expect(head.rotation.y).toBe(yaw);
    expect(scheduledFrames.size).toBe(0);
  });

  it("uses elapsed seconds and discards paused wall time without restarting the running stride", async () => {
    await render({ skinUrl: "skin.png", animation: "run", label: "Preview" });
    const viewer = viewers[0];
    const stride = viewer.animation!;
    advanceFrame(0);
    advanceFrame(100);
    advanceFrame(50);
    expect(stride.progress).toBeCloseTo(0.15);

    await render({ skinUrl: "skin.png", animation: "run", paused: true, label: "Preview" });
    expect(scheduledFrames.size).toBe(0);
    frameTime += 10_000;
    await render({ skinUrl: "skin.png", animation: "run", paused: false, label: "Preview" });
    advanceFrame(0);
    expect(viewer.animation).toBe(stride);
    expect(stride.progress).toBeCloseTo(0.15);
    advanceFrame(100);
    expect(stride.progress).toBeCloseTo(0.25);
  });

  it("clears running joint offsets when repeatedly switching to walking and idle", async () => {
    for (let repeat = 0; repeat < 3; repeat += 1) {
      await render({ skinUrl: "skin.png", animation: "run", label: "Preview" });
      const viewer = viewers[0];
      viewer.animation!.update(viewer.playerObject, 0.1);
      viewer.animation!.update(viewer.playerObject, 0);
      expect(Math.abs(viewer.playerObject.skin.leftLeg.rotation.x)).toBeGreaterThan(.1);
      await render({ skinUrl: "skin.png", animation: "walk", label: "Preview" });
      expect(viewer.animation).toBeInstanceOf(WalkingAnimation);
      expect(viewer.animation!.progress).toBe(0);
      expect(viewer.playerObject.position.length()).toBe(0);
      expect(viewer.playerObject.rotation.x).toBe(0);
      expect(viewer.playerObject.rotation.z).toBe(0);
      expect(viewer.playerObject.skin.head.rotation.x).toBe(0);
      await render({ skinUrl: "skin.png", animation: "idle", label: "Preview" });
      expect(viewer.playerObject.skin.leftLeg.rotation.x).toBe(0);
      expect(viewer.playerObject.skin.rightLeg.rotation.x).toBe(0);
      expect(viewer.playerObject.position.length()).toBe(0);
    }
  });

  it.each(["walk", "run"] as const)("resumes %s from its current stride after an overture pause", async (animation) => {
    await render({ skinUrl: "skin.png", animation, label: "Preview" });
    const viewer = viewers[0];
    const stride = viewer.animation!;
    const player = new PlayerObject();
    if (animation === "walk") expect(stride).toBeInstanceOf(WalkingAnimation);
    expect(viewer.renderPaused).toBe(false);
    stride.update(player, 0.125);
    const legRotation = player.skin.leftLeg.rotation.x;

    await render({ skinUrl: "skin.png", animation, paused: true, label: "Preview" });
    expect(viewer.renderPaused).toBe(true);
    expect(viewer.animation).toBe(stride);
    expect(viewer.animation?.progress).toBe(0.125);

    await render({ skinUrl: "skin.png", animation, paused: false, label: "Preview" });
    expect(viewer.renderPaused).toBe(false);
    expect(viewer.animation).toBe(stride);
    viewer.animation!.update(player, 0.125);
    expect(viewer.animation?.progress).toBe(0.25);
    expect(player.skin.leftLeg.rotation.x).not.toBe(legRotation);
  });

  it("preserves a walking stride across document and viewport visibility changes", async () => {
    await render({ skinUrl: "skin.png", animation: "walk", label: "Preview" });
    const viewer = viewers[0];
    const stride = viewer.animation!;
    stride.update(new PlayerObject(), 0.125);

    pageHidden = true;
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(viewer.renderPaused).toBe(true);
    expect(viewer.animation).toBe(stride);
    expect(viewer.animation?.progress).toBe(0.125);

    pageHidden = false;
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(viewer.renderPaused).toBe(false);
    await act(async () => intersectionCallback?.([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(viewer.renderPaused).toBe(true);
    expect(viewer.animation).toBe(stride);
    await act(async () => intersectionCallback?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(viewer.renderPaused).toBe(false);
    expect(viewer.animation).toBe(stride);
    expect(viewer.animation?.progress).toBe(0.125);
  });

  it.each(["walk", "run"] as const)("keeps requested %s static with reduced motion", async (animation) => {
    reducedMotion = true;
    await render({ skinUrl: "skin.png", animation, interactive: true, autoRotate: true, label: "Preview" });
    expect(viewers[0].animation).toBeNull();
    expect(viewers[0].autoRotate).toBe(false);
    expect(viewers[0].renderPaused).toBe(true);
  });

  it("loads the selected skin and cape with accessible manual controls", async () => {
    await render({ skinUrl: "skin.png", capeUrl: "cape.png", model: "slim", interactive: true, label: "Account skin" });
    expect(loadSkin).toHaveBeenCalledWith("skin.png", "slim");
    expect(loadCape).toHaveBeenCalledWith("cape.png", "cape");
    const canvas = container.querySelector("canvas")!;
    expect(canvas.getAttribute("aria-label")).toBe("Account skin");
    expect(canvas.tabIndex).toBe(0);
    expect(viewers[0].autoRotate).toBe(true);
  });

  it("pauses rendering and reports damaged resources with a retry path", async () => {
    const onError = vi.fn();
    rejectNextSkin = true;
    await render({ skinUrl: "broken.png", paused: true, label: "Preview", onError });
    expect(onError).toHaveBeenCalledWith("damaged skin");
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    rejectNextSkin = false;
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-character-retry]')!.click();
    });
    expect(loadSkin).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(viewers.at(-1)?.renderPaused).toBe(true);
  });

  it("pauses offscreen rendering and resumes without changing preferences", async () => {
    await render({ skinUrl: "skin.png", interactive: true, autoRotate: true, animation: "walk", label: "Preview" });
    const viewer = viewers[0];
    expect(viewer.renderPaused).toBe(false);
    await act(async () => intersectionCallback?.([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(viewer.renderPaused).toBe(true);
    expect(viewer.autoRotate).toBe(true);
    await act(async () => intersectionCallback?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(viewer.renderPaused).toBe(false);
    expect(viewer.autoRotate).toBe(true);
  });

  it("clears a valid skin and cape when a later resource fails", async () => {
    await render({ skinUrl: "valid-skin.png", capeUrl: "valid-cape.png", label: "Preview" });
    const viewer = viewers[0];
    expect(viewer.playerWrapper.visible).toBe(true);

    rejectNextSkin = true;
    rejectNextCape = true;
    await render({ skinUrl: "broken-skin.png", capeUrl: "broken-cape.png", label: "Preview" });

    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(viewer.playerWrapper.visible).toBe(false);
    expect(loadCape).toHaveBeenCalledWith(null, "cape");
  });
});
