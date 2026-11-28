// @vitest-environment jsdom
import { StrictMode, act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AmbientPalette } from "../../design/ambientPresets";
import {
  DRIFT_ORBIT_PERIODS_S,
  DRIFT_PERIODS_S,
  DRIFT_Y_RATE,
  PEAK_ALPHA,
  computeAmbientCanvasSize,
  computeFieldStates,
  createAmbientController,
  getActiveAmbientController,
  getAmbientBusyness,
  subscribeAmbientState,
} from "./ambientController";
import { AmbientLayer, AmbientOverlay } from "./AmbientLayer";

const PALETTE: AmbientPalette = ["#149ac2", "#6969be", "#90502b", "#8c5895"];
const LIGHT_PALETTE: AmbientPalette = ["#3585c9", "#027c91", "#7a5aa8", "#a0603a"];

/** The alpha each sprite was drawn with, in draw order. */
function recordAlphas(ctx: ReturnType<typeof createMockCanvasContext>): number[] {
  const alphas: number[] = [];
  ctx.drawImage.mockImplementation(() => {
    alphas.push(ctx.globalAlpha);
  });
  return alphas;
}

/** Field 0's alpha at `timeMs` for the given peaks (1440x900, intensity 0.6). */
function fieldZeroAlpha(timeMs: number, theme: "dark" | "light", peaks: readonly [number, number, number, number]) {
  return computeFieldStates(timeMs, 1440, 900, { enabled: true, theme, palette: PALETTE, intensity: 0.6 }, peaks)[0].alpha;
}

/** `peaks` with field 0 replaced, as a --ambient-peak-0 override gives it. */
function withPeak0(peaks: readonly [number, number, number, number], value: number): readonly [number, number, number, number] {
  return [value, peaks[1], peaks[2], peaks[3]];
}

/** Five slow frames per tier walk the adaptive tier 30 -> 20 -> 12 -> 0. */
function driveToFrozenTier(ctrl: ReturnType<typeof createAmbientController>, clock: { now: number }) {
  for (let frame = 0; frame < 15; frame++) {
    clock.now += 100;
    ctrl.drawAt(clock.now);
  }
}

function createMockCanvasContext() {
  return {
    globalCompositeOperation: "source-over",
    globalAlpha: 1,
    fillStyle: "",
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    scale: vi.fn(),
    drawImage: vi.fn(),
    createRadialGradient: vi.fn(() => ({
      addColorStop: vi.fn(),
    })),
  };
}

describe("ambientController", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("computes clamped canvas dimensions at DPR=1", () => {
    expect(computeAmbientCanvasSize(1440, 900)).toEqual({ width: 240, height: 150 });
    expect(computeAmbientCanvasSize(800, 600)).toEqual({ width: 240, height: 180 });
    expect(computeAmbientCanvasSize(3840, 2160)).toEqual({ width: 480, height: 270 });
    expect(computeAmbientCanvasSize(1920, 400)).toEqual({ width: 320, height: 135 });
  });

  it("uses 3 fields below 1200px and 4 fields at >= 1200px", () => {
    const config = {
      enabled: true,
      theme: "dark" as const,
      palette: PALETTE,
      intensity: 0.6,
    };
    expect(computeFieldStates(1000, 1199, 800, config)).toHaveLength(3);
    expect(computeFieldStates(1000, 1200, 800, config)).toHaveLength(4);
  });

  it("retraces each field's whole drift path after its orbit period, not after one drift period", () => {
    for (const theme of ["dark", "light"] as const) {
      const config = { enabled: true, theme, palette: PALETTE, intensity: 0.6 };
      const at = (seconds: number) => computeFieldStates(seconds * 1000, 1440, 900, config);
      DRIFT_ORBIT_PERIODS_S.forEach((orbit, index) => {
        // The y drift turns 3 times while the x drift turns 4 times.
        expect(DRIFT_Y_RATE).toBe(0.75);
        expect(orbit, `field ${index}`).toBe(4 * DRIFT_PERIODS_S[index]);
        for (const start of [0, 7.3, 61.9]) {
          const [from, to] = [at(start)[index], at(start + orbit)[index]];
          expect(to.x, `${theme} field ${index} x after ${orbit} s`).toBeCloseTo(from.x, 6);
          expect(to.y, `${theme} field ${index} y after ${orbit} s`).toBeCloseTo(from.y, 6);
        }
        // Whole drift periods short of the orbit leave the y drift elsewhere.
        for (let turns = 1; turns < orbit / DRIFT_PERIODS_S[index]; turns++) {
          const offsets = [0, 7.3, 61.9].map(start => Math.abs(at(start + turns * DRIFT_PERIODS_S[index])[index].y - at(start)[index].y));
          expect(Math.max(...offsets), `${theme} field ${index} after ${turns} drift periods`).toBeGreaterThan(1);
        }
      });
    }
  });

  it("drifts continuously with performance.now() across pause and resume", () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const callbacks = new Map<number, FrameRequestCallback>();
    let nextRafId = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      const id = ++nextRafId;
      callbacks.set(id, cb);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      callbacks.delete(id);
    });

    const mockCtx = createMockCanvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      mockCtx as unknown as CanvasRenderingContext2D,
    );
    const canvas = document.createElement("canvas");

    const ctrl = createAmbientController({
      enabled: true,
      theme: "dark",
      palette: PALETTE,
      viewportWidth: 1440,
      viewportHeight: 900,
    });
    ctrl.attachCanvas(canvas);
    ctrl.start();

    expect(callbacks.size).toBe(1);
    const [firstId, firstCb] = [...callbacks.entries()][0];
    callbacks.delete(firstId);
    now = 1050;
    firstCb(now);
    const firstTranslates = mockCtx.translate.mock.calls.map((c) => [...c]);

    ctrl.setPaused(true);
    expect(callbacks.size).toBe(0);
    now = 9050;
    ctrl.setPaused(false);
    expect(callbacks.size).toBe(1);
    const [secondId, secondCb] = [...callbacks.entries()][0];
    callbacks.delete(secondId);
    secondCb(now);
    const resumedTranslates = mockCtx.translate.mock.calls
      .slice(firstTranslates.length)
      .map((c) => [...c]);

    expect(resumedTranslates).not.toEqual(firstTranslates);
    ctrl.dispose();
  });

  it("downgrades FPS 30 -> 20 -> 12 -> 0 after 5 consecutive >2ms frames and skips within fps interval", () => {
    let perfNow = 0;
    let frameCost = 3;
    let inFrame = false;
    vi.spyOn(performance, "now").mockImplementation(() => {
      if (!inFrame) {
        inFrame = true;
        return perfNow;
      }
      inFrame = false;
      return perfNow + frameCost;
    });

    const ctrl = createAmbientController({
      enabled: true,
      theme: "dark",
      palette: PALETTE,
      viewportWidth: 1440,
      viewportHeight: 900,
    });

    expect(ctrl.getFps()).toBe(30);

    // Within 1000/30 ms (~33.3ms), drawAt skips the second call.
    expect(ctrl.drawAt(100)).toBe(true);
    expect(ctrl.drawAt(110)).toBe(false);

    // Finish 4 more slow frames at 30fps -> step down to 20fps
    for (let i = 1; i <= 4; i++) {
      perfNow = 100 + i * 40;
      expect(ctrl.drawAt(perfNow)).toBe(true);
    }
    expect(ctrl.getFps()).toBe(20);

    // 5 slow frames at 20fps (>= 50ms interval) -> step down to 12fps
    for (let i = 1; i <= 5; i++) {
      perfNow += 60;
      expect(ctrl.drawAt(perfNow)).toBe(true);
    }
    expect(ctrl.getFps()).toBe(12);

    // 5 slow frames at 12fps (>= 84ms interval) -> step down to 0 (frozen)
    for (let i = 1; i <= 5; i++) {
      perfNow += 90;
      expect(ctrl.drawAt(perfNow)).toBe(true);
    }
    expect(ctrl.getFps()).toBe(0);
    expect(ctrl.drawAt(perfNow + 200)).toBe(false);

    ctrl.dispose();
  });

  it("uses the requested theme's peaks until <html> carries that theme, and its tokens after", () => {
    const root = document.documentElement;
    const mockCtx = createMockCanvasContext();
    const alphas = recordAlphas(mockCtx);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      mockCtx as unknown as CanvasRenderingContext2D,
    );
    // Before the appearance provider's effect, <html> has no data-theme and
    // :root still holds the dark tokens.
    root.removeAttribute("data-theme");
    root.style.setProperty("--ambient-peak-0", String(PEAK_ALPHA.dark[0]));
    try {
      const ctrl = createAmbientController({
        enabled: true,
        theme: "light",
        palette: PALETTE,
        intensity: 0.6,
        viewportWidth: 1440,
        viewportHeight: 900,
      });
      ctrl.attachCanvas(document.createElement("canvas"));
      ctrl.drawAt(0);
      expect(alphas[0]).toBeCloseTo(fieldZeroAlpha(0, "light", PEAK_ALPHA.light), 6);

      // Switching to dark while <html> still says light keeps the dark peaks.
      root.dataset.theme = "light";
      root.style.setProperty("--ambient-peak-0", String(PEAK_ALPHA.light[0]));
      ctrl.updateConfig({ theme: "dark" });
      alphas.length = 0;
      ctrl.drawAt(1000);
      expect(alphas[0]).toBeCloseTo(fieldZeroAlpha(1000, "dark", PEAK_ALPHA.dark), 6);

      // Once <html> names the theme, its tokens apply.
      root.dataset.theme = "dark";
      root.style.setProperty("--ambient-peak-0", "0.3");
      ctrl.updateConfig({});
      alphas.length = 0;
      ctrl.drawAt(2000);
      expect(alphas[0]).toBeCloseTo(fieldZeroAlpha(2000, "dark", withPeak0(PEAK_ALPHA.dark, 0.3)), 6);
      ctrl.dispose();
    } finally {
      root.removeAttribute("data-theme");
      root.style.removeProperty("--ambient-peak-0");
    }
  });

  it("repaints a still frame after the adaptive tier stopped the loop, without restarting it", () => {
    const clock = { now: 0 };
    let inFrame = false;
    vi.spyOn(performance, "now").mockImplementation(() => {
      inFrame = !inFrame;
      return inFrame ? clock.now : clock.now + 5;
    });
    const scheduled = vi.fn(() => 1);
    vi.stubGlobal("requestAnimationFrame", scheduled);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const mockCtx = createMockCanvasContext();
    const alphas = recordAlphas(mockCtx);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      mockCtx as unknown as CanvasRenderingContext2D,
    );
    const canvas = document.createElement("canvas");
    const ctrl = createAmbientController({
      enabled: true,
      theme: "dark",
      palette: PALETTE,
      intensity: 0.6,
      viewportWidth: 1440,
      viewportHeight: 900,
    });
    ctrl.attachCanvas(canvas);
    driveToFrozenTier(ctrl, clock);
    expect(ctrl.getFps()).toBe(0);
    const frozenAt = clock.now;

    // A resize that changes the backing size clears the bitmap; it is repainted.
    mockCtx.drawImage.mockClear();
    ctrl.resize(1920, 1080);
    expect(canvas.width).toBe(320);
    expect(mockCtx.drawImage).toHaveBeenCalled();

    // A theme switch repaints with the new palette and peaks.
    ctrl.resize(1440, 900);
    mockCtx.drawImage.mockClear();
    alphas.length = 0;
    ctrl.updateConfig({ theme: "light", palette: LIGHT_PALETTE });
    expect(mockCtx.drawImage).toHaveBeenCalled();
    expect(alphas[0]).toBeCloseTo(fieldZeroAlpha(frozenAt, "light", PEAK_ALPHA.light), 6);

    // A fresh canvas (Lite back to Full) is painted too.
    mockCtx.drawImage.mockClear();
    ctrl.attachCanvas(document.createElement("canvas"));
    expect(mockCtx.drawImage).toHaveBeenCalled();

    // The loop itself stays stopped.
    scheduled.mockClear();
    ctrl.setPaused(false);
    ctrl.start();
    expect(scheduled).not.toHaveBeenCalled();
    expect(ctrl.drawAt(clock.now + 500)).toBe(false);

    // Reduced motion, disabled and high contrast never paint.
    mockCtx.drawImage.mockClear();
    ctrl.updateConfig({ reducedMotion: true, intensity: 0.8 });
    ctrl.updateConfig({ reducedMotion: false, enabled: false });
    ctrl.updateConfig({ enabled: true, highContrast: true });
    expect(mockCtx.drawImage).not.toHaveBeenCalled();
    ctrl.dispose();
  });

  it("computes bounded spatial getBusyness with custom background boost and zero when disabled", () => {
    const ctrl = createAmbientController({
      enabled: true,
      theme: "dark",
      palette: PALETTE,
      intensity: 0.8,
      viewportWidth: 1440,
      viewportHeight: 900,
    });
    ctrl.drawAt(0);

    const nearAnchor = ctrl.getBusyness({ left: 260, top: 200, width: 140, height: 100 });
    const farCorner = ctrl.getBusyness({ left: 1300, top: 820, width: 80, height: 60 });
    expect(nearAnchor).toBeGreaterThan(0);
    expect(nearAnchor).toBeLessThanOrEqual(0.85);
    expect(farCorner).toBeLessThan(nearAnchor);

    ctrl.updateConfig({ customBackgroundActive: true });
    const boosted = ctrl.getBusyness({ left: 260, top: 200, width: 140, height: 100 });
    expect(boosted).toBeCloseTo(Math.min(1, nearAnchor + 0.2), 5);

    ctrl.updateConfig({ enabled: false, customBackgroundActive: false });
    expect(ctrl.getBusyness({ left: 260, top: 200, width: 140, height: 100 })).toBe(0);

    ctrl.updateConfig({ enabled: true, highContrast: true });
    expect(ctrl.getBusyness({ left: 260, top: 200, width: 140, height: 100 })).toBe(0);

    ctrl.dispose();
  });
});

describe("AmbientLayer and AmbientOverlay", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      createMockCanvasContext() as unknown as CanvasRenderingContext2D,
    );
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

  it("renders 1 canvas in Full mode, 0 canvases in Lite/reducedMotion, and null when disabled/highContrast", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAmbientState(listener);

    act(() =>
      root.render(
        createElement(AmbientLayer, {
          enabled: true,
          theme: "dark",
          palette: PALETTE,
          effects: "full",
          reducedMotion: false,
          highContrast: false,
        }),
      ),
    );
    expect(container.querySelectorAll("canvas")).toHaveLength(1);
    expect(container.querySelector("[data-ambient-mode='canvas']")).not.toBeNull();
    expect(getAmbientBusyness({ left: 200, top: 200, width: 120, height: 80 })).toBeGreaterThan(0);
    expect(listener).toHaveBeenCalled();

    act(() =>
      root.render(
        createElement(AmbientLayer, {
          enabled: true,
          theme: "light",
          palette: PALETTE,
          effects: "lite",
          reducedMotion: false,
          highContrast: false,
        }),
      ),
    );
    expect(container.querySelectorAll("canvas")).toHaveLength(0);
    expect(container.querySelector("[data-ambient-mode='static']")).not.toBeNull();
    expect(container.querySelector(".vx-ambient__static")).not.toBeNull();

    act(() =>
      root.render(
        createElement(AmbientLayer, {
          enabled: true,
          theme: "dark",
          palette: PALETTE,
          effects: "full",
          reducedMotion: true,
          highContrast: false,
        }),
      ),
    );
    expect(container.querySelectorAll("canvas")).toHaveLength(0);
    expect(container.querySelector("[data-ambient-mode='static']")).not.toBeNull();

    act(() =>
      root.render(
        createElement(AmbientLayer, {
          enabled: false,
          theme: "dark",
          palette: PALETTE,
          effects: "full",
        }),
      ),
    );
    expect(container.innerHTML).toBe("");
    expect(getAmbientBusyness({ left: 200, top: 200, width: 120, height: 80 })).toBe(0);

    act(() =>
      root.render(
        createElement(AmbientLayer, {
          enabled: true,
          theme: "dark",
          palette: PALETTE,
          effects: "full",
          highContrast: true,
        }),
      ),
    );
    expect(container.innerHTML).toBe("");

    unsubscribe();
  });

  it("re-reads the peak tokens when <html> receives the theme after the layer mounted", async () => {
    const htmlRoot = document.documentElement;
    const callbacks: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    const mockCtx = createMockCanvasContext();
    const alphas = recordAlphas(mockCtx);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      mockCtx as unknown as CanvasRenderingContext2D,
    );
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1440);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(900);
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    htmlRoot.removeAttribute("data-theme");
    htmlRoot.style.setProperty("--ambient-peak-0", String(PEAK_ALPHA.dark[0]));
    try {
      act(() => root.render(createElement(AmbientLayer, { enabled: true, theme: "light", palette: PALETTE, effects: "full" })));
      callbacks.shift()?.(now);
      expect(alphas[0]).toBeCloseTo(fieldZeroAlpha(0, "light", PEAK_ALPHA.light), 6);

      // The provider writes data-theme in its own later effect.
      htmlRoot.style.setProperty("--ambient-peak-0", "0.3");
      await act(async () => {
        htmlRoot.dataset.theme = "light";
        await Promise.resolve();
      });
      alphas.length = 0;
      now = 1000;
      callbacks.shift()?.(now);
      expect(alphas[0]).toBeCloseTo(fieldZeroAlpha(1000, "light", withPeak0(PEAK_ALPHA.light, 0.3)), 6);
    } finally {
      htmlRoot.removeAttribute("data-theme");
      htmlRoot.style.removeProperty("--ambient-peak-0");
    }
  });

  it("renders AmbientOverlay only when visible and not highContrast", () => {
    act(() =>
      root.render(
        createElement(AmbientOverlay, {
          visible: true,
          theme: "dark",
          palette: PALETTE,
        }),
      ),
    );
    const overlay = container.querySelector<HTMLElement>("[data-ambient-overlay]");
    expect(overlay).not.toBeNull();
    expect(overlay?.dataset.ambientTheme).toBe("dark");
    expect(overlay?.getAttribute("aria-hidden")).toBe("true");

    act(() =>
      root.render(
        createElement(AmbientOverlay, {
          visible: false,
          theme: "dark",
          palette: PALETTE,
        }),
      ),
    );
    expect(container.innerHTML).toBe("");

    act(() =>
      root.render(
        createElement(AmbientOverlay, {
          visible: true,
          theme: "dark",
          palette: PALETTE,
          highContrast: true,
        }),
      ),
    );
    expect(container.innerHTML).toBe("");
  });

  it("shifts field positions and alphas over 10s and reads --ambient-peak tokens", () => {
    const config = {
      enabled: true,
      theme: "light" as const,
      palette: PALETTE,
      intensity: 0.6,
    };
    const atStart = computeFieldStates(0, 1440, 900, config);
    const after10s = computeFieldStates(10_000, 1440, 900, config);
    const movedDistance = Math.hypot(after10s[0].x - atStart[0].x, after10s[0].y - atStart[0].y);
    expect(movedDistance).toBeGreaterThan(20);
    expect(after10s[0].alpha).not.toBeCloseTo(atStart[0].alpha, 3);

    const rootStyle = document.documentElement.style;
    rootStyle.setProperty("--ambient-peak-0", "0.52");
    document.documentElement.dataset.theme = "light";
    try {
      const mockCtx = createMockCanvasContext();
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
        mockCtx as unknown as CanvasRenderingContext2D,
      );
      const canvas = document.createElement("canvas");
      const ctrl = createAmbientController({
        enabled: true,
        theme: "light",
        palette: PALETTE,
        intensity: 0.6,
        viewportWidth: 1440,
        viewportHeight: 900,
      });
      const alphas = recordAlphas(mockCtx);
      ctrl.attachCanvas(canvas);
      ctrl.drawAt(0);
      expect(alphas[0]).toBeCloseTo(fieldZeroAlpha(0, "light", withPeak0(PEAK_ALPHA.light, 0.52)), 6);
      ctrl.dispose();
    } finally {
      rootStyle.removeProperty("--ambient-peak-0");
      document.documentElement.removeAttribute("data-theme");
    }
  });

  it("keeps an active attached controller after React StrictMode remount", () => {
    const callbacks = new Map<number, FrameRequestCallback>();
    let nextRafId = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      const id = ++nextRafId;
      callbacks.set(id, cb);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      callbacks.delete(id);
    });

    const mockCtx = createMockCanvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      mockCtx as unknown as CanvasRenderingContext2D,
    );

    act(() =>
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(AmbientLayer, {
            enabled: true,
            theme: "light",
            palette: PALETTE,
            effects: "full",
          }),
        ),
      ),
    );

    expect(getAmbientBusyness({ left: 200, top: 200, width: 120, height: 80 })).toBeGreaterThan(0);
    expect(callbacks.size).toBe(1);
    const [rafId, rafCb] = [...callbacks.entries()][0];
    callbacks.delete(rafId);
    rafCb(performance.now());
    expect(mockCtx.drawImage).toHaveBeenCalled();
    expect(() => window.dispatchEvent(new Event("resize"))).not.toThrow();

    // The mounted layer's controller is the one the page exposes; it draws on request.
    const active = getActiveAmbientController();
    expect(active).not.toBeNull();
    mockCtx.drawImage.mockClear();
    active!.stop();
    expect(active!.drawAt(92000)).toBe(true);
    expect(mockCtx.drawImage).toHaveBeenCalledTimes(window.innerWidth < 1200 ? 3 : 4);
    act(() => root.render(createElement(StrictMode, null)));
    expect(getActiveAmbientController()).toBeNull();
  });

  it("freezes on its last frame while a game runs and resumes afterwards", () => {
    const callbacks = new Map<number, FrameRequestCallback>();
    let nextRafId = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      const id = ++nextRafId;
      callbacks.set(id, cb);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      callbacks.delete(id);
    });
    const mockCtx = createMockCanvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      mockCtx as unknown as CanvasRenderingContext2D,
    );
    const layer = (gameRunning: boolean) =>
      createElement(AmbientLayer, { enabled: true, theme: "dark", palette: PALETTE, effects: "full", gameRunning });

    act(() => root.render(layer(false)));
    expect(callbacks.size).toBe(1);
    const [firstId, firstFrame] = [...callbacks.entries()][0];
    callbacks.delete(firstId);
    firstFrame(performance.now());
    expect(mockCtx.drawImage).toHaveBeenCalled();
    expect(callbacks.size).toBe(1);

    const clears = mockCtx.clearRect.mock.calls.length;
    const draws = mockCtx.drawImage.mock.calls.length;
    act(() => root.render(layer(true)));
    expect(callbacks.size).toBe(0);
    expect(mockCtx.clearRect.mock.calls.length).toBe(clears);
    expect(mockCtx.drawImage.mock.calls.length).toBe(draws);
    expect(container.querySelectorAll("canvas.vx-ambient-canvas")).toHaveLength(1);

    act(() => root.render(layer(false)));
    expect(callbacks.size).toBe(1);
  });

  it("redraws its frozen frame at the new size, at the last drawn time, when the window resizes while a game runs", () => {
    const callbacks = new Map<number, FrameRequestCallback>();
    let nextRafId = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      const id = ++nextRafId;
      callbacks.set(id, cb);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      callbacks.delete(id);
    });
    const mockCtx = createMockCanvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      mockCtx as unknown as CanvasRenderingContext2D,
    );
    const viewport = { width: 1440, height: 900 };
    vi.spyOn(window, "innerWidth", "get").mockImplementation(() => viewport.width);
    vi.spyOn(window, "innerHeight", "get").mockImplementation(() => viewport.height);
    let now = 5000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const layer = (gameRunning: boolean) =>
      createElement(AmbientLayer, { enabled: true, theme: "dark", palette: PALETTE, effects: "full", gameRunning });
    const config = { enabled: true, theme: "dark" as const, palette: PALETTE, intensity: 0.6 };
    /** The sprite centres a frame at `timeMs` puts on a `backing` canvas over the viewport. */
    const centres = (timeMs: number, backing: { width: number; height: number }) =>
      computeFieldStates(timeMs, viewport.width, viewport.height, config).map((field) => [
        field.x * (backing.width / viewport.width),
        field.y * (backing.height / viewport.height),
      ]);
    const drawnCentres = () => mockCtx.translate.mock.calls.map(([x, y]) => [x, y]);
    const expectFrame = (timeMs: number, backing: { width: number; height: number }) => {
      const expected = centres(timeMs, backing);
      const drawn = drawnCentres();
      expect(drawn).toHaveLength(expected.length);
      drawn.forEach(([x, y], index) => {
        expect(x).toBeCloseTo(expected[index][0], 6);
        expect(y).toBeCloseTo(expected[index][1], 6);
      });
    };
    const clearDraws = () => {
      mockCtx.translate.mockClear();
      mockCtx.drawImage.mockClear();
    };

    act(() => root.render(layer(false)));
    const canvas = container.querySelector<HTMLCanvasElement>("canvas.vx-ambient-canvas")!;
    const [firstId, firstFrame] = [...callbacks.entries()][0];
    callbacks.delete(firstId);
    clearDraws();
    firstFrame(now);
    expectFrame(5000, { width: 240, height: 150 });

    act(() => root.render(layer(true)));
    expect(callbacks.size).toBe(0);
    now = 65_000;

    // Same 240x150 backing, new viewport: redrawn instead of stretched.
    clearDraws();
    viewport.width = 1400;
    viewport.height = 875;
    act(() => window.dispatchEvent(new Event("resize")));
    expect([canvas.width, canvas.height]).toEqual([240, 150]);
    expectFrame(5000, { width: 240, height: 150 });

    // A new backing size clears the bitmap: redrawn instead of left blank.
    clearDraws();
    viewport.width = 1920;
    viewport.height = 1080;
    act(() => window.dispatchEvent(new Event("resize")));
    expect([canvas.width, canvas.height]).toEqual([320, 180]);
    expectFrame(5000, { width: 320, height: 180 });

    // An unchanged size draws nothing, and no loop started while paused.
    clearDraws();
    act(() => window.dispatchEvent(new Event("resize")));
    expect(mockCtx.drawImage).not.toHaveBeenCalled();
    expect(callbacks.size).toBe(0);

    act(() => root.render(layer(false)));
    expect(callbacks.size).toBe(1);
  });
});
