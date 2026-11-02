// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LatticeProgress } from "./LatticeProgress";

type Dot = { x: number; y: number; alpha: number };
let root: Root;
let container: HTMLDivElement;
let width: number;
let observer: ResizeObserverCallback;
let pixels: Map<HTMLCanvasElement, Dot[]>;
let frames: FrameRequestCallback[];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  width = 320;
  pixels = new Map();
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { observer = callback; }
    observe() {}
    disconnect() {}
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 0, width, 40));
  // A real canvas clears its bitmap whenever either dimension is assigned.
  for (const property of ["width", "height"] as const) {
    const setter = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, property)!.set!;
    vi.spyOn(HTMLCanvasElement.prototype, property, "set").mockImplementation(function (this: HTMLCanvasElement, value: number) {
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
        fill() { pixels.get(canvas)!.push({ ...point, alpha: context.globalAlpha }); },
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function render(mode: "lite" | "reduced-motion") {
  if (mode === "lite") document.documentElement.dataset.effects = "lite";
  else document.documentElement.dataset.reducedMotion = "true";
  act(() => root.render(createElement(LatticeProgress, { completed: 50, total: 100, label: "Download" })));
  return container.querySelector("canvas")!;
}

function resize(nextWidth: number) {
  width = nextWidth;
  act(() => observer([], {} as ResizeObserver));
}

describe.each(["lite", "reduced-motion"] as const)("static progress under %s", (mode) => {
  it("retains its painted points when ResizeObserver reports the same size", () => {
    const canvas = render(mode);
    expect(pixels.get(canvas)!.some((dot) => dot.alpha > 0)).toBe(true);
    resize(320);
    expect(pixels.get(canvas)!.some((dot) => dot.alpha > 0)).toBe(true);
    expect(frames).toHaveLength(0);
  });

  it("paints the resized progress field once without starting an animation loop", () => {
    const canvas = render(mode);
    resize(480);
    const points = pixels.get(canvas)!;
    expect(points.some((dot) => dot.alpha > 0)).toBe(true);
    expect(Math.max(...points.map((dot) => dot.x))).toBeGreaterThan(320);
    expect(canvas.getAttribute("aria-valuetext")).toBe("50%");
    expect(frames).toHaveLength(0);
  });
});
