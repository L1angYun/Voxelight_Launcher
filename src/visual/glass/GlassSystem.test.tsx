// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGlassRenderer, createGlassScheduler, resolveGlassMode } from "./renderer";
import { GlassProvider, GlassSurface } from "./GlassSystem";

const renderer = {
  mode: "fallback" as const,
  surfaceCount: 0,
  upsert: vi.fn(),
  remove: vi.fn(),
  resize: vi.fn(),
  update: vi.fn(),
  setQuality: vi.fn(),
  setBackground: vi.fn(),
  pause: vi.fn(),
  dispose: vi.fn(),
};

vi.mock("./renderer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./renderer")>()),
  createGlassRenderer: vi.fn(() => renderer),
}));

describe("glass capability and scheduling", () => {
  it("uses a static fallback without changing the requested level", () => {
    expect(resolveGlassMode({ webgl2: false, effects: "full" })).toBe("fallback");
    expect(resolveGlassMode({ webgl2: true, effects: "full", reducedTransparency: true })).toBe("fallback");
    expect(resolveGlassMode({ webgl2: true, effects: "full", highContrast: true })).toBe("fallback");
    expect(resolveGlassMode({ webgl2: true, effects: "lite" })).toBe("lite");
    expect(resolveGlassMode({ webgl2: true, effects: "full" })).toBe("full");
  });

  it("does not run an idle Lite loop and pauses both levels", () => {
    const callbacks = new Map<number, (time: number) => void>();
    const cancelled: number[] = [];
    let nextId = 0;
    const scheduler = createGlassScheduler(() => {}, {
      requestFrame: (callback) => {
        const id = ++nextId;
        callbacks.set(id, callback);
        return id;
      },
      cancelFrame: (id) => {
        cancelled.push(id);
        callbacks.delete(id);
      },
    });
    scheduler.setQuality("lite");
    scheduler.request();
    expect(callbacks.size).toBe(1);
    const liteFrame = callbacks.keys().next().value!;
    const callback = callbacks.get(liteFrame)!;
    callbacks.delete(liteFrame);
    callback(0);
    expect(scheduler.frameCount).toBe(1);
    expect(scheduler.pending).toBe(false);
    expect(callbacks.size).toBe(0);
    scheduler.setQuality("full");
    expect(callbacks.size).toBe(1);
    scheduler.pause(true);
    expect(cancelled.length).toBeGreaterThan(0);
    expect(callbacks.size).toBe(0);
    scheduler.pause(false);
    expect(callbacks.size).toBe(1);
    scheduler.dispose();
    expect(callbacks.size).toBe(0);
  });
});

describe("glass provider surfaces", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("registers each surface once and unregisters it on removal", async () => {
    await act(async () => {
      root.render(
        createElement(
          GlassProvider,
          null,
          createElement(GlassSurface, { variant: "nav", id: "main-nav" }, "Navigation"),
        ),
      );
    });
    expect(renderer.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ id: "main-nav", variant: "nav" }),
    );
    await act(async () => root.unmount());
    expect(renderer.remove).toHaveBeenCalledWith("main-nav");
    expect(renderer.dispose).toHaveBeenCalledTimes(1);
    root = createRoot(container);
  });

  it("keeps the DOM usable when WebGL2 is unavailable", async () => {
    const canvas = document.createElement("canvas");
    canvas.getContext = vi.fn(() => null) as typeof canvas.getContext;
    const actual = await vi.importActual<typeof import("./renderer")>("./renderer");
    const fallback = actual.createGlassRenderer(canvas);
    expect(fallback.mode).toBe("fallback");
    fallback.upsert({ id: "surface", rect: { x: 0, y: 0, width: 20, height: 20 }, radius: 8, variant: "control", active: true, opacity: 1 });
    expect(fallback.surfaceCount).toBe(1);
    fallback.remove("surface");
    expect(fallback.surfaceCount).toBe(0);
    fallback.dispose();
  });

  it("does not remove and register unchanged surfaces on a parent render", async () => {
    const render = (text: string) => createElement(GlassProvider, null,
      createElement(GlassSurface, { id: "stable" }, text));
    await act(async () => root.render(render("First")));
    renderer.remove.mockClear();
    await act(async () => root.render(render("Second")));
    expect(renderer.remove).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Second");
  });

  it("moves the optical surface with a scrolling ancestor", async () => {
    await act(async () => root.render(createElement(GlassProvider, { effects: "lite" },
      createElement("main", null, createElement(GlassSurface, { id: "scrolling" }, "Launch")))));
    const surface = container.querySelector(".vx-glass-surface")!;
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue({
      x: 10, y: 40, top: 40, left: 10, right: 210, bottom: 100, width: 200, height: 60, toJSON() {},
    });
    renderer.upsert.mockClear();
    await act(async () => container.querySelector("main")!.dispatchEvent(new Event("scroll")));
    expect(renderer.upsert).toHaveBeenCalledWith(expect.objectContaining({
      id: "scrolling", rect: expect.objectContaining({ x: 10, y: 40 }),
    }));
  });

  it("does not restart motion after visibility changes with reduced motion enabled", async () => {
    await act(async () => root.render(createElement(GlassProvider, { reducedMotion: true },
      createElement(GlassSurface, { id: "quiet" }, "Launch"))));
    renderer.pause.mockClear();
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(renderer.pause).not.toHaveBeenLastCalledWith(false);
  });
});
