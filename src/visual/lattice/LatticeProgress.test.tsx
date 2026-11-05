// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LatticeProgress } from "./LatticeProgress";

type Dot = { x: number; y: number; alpha: number; color: string | CanvasGradient | CanvasPattern };
let root: Root;
let container: HTMLDivElement;
let width: number;
let observer: ResizeObserverCallback;
let pixels: Map<HTMLCanvasElement, Dot[]>;
let frames: FrameRequestCallback[];
let measurements: string[];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  width = 320;
  pixels = new Map();
  frames = [];
  measurements = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { observer = callback; }
    observe() {}
    disconnect() {}
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockImplementation(() => { measurements.push("read"); return new DOMRect(0, 0, width, 40); });
  // A real canvas clears its bitmap whenever either dimension is assigned.
  for (const property of ["width", "height"] as const) {
    const setter = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, property)!.set!;
    vi.spyOn(HTMLCanvasElement.prototype, property, "set").mockImplementation(function (this: HTMLCanvasElement, value: number) {
      measurements.push("write");
      setter.call(this, value);
      pixels.set(this, []);
    });
  }
  const contexts = new Map<HTMLCanvasElement, CanvasRenderingContext2D>();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    if (!contexts.has(this)) {
      let point = { x: 0, y: 0 };
      const canvas = this;
      const context = {
        globalAlpha: 1, fillStyle: "", save() {}, restore() {}, scale() {}, beginPath() {},
        clearRect() { pixels.set(canvas, []); },
        arc(x: number, y: number) { point = { x, y }; },
        fill() { pixels.get(canvas)!.push({ ...point, alpha: context.globalAlpha, color: context.fillStyle }); },
      } as unknown as CanvasRenderingContext2D;
      contexts.set(canvas, context);
    }
    return contexts.get(this)!;
  } as never);
  document.documentElement.dataset.effects = "full";
  document.documentElement.dataset.reducedMotion = "false";
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete document.documentElement.dataset.effects;
  delete document.documentElement.dataset.reducedMotion;
  document.documentElement.style.removeProperty("--accent-indicator");
  document.documentElement.style.removeProperty("--accent");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(mode: "lite" | "reduced-motion") {
  if (mode === "lite") document.documentElement.dataset.effects = "lite";
  else document.documentElement.dataset.reducedMotion = "true";
  await act(async () => root.render(createElement(LatticeProgress, { completed: 50, total: 100, label: "Download" })));
  return container.querySelector("canvas")!;
}

function resize(nextWidth: number) {
  width = nextWidth;
  act(() => observer([], {} as ResizeObserver));
}

describe.each(["lite", "reduced-motion"] as const)("static progress under %s", (mode) => {
  it("paints completed dots with the contrast-safe indicator and repaints when it changes", async () => {
    document.documentElement.style.setProperty("--accent", "#b4f17a");
    document.documentElement.style.setProperty("--accent-indicator", "#527b2f");
    const canvas = await render(mode);
    expect(pixels.get(canvas)!.some(dot => dot.alpha === 1 && dot.color === "#527b2f")).toBe(true);
    expect(pixels.get(canvas)!.some(dot => dot.color === "#b4f17a")).toBe(false);
    document.documentElement.style.setProperty("--accent-indicator", "#315f8a");
    await act(async () => { await Promise.resolve(); });
    expect(pixels.get(canvas)!.some(dot => dot.alpha === 1 && dot.color === "#315f8a")).toBe(true);
    expect(frames).toHaveLength(0);
  });

  it("keeps offscreen progress semantics immediately available and paints its bitmap only on entry", async () => {
    let enter!: IntersectionObserverCallback;
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: IntersectionObserverCallback) { enter = callback; }
      observe() {}
      disconnect() {}
    });
    await act(async () => root.render(createElement(LatticeProgress, { completed: 50, total: 100, label: "Offscreen download", animated: false })));
    const canvas = container.querySelector("canvas")!;
    expect(canvas.getAttribute("role")).toBe("progressbar");
    expect(canvas.getAttribute("aria-valuenow")).toBe("50");
    expect(canvas.getAttribute("aria-label")).toBe("Offscreen download");
    expect(pixels.has(canvas)).toBe(false);
    expect(measurements).toEqual([]);
    await act(async () => enter([{ isIntersecting: true, target: canvas, intersectionRatio: 1, time: 0,
      boundingClientRect: new DOMRect(0, 0, width, 32), intersectionRect: new DOMRect(0, 0, width, 32), rootBounds: new DOMRect(0, 0, 1440, 900) }], {} as IntersectionObserver));
    expect(pixels.get(canvas)!.some(dot => dot.alpha > 0)).toBe(true);
    expect(frames).toHaveLength(0);
  });
  it("measures a task list before resizing any bitmap, avoiding per-row forced layout", async () => {
    document.documentElement.dataset.effects = "lite";
    await act(async () => root.render(createElement("div", null,
      Array.from({ length: 3 }, (_, key) => createElement(LatticeProgress, { key, completed: 50, total: 100, label: `Task ${key}` })))));
    expect(measurements.filter(action => action === "read")).toHaveLength(3);
    expect(measurements.lastIndexOf("read")).toBeLessThan(measurements.indexOf("write"));
    for (const canvas of container.querySelectorAll("canvas")) expect(pixels.get(canvas)!.some(dot => dot.alpha > 0)).toBe(true);
  });
  it("uses the current theme accent and repaints when its token changes", async () => {
    document.documentElement.style.setProperty("--accent", "#dc743a");
    document.documentElement.style.setProperty("--text-tertiary", "#77776f");
    await Promise.resolve();
    const canvas = await render(mode);
    expect(pixels.get(canvas)!.some(dot => dot.color === "#dc743a")).toBe(true);
    document.documentElement.style.setProperty("--accent", "#2e83dd");
    await act(async () => { await Promise.resolve(); });
    expect(pixels.get(canvas)!.some(dot => dot.color === "#2e83dd")).toBe(true);
    document.documentElement.style.removeProperty("--accent");
    document.documentElement.style.removeProperty("--text-tertiary");
  });
  it("retains its painted points when ResizeObserver reports the same size", async () => {
    const canvas = await render(mode);
    expect(pixels.get(canvas)!.some((dot) => dot.alpha > 0)).toBe(true);
    resize(320);
    expect(pixels.get(canvas)!.some((dot) => dot.alpha > 0)).toBe(true);
    expect(frames).toHaveLength(0);
  });

  it("paints the resized progress field once without starting an animation loop", async () => {
    const canvas = await render(mode);
    resize(480);
    const points = pixels.get(canvas)!;
    expect(points.some((dot) => dot.alpha > 0)).toBe(true);
    expect(Math.max(...points.map((dot) => dot.x))).toBeGreaterThan(320);
    expect(canvas.getAttribute("aria-valuetext")).toBe("50%");
    expect(frames).toHaveLength(0);
  });
});
