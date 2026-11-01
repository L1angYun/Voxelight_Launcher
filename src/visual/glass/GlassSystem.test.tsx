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

  it("renders full local optics on demand and stops after every published pose", () => {
    const callbacks = new Map<number, (time: number) => void>();
    let id = 0;
    const scheduler = createGlassScheduler(() => {}, {
      requestFrame: callback => { callbacks.set(++id, callback); return id; },
      cancelFrame: frame => { callbacks.delete(frame); },
      continuous: false,
    });
    const advance = () => {
      const [frame, callback] = [...callbacks][0]; callbacks.delete(frame); callback(16);
    };
    scheduler.setQuality("full");
    advance();
    expect(scheduler.frameCount).toBe(1);
    expect(scheduler.pending).toBe(false);
    scheduler.request(); scheduler.request();
    expect(callbacks.size).toBe(1);
    advance();
    expect(scheduler.frameCount).toBe(2);
    expect(scheduler.pending).toBe(false);
    scheduler.dispose();
  });
});

describe("glass provider surfaces", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    vi.mocked(createGlassRenderer).mockReturnValue(renderer);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("gives measured surfaces independent curvature maps instead of shared noise", async () => {
    vi.mocked(createGlassRenderer).mockReturnValue({ ...renderer, mode: "full" });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 220, bottom: 100, width: 220, height: 100, toJSON() {},
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }),
      putImageData() {},
    } as never);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,curvature");
    await act(async () => {
      root.render(
        createElement(
          GlassProvider,
          null,
          createElement(GlassSurface, { variant: "nav", id: "main-nav" }, "Navigation"),
          createElement(GlassSurface, { id: "second" }, "Launch"),
        ),
      );
    });
    const surfaces = Array.from(container.querySelectorAll<HTMLElement>("[data-glass-refraction='curvature']"));
    expect(surfaces).toHaveLength(2);
    const firstFilter = surfaces[0].querySelector("filter")!;
    const secondFilter = surfaces[1].querySelector("filter")!;
    expect(firstFilter.id).not.toBe(secondFilter.id);
    expect(firstFilter.getAttribute("width")).toBe("220");
    expect(firstFilter.getAttribute("height")).toBe("100");
    expect(surfaces[0].style.getPropertyValue("--vx-glass-refraction")).toBe(`url("#${firstFilter.id}")`);
    expect(firstFilter.querySelector("feImage")?.getAttribute("href")).toBe("data:image/png;base64,curvature");
    expect(firstFilter.querySelector("feDisplacementMap")?.getAttribute("in")).toBe("SourceGraphic");
    expect(container.querySelector("feTurbulence")).toBeNull();
  });

  it("does not present a supplied procedural image as the actual page backdrop", async () => {
    const procedural = document.createElement("canvas");
    await act(async () => root.render(createElement(GlassProvider, { background: procedural },
      createElement(GlassSurface, { id: "live-backdrop" }, "Launch"))));
    expect(renderer.setBackground).toHaveBeenLastCalledWith(null);
  });

  it("regenerates the field on layout resize while reusing it for unchanged reports", async () => {
    vi.mocked(createGlassRenderer).mockReturnValue({ ...renderer, mode: "full" });
    let width = 220;
    const reports: { target?: Element; callback: () => void }[] = [];
    vi.stubGlobal("ResizeObserver", class {
      report: { target?: Element; callback: () => void };
      constructor(callback: () => void) { this.report = { callback }; reports.push(this.report); }
      observe(target: Element) { this.report.target = target; }
      disconnect() {}
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
      x: 0, y: 0, top: 0, left: 0, right: width, bottom: 100, width, height: 100, toJSON() {},
    }));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData() {},
    } as never);
    const encode = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL")
      .mockImplementation(function (this: HTMLCanvasElement) { return `data:image/png;base64,${this.width}`; });
    await act(async () => root.render(createElement(GlassProvider, null,
      createElement(GlassSurface, { id: "resizable" }, "Launch"))));
    const surface = container.querySelector<HTMLElement>(".vx-glass-surface")!;
    expect(surface.querySelector("filter")?.getAttribute("width")).toBe("220");
    const initialEncodes = encode.mock.calls.length;
    await act(async () => reports.filter((report) => report.target === surface).forEach((report) => report.callback()));
    expect(encode.mock.calls).toHaveLength(initialEncodes);
    width = 360;
    await act(async () => reports.filter((report) => report.target === surface).forEach((report) => report.callback()));
    expect(surface.querySelector("filter")?.getAttribute("width")).toBe("360");
    expect(surface.querySelector("feImage")?.getAttribute("href")).toBe("data:image/png;base64,360");
  });

  it("removes live clipping and color separation in fallback and restores the same lens on return", async () => {
    vi.mocked(createGlassRenderer).mockReturnValue({ ...renderer, mode: "full" });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 44, width: 100, height: 44, toJSON() {},
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {},
    } as never);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,curvature");
    const view = (reducedTransparency: boolean) => createElement(GlassProvider, { reducedTransparency },
      createElement(GlassSurface, { id: "preference-switch" }, "Launch"));
    await act(async () => root.render(view(false)));
    const surface = container.querySelector<HTMLElement>(".vx-glass-surface")!;
    const clip = surface.style.clipPath;
    expect(clip).not.toBe("");
    expect(surface.querySelectorAll("feDisplacementMap")).toHaveLength(3);
    await act(async () => root.render(view(true)));
    expect(surface.style.clipPath).toBe("");
    expect(surface.querySelector("feDisplacementMap")).toBeNull();
    await act(async () => root.render(view(false)));
    expect(surface.style.clipPath).toBe(clip);
    expect(surface.querySelectorAll("feDisplacementMap")).toHaveLength(3);
  });

  it.each([
    { effects: "lite" as const },
    { reducedTransparency: true },
    { highContrast: true },
  ])("does not allocate curvature maps when simpler rendering is required: %o", async (preferences) => {
    vi.mocked(createGlassRenderer).mockReturnValue({ ...renderer, mode: "full" });
    const encode = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL");
    await act(async () => root.render(createElement(GlassProvider, preferences,
      createElement(GlassSurface, { id: "accessible" }, "Launch"))));
    expect(container.querySelector(".vx-glass-surface")?.getAttribute("data-glass-refraction")).toBe("none");
    expect(container.querySelector("feImage")).toBeNull();
    expect(encode).not.toHaveBeenCalled();
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

  it("requests optical work from a spring publisher without feeding back its own field styles", async () => {
    await act(async () => root.render(createElement(GlassProvider, null,
      createElement("div", { className: "spring-publisher" }, createElement(GlassSurface, { id: "moving" }, "Launch")))));
    renderer.update.mockClear();
    const publisher = container.querySelector<HTMLElement>(".spring-publisher")!;
    await act(async () => { publisher.style.setProperty("--jelly-press", "0.8"); await Promise.resolve(); });
    expect(renderer.update).toHaveBeenCalled();
    renderer.update.mockClear();
    await act(async () => {
      container.querySelector<HTMLElement>(".vx-glass-surface")!.style.setProperty("--vx-lens-pressure", "0.8");
      await Promise.resolve();
    });
    expect(renderer.update).not.toHaveBeenCalled();
  });
});
