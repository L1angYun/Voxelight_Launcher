// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WORLD_LIGHT_CYCLE_MS,
  WORLD_PARALLAX_DEPTHS,
  WORLD_PARTICLE_BUDGET,
} from "../visual/overture/motion";
import { WorldScene, type WorldSceneState } from "./WorldScene";

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
let originalMatchMedia: PropertyDescriptor | undefined;

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
  vi.spyOn(document, "hidden", "get").mockImplementation(() => pageHidden);
  originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn((media: string) => ({
      get matches() {
        return reducedMotion;
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
  if (originalMatchMedia)
    Object.defineProperty(window, "matchMedia", originalMatchMedia);
  else Reflect.deleteProperty(window, "matchMedia");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WorldScene", () => {
  it("renders an original decorative SVG with the composable scene API", async () => {
    await render(createElement(WorldScene, { className: "home-hero__world" }));
    const element = scene();
    const svg = element.querySelector("svg");
    expect(element.classList.contains("world-scene")).toBe(true);
    expect(element.classList.contains("home-hero__world")).toBe(true);
    expect(element.getAttribute("aria-hidden")).toBe("true");
    expect(element.dataset.sceneState).toBe("idle");
    expect(element.dataset.paused).toBe("false");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 1280 720");
    expect(svg?.querySelectorAll("path, polygon, rect").length).toBeGreaterThan(
      30,
    );
    expect(element.querySelector("button, input, select, text")).toBeNull();
    expect(element.querySelector("animate, animateTransform, set")).toBeNull();
  });

  it("keeps SVG definition IDs unique across multiple instances", async () => {
    await render(
      createElement(
        "div",
        null,
        createElement(WorldScene, { key: "one" }),
        createElement(WorldScene, { key: "two" }),
      ),
    );
    const ids = [...container.querySelectorAll("[id]")].map((node) => node.id);
    expect(ids.length).toBeGreaterThan(4);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("exposes reduced motion and leaves parallax untouched on pointer input", async () => {
    reducedMotion = true;
    await render();
    const element = scene();
    const nearLayer = element.querySelector('[data-parallax="near"]');
    const initialStyle = nearLayer?.getAttribute("style");
    expect(element.dataset.motion).toBe("reduced");
    await act(async () => {
      element.dispatchEvent(
        new MouseEvent("pointermove", {
          bubbles: true,
          clientX: 600,
          clientY: 400,
        }),
      );
    });
    expect(nearLayer?.getAttribute("style")).toBe(initialStyle);
  });

  it("reflects each scene state with a restrained beacon color change", async () => {
    const states: WorldSceneState[] = ["idle", "preparing", "running", "error"];
    const colors = new Set<string | null>();
    for (const state of states) {
      await render(createElement(WorldScene, { state }));
      expect(scene().dataset.sceneState).toBe(state);
      colors.add(
        scene().querySelector("[data-scene-beacon]")?.getAttribute("fill") ??
          null,
      );
    }
    expect(colors.size).toBe(states.length);
    expect(colors.has(null)).toBe(false);
  });

  it("pauses while the document is hidden and resumes when visible", async () => {
    await render();
    expect(scene().dataset.paused).toBe("false");
    pageHidden = true;
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(scene().dataset.paused).toBe("true");
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
    expect(scene().querySelector("svg")).not.toBeNull();
  });

  it("uses the expanded particle budget, deeper parallax, and faster light cycle", async () => {
    await render();
    expect(WORLD_PARTICLE_BUDGET).toEqual({
      fireflies: 32,
      dust: 64,
      total: 96,
    });
    expect(WORLD_PARALLAX_DEPTHS.far).toBeCloseTo(0.264);
    expect(WORLD_PARALLAX_DEPTHS.middle).toBeCloseTo(0.624);
    expect(WORLD_PARALLAX_DEPTHS.character).toBeCloseTo(0.984);
    expect(WORLD_PARALLAX_DEPTHS.foreground).toBeCloseTo(1.2);
    expect(scene().style.getPropertyValue("--world-light-cycle")).toBe(
      `${WORLD_LIGHT_CYCLE_MS}ms`,
    );
  });

  it("renders the layered environment and maps real preparation progress", async () => {
    await render(
      createElement(WorldScene, { state: "preparing", progress: 37 }),
    );
    const element = scene();
    expect(element.dataset.sceneState).toBe("preparing");
    expect(element.dataset.sceneProgress).toBe("37");
    for (const selector of [
      ".world-scene__atmosphere",
      ".world-scene__light-beams",
      ".world-scene__sun-sweep",
      ".world-scene__energy-trail",
      ".world-scene__landmass",
      ".world-scene__beacon-halo",
      ".world-scene__pixel--a",
    ]) {
      expect(element.querySelector(selector)).not.toBeNull();
    }
    const progress = element.querySelector(".world-scene__beacon-progress");
    expect(progress?.getAttribute("data-beacon-progress")).toBe("37");
    expect(progress?.getAttribute("stroke-dashoffset")).toBe("63");
  });

  it("uses a complete ring for running and clamps progress input", async () => {
    await render(createElement(WorldScene, { state: "running", progress: 42 }));
    let progress = scene().querySelector(".world-scene__beacon-progress");
    expect(progress?.getAttribute("data-beacon-progress")).toBe("100");
    expect(progress?.getAttribute("stroke-dashoffset")).toBe("0");

    await render(
      createElement(WorldScene, { state: "preparing", progress: 140 }),
    );
    expect(scene().dataset.sceneProgress).toBe("100");
    progress = scene().querySelector(".world-scene__beacon-progress");
    expect(progress?.getAttribute("stroke-dashoffset")).toBe("0");

    await render(
      createElement(WorldScene, { state: "preparing", progress: -10 }),
    );
    expect(scene().dataset.sceneProgress).toBe("0");
    progress = scene().querySelector(".world-scene__beacon-progress");
    expect(progress?.getAttribute("stroke-dashoffset")).toBe("100");
  });
});
