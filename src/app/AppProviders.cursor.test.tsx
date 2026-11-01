// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCursorHalo } from "./AppProviders";

type Preferences = {
  effects: string;
  reducedMotion?: boolean;
  highContrast?: boolean;
};
let root: Root;
let container: HTMLDivElement;
let callbacks: Map<number, FrameRequestCallback>;
let circles: number;
let fine: boolean;
let mediaListeners: Set<() => void>;
let originalMatchMedia: PropertyDescriptor | undefined;

function Harness({
  effects,
  reducedMotion = false,
  highContrast = false,
}: Preferences) {
  useCursorHalo(effects, reducedMotion, highContrast);
  return null;
}

async function render(preferences: Preferences) {
  await act(async () => root.render(createElement(Harness, preferences)));
}

async function moveAndFrame() {
  circles = 0;
  document.body.dispatchEvent(
    new MouseEvent("pointermove", {
      bubbles: true,
      clientX: 400,
      clientY: 300,
    }),
  );
  const pending = [...callbacks.values()];
  callbacks.clear();
  pending.forEach((callback) => callback(16));
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  fine = true;
  circles = 0;
  callbacks = new Map();
  mediaListeners = new Set();
  let nextFrame = 0;
  originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      get matches() {
        return query.includes("pointer: fine") && fine;
      },
      addEventListener: (_: string, callback: () => void) => {
        if (query.includes("pointer: fine")) mediaListeners.add(callback);
      },
      removeEventListener: (_: string, callback: () => void) =>
        mediaListeners.delete(callback),
    })),
  });
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    clearRect: vi.fn(),
    setTransform: vi.fn(),
    beginPath: vi.fn(),
    fill: vi.fn(),
    arc: () => {
      circles += 1;
    },
    globalAlpha: 1,
    fillStyle: "",
  } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callbacks.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
  document.documentElement.dataset.effects = "full";
  document.documentElement.dataset.reducedMotion = "false";
  document.documentElement.dataset.highContrast = "false";
  container = document.createElement("div");
  container.className = "vx-app-body";
  container.dataset.currentPage = "home";
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete document.documentElement.dataset.effects;
  delete document.documentElement.dataset.reducedMotion;
  delete document.documentElement.dataset.highContrast;
  if (originalMatchMedia)
    Object.defineProperty(window, "matchMedia", originalMatchMedia);
  else Reflect.deleteProperty(window, "matchMedia");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("global cursor halo wiring", () => {
  it("keeps the same pointer pool active on Home and after page changes", async () => {
    await render({ effects: "full" });
    const canvas = document.querySelector(".vx-cursor-halo");
    expect(canvas).not.toBeNull();
    await moveAndFrame();
    expect(circles).toBe(31);
    for (const page of ["library", "downloads", "home"]) {
      await act(async () => {
        container.dataset.currentPage = page;
      });
      await moveAndFrame();
      expect(circles).toBe(31);
      expect(document.querySelector(".vx-cursor-halo")).toBe(canvas);
    }
  });

  it.each([
    { effects: "lite" },
    { effects: "full", reducedMotion: true },
    { effects: "full", highContrast: true },
  ])("leaves native feedback available under %j", async (preferences) => {
    await render(preferences);
    await moveAndFrame();
    expect(document.querySelector(".vx-cursor-halo")).toBeNull();
    expect(document.documentElement.hasAttribute("data-cursor-halo")).toBe(
      false,
    );
    expect(callbacks.size).toBe(0);
  });

  it("mounts after a fine pointer becomes available and disposes when it disappears", async () => {
    fine = false;
    await render({ effects: "full" });
    expect(document.querySelector(".vx-cursor-halo")).toBeNull();
    fine = true;
    await act(async () => {
      mediaListeners.forEach((listener) => listener());
    });
    await moveAndFrame();
    expect(circles).toBe(31);
    fine = false;
    await act(async () => {
      mediaListeners.forEach((listener) => listener());
    });
    expect(document.querySelector(".vx-cursor-halo")).toBeNull();
    expect(callbacks.size).toBe(0);
  });
});
