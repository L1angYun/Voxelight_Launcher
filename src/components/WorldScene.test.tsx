// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORLD_PARTICLE_BUDGET } from "../visual/overture/motion";
import {
  CUBE_ACTIVE_BUDGET,
  CUBE_ACTIVE_BUDGET as ACTIVE_BUDGET_ALIAS,
  CUBE_FLIP_DURATION_MS,
  CUBE_GLOW_DURATION_MS,
  CUBE_GLOW_RADIUS_PX,
  CUBE_PITCH_PX,
  CUBE_SIDE_WIDTH,
  CUBE_SIZE_PX,
  CUBE_STAY_DURATION_MS,
  CUBE_TOP_HEIGHT,
  CUBE_TRIGGER_DISTANCE_PX,
  CUBE_TRIGGER_RADIUS_PX,
  POINTER_SPRING,
  WorldScene,
  type WorldSceneState,
} from "./WorldScene";

type ObserverMock = {
  callback: IntersectionObserverCallback;
  observe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
};

let container: HTMLDivElement;
let root: Root | undefined;
let observers: ObserverMock[];
let pageHidden = false;
let reducedMotion = false;
let finePointer = true;
let originalMatchMedia: PropertyDescriptor | undefined;
let context: CanvasRenderingContext2D;

function createCanvasContext() {
  const gradient = () => ({ addColorStop: vi.fn() });
  return {
    arc: vi.fn(),
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    closePath: vi.fn(),
    createLinearGradient: vi.fn(gradient),
    createRadialGradient: vi.fn(gradient),
    fill: vi.fn(),
    fillRect: vi.fn(),
    lineTo: vi.fn(),
    moveTo: vi.fn(),
    restore: vi.fn(),
    rotate: vi.fn(),
    save: vi.fn(),
    setTransform: vi.fn(),
    stroke: vi.fn(),
    translate: vi.fn(),
    fillStyle: "",
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    lineWidth: 1,
    shadowBlur: 0,
    shadowColor: "",
    strokeStyle: "",
  } as unknown as CanvasRenderingContext2D;
}

function installIntersectionObserver() {
  observers = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      callback: IntersectionObserverCallback;
      observe = vi.fn();
      disconnect = vi.fn();
      unobserve = vi.fn();
      takeRecords = vi.fn(() => []);

      constructor(callback: IntersectionObserverCallback) {
        this.callback = callback;
        observers.push(this);
      }
    },
  );
}

async function render(node: ReactNode = createElement(WorldScene)) {
  await act(async () => {
    root?.render(node);
  });
}

function scene() {
  const element = container.querySelector<HTMLElement>(".world-scene");
  if (!element) throw new Error("Missing world scene");
  return element;
}

function canvas(className: string) {
  const element = scene().querySelector<HTMLCanvasElement>(`.${className}`);
  if (!element) throw new Error(`Missing ${className}`);
  return element;
}

function intersect(isIntersecting: boolean) {
  const observer = observers[0];
  if (!observer) throw new Error("Missing intersection observer");
  act(() => {
    observer.callback(
      [{ isIntersecting } as IntersectionObserverEntry],
      observer as unknown as IntersectionObserver,
    );
  });
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  pageHidden = false;
  reducedMotion = false;
  finePointer = true;
  context = createCanvasContext();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as never,
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 960,
    bottom: 540,
    width: 960,
    height: 540,
    toJSON: () => ({}),
  });
  vi.spyOn(document, "hidden", "get").mockImplementation(() => pageHidden);
  originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn((media: string) => ({
      get matches() {
        return media.includes("pointer: fine") ? finePointer : reducedMotion;
      },
      media,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    })),
  });
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((_callback: FrameRequestCallback) => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  installIntersectionObserver();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) {
    const currentRoot = root;
    root = undefined;
    await act(async () => currentRoot.unmount());
  }
  container.remove();
  if (originalMatchMedia) {
    Object.defineProperty(window, "matchMedia", originalMatchMedia);
  } else {
    Reflect.deleteProperty(window, "matchMedia");
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WorldScene", () => {
  it("renders the three-layer cube optical field with the composable scene API", async () => {
    await render(createElement(WorldScene, { className: "home-hero__world" }));
    const element = scene();
    expect(element.classList.contains("world-scene")).toBe(true);
    expect(element.classList.contains("home-hero__world")).toBe(true);
    expect(element.getAttribute("aria-hidden")).toBe("true");
    expect(element.dataset.sceneState).toBe("idle");
    expect(element.dataset.paused).toBe("false");
    expect(element.querySelector("svg")).toBeNull();
    expect(element.querySelectorAll("canvas")).toHaveLength(3);
    expect(element.querySelector(".world-scene__camera")).not.toBeNull();
    expect(canvas("world-scene__cube-canvas").dataset.rendered).toBe("true");
    expect(canvas("world-scene__glow-canvas").dataset.rendered).toBe("true");
    expect(canvas("world-scene__particle-canvas").dataset.rendered).toBe(
      "true",
    );
    expect(context.clearRect).toHaveBeenCalled();
    expect(context.fillRect).toHaveBeenCalled();
    expect(context.stroke).toHaveBeenCalled();
    expect(element.querySelector("button, input, select, text")).toBeNull();
  });

  it("keeps camera, state, progress, cube, and particle contracts", async () => {
    const onCameraFrame = vi.fn();
    const states: WorldSceneState[] = ["idle", "preparing", "running", "error"];

    for (const state of states) {
      await render(
        createElement(WorldScene, {
          state,
          progress: 37,
          onCameraFrame,
        }),
      );
      expect(scene().dataset.sceneState).toBe(state);
      expect(scene().dataset.sceneProgress).toBe("37");
    }

    expect(onCameraFrame).toHaveBeenCalled();
    const pose = onCameraFrame.mock.calls.at(-1)?.[0];
    expect(pose.x).toBeGreaterThanOrEqual(-1);
    expect(pose.x).toBeLessThanOrEqual(1);
    expect(pose.y).toBeGreaterThanOrEqual(-1);
    expect(pose.y).toBeLessThanOrEqual(1);
    expect(pose.scale).toBeGreaterThanOrEqual(1);
    expect(WORLD_PARTICLE_BUDGET).toEqual({
      fireflies: 32,
      dust: 64,
      total: 96,
    });
    expect(CUBE_SIZE_PX).toBe(24);
    expect(CUBE_PITCH_PX).toBe(40);
    expect(CUBE_PITCH_PX).toBeGreaterThan(
      CUBE_SIZE_PX + CUBE_SIDE_WIDTH * 2 + 2,
    );
    expect(CUBE_PITCH_PX).toBeGreaterThan(CUBE_TOP_HEIGHT + CUBE_SIZE_PX + 2);
    expect(CUBE_ACTIVE_BUDGET).toBe(50);
    expect(ACTIVE_BUDGET_ALIAS).toBe(CUBE_ACTIVE_BUDGET);
    expect(CUBE_FLIP_DURATION_MS).toBe(280);
    expect(CUBE_STAY_DURATION_MS).toBe(1800);
    expect(CUBE_GLOW_RADIUS_PX).toBe(10);
    expect(CUBE_GLOW_DURATION_MS).toBe(800);
    expect(CUBE_TRIGGER_RADIUS_PX).toBe(72);
    expect(CUBE_TRIGGER_DISTANCE_PX).toBe(8);
    expect(POINTER_SPRING).toEqual({ stiffness: 90, damping: 13 });
    expect(scene().dataset.particleBudget).toBe("96");
    expect(scene().dataset.cubePitch).toBe("40");
    expect(scene().dataset.cubeActiveBudget).toBe("50");
    expect(scene().dataset.cubeFlipDuration).toBe("280");
    expect(scene().dataset.cubeStayDuration).toBe("1800");
    expect(scene().dataset.cubeTriggerRadius).toBe("72");
    expect(scene().dataset.cubeTriggerDistance).toBe("8");
    expect(scene().dataset.cubeRotation).toBe("true");
    expect(scene().dataset.cubeRotationRpmMin).toBe("0.18");
    expect(scene().dataset.cubeRotationRpmMax).toBe("0.26");
  });

  it("clamps preparation progress", async () => {
    await render(
      createElement(WorldScene, { state: "preparing", progress: 140 }),
    );
    expect(scene().dataset.sceneProgress).toBe("100");

    await render(
      createElement(WorldScene, { state: "preparing", progress: -10 }),
    );
    expect(scene().dataset.sceneProgress).toBe("0");
  });

  it("tracks fine-pointer activity on the scene root and clears on leave", async () => {
    await render();
    expect(scene().dataset.pointerFine).toBe("true");
    await act(async () => {
      scene().dispatchEvent(
        new MouseEvent("pointermove", {
          bubbles: true,
          clientX: 480,
          clientY: 270,
        }),
      );
    });
    expect(scene().dataset.pointerActive).toBe("true");
    await act(async () => {
      scene().dispatchEvent(new MouseEvent("pointerleave", { bubbles: true }));
    });
    expect(scene().dataset.pointerActive).toBe("false");
  });

  it("flips a limited set of cubes under the smoothed pointer", async () => {
    await render();
    await act(async () => {
      scene().dispatchEvent(
        new MouseEvent("pointermove", {
          bubbles: true,
          clientX: 480,
          clientY: 270,
        }),
      );
    });
    const frame = vi.mocked(requestAnimationFrame).mock.calls.at(-1)?.[0];
    expect(frame).toBeTypeOf("function");
    await act(async () => {
      frame?.(16);
    });
    const activeFlips = Number(scene().dataset.activeFlips);
    expect(activeFlips).toBeGreaterThan(0);
    expect(activeFlips).toBeLessThanOrEqual(CUBE_ACTIVE_BUDGET);
  });

  it("pauses while the document is hidden and resumes when visible", async () => {
    await render();
    expect(scene().dataset.paused).toBe("false");
    expect(requestAnimationFrame).toHaveBeenCalled();
    pageHidden = true;
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(scene().dataset.paused).toBe("true");
    expect(cancelAnimationFrame).toHaveBeenCalled();
    pageHidden = false;
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(scene().dataset.paused).toBe("false");
  });

  it("pauses offscreen and disconnects its observer on unmount", async () => {
    await render();
    expect(observers).toHaveLength(1);
    expect(observers[0].observe).toHaveBeenCalledWith(scene());
    intersect(false);
    expect(scene().dataset.paused).toBe("true");
    intersect(true);
    expect(scene().dataset.paused).toBe("false");
    const currentRoot = root;
    root = undefined;
    await act(async () => currentRoot?.unmount());
    expect(observers[0].disconnect).toHaveBeenCalledTimes(1);
  });

  it("keeps an explicit pause when the scene re-enters the viewport", async () => {
    await render(createElement(WorldScene, { paused: true }));
    expect(scene().dataset.paused).toBe("true");
    intersect(false);
    intersect(true);
    expect(scene().dataset.paused).toBe("true");
    await render(createElement(WorldScene, { paused: false }));
    expect(scene().dataset.paused).toBe("false");
  });

  it("stays usable when IntersectionObserver is unavailable", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    await render();
    expect(scene().dataset.paused).toBe("false");
    expect(canvas("world-scene__cube-canvas")).not.toBeNull();
  });

  it("repaints cached cube colours when the document theme changes", async () => {
    await render();
    const fillCalls = vi.mocked(context.fillRect).mock.calls.length;
    await act(async () => {
      document.documentElement.dataset.theme = "light";
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(vi.mocked(context.fillRect).mock.calls.length).toBeGreaterThan(
      fillCalls,
    );
  });

  it("draws one static cube frame without starting a loop for reduced motion", async () => {
    reducedMotion = true;
    await render();
    expect(scene().dataset.motion).toBe("reduced");
    expect(canvas("world-scene__cube-canvas").dataset.rendered).toBe("true");
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });
});
