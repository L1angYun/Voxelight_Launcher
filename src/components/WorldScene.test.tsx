// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CUBE_FLIP_DURATION_MS,
  CUBE_GLOW_DURATION_MS,
  CUBE_GLOW_RADIUS_PX,
  CUBE_PITCH_PX,
  CUBE_RIPPLE_FALLOFF_PX,
  CUBE_ROTATION_RPM,
  CUBE_SIZE_PX,
  CUBE_STAY_DURATION_MS,
  CUBE_TRIGGER_DISTANCE_PX,
  CUBE_TRIGGER_RADIUS_PX,
  CUBE_RETURN_DURATION_MS,
  CUBE_RETRIGGER_DELAY_MS,
  POINTER_SPRING,
  WorldScene,
  cubeProjection,
  cubeTurnOffset,
  type WorldSceneState,
} from "./WorldScene";
import { cameraSweepToField, cubeSweepIntersects } from "./cubeGeometry";

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

async function advanceFrame(now: number) {
  const callback = vi.mocked(requestAnimationFrame).mock.calls.at(-1)?.[0];
  if (!callback) throw new Error("Missing animation frame");
  await act(async () => callback(now));
}

async function movePointer(x: number, y: number) {
  await act(async () => {
    scene().dispatchEvent(
      new MouseEvent("pointermove", {
        bubbles: true,
        clientX: x,
        clientY: y,
      }),
    );
  });
}

async function firstCubeWidthAt(now: number) {
  const points: number[] = [];
  let capture = false;
  vi.mocked(context.clearRect).mockImplementation((x, y, width, height) => {
    capture = width === 55 && height === 55 && x === 60.5 && y === 46.5;
  });
  vi.mocked(context.moveTo).mockImplementation((x) => {
    if (capture) points.push(x);
  });
  vi.mocked(context.lineTo).mockImplementation((x) => {
    if (capture) points.push(x);
  });
  await advanceFrame(now);
  expect(points.length).toBeGreaterThan(0);
  return Math.max(...points) - Math.min(...points);
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
  it("renders cube and interaction glow layers without the old ambient particle canvas", async () => {
    await render(createElement(WorldScene, { className: "home-hero__world" }));
    const element = scene();
    expect(element.classList.contains("world-scene")).toBe(true);
    expect(element.classList.contains("home-hero__world")).toBe(true);
    expect(element.getAttribute("aria-hidden")).toBe("true");
    expect(element.dataset.sceneState).toBe("idle");
    expect(element.dataset.paused).toBe("false");
    expect(element.querySelector("svg")).toBeNull();
    expect(element.querySelectorAll("canvas")).toHaveLength(2);
    expect(element.querySelector(".world-scene__camera")).not.toBeNull();
    expect(canvas("world-scene__cube-canvas").dataset.rendered).toBe("true");
    expect(canvas("world-scene__glow-canvas").dataset.rendered).toBe("true");
    expect(element.querySelector(".world-scene__particle-canvas")).toBeNull();
    expect(element.hasAttribute("data-particle-budget")).toBe(false);
    expect(context.clearRect).toHaveBeenCalled();
    expect(context.fill).toHaveBeenCalled();
    expect(element.querySelector("button, input, select, text")).toBeNull();
  });

  it("does not draw random firefly circles or dust squares in lite mode", async () => {
    await render(createElement(WorldScene, { effects: "lite" }));
    expect(scene().querySelector(".world-scene__particle-canvas")).toBeNull();
    expect(context.arc).not.toHaveBeenCalled();
    expect(context.fillRect).not.toHaveBeenCalled();
    expect(context.fill).toHaveBeenCalled();
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });

  it("keeps idle full-quality frames free from the old random ambient point drawing", async () => {
    await render(createElement(WorldScene, { effects: "full" }));
    await advanceFrame(0);
    await advanceFrame(500);
    expect(context.arc).not.toHaveBeenCalled();
    expect(context.fillRect).not.toHaveBeenCalled();
    expect(context.fill).toHaveBeenCalled();
  });

  it("keeps camera, state, progress, cube, and interaction glow contracts", async () => {
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
    expect(CUBE_SIZE_PX).toBe(32);
    expect(CUBE_PITCH_PX).toBe(56);
    expect(CUBE_PITCH_PX).toBeGreaterThan(CUBE_SIZE_PX * Math.SQRT2 + 2);
    expect(CUBE_FLIP_DURATION_MS).toBe(1200);
    expect(CUBE_STAY_DURATION_MS).toBe(1800);
    expect(CUBE_RETURN_DURATION_MS).toBe(280);
    expect(CUBE_GLOW_RADIUS_PX).toBe(10);
    expect(CUBE_GLOW_DURATION_MS).toBe(800);
    expect(CUBE_TRIGGER_RADIUS_PX).toBe(72);
    expect(CUBE_RIPPLE_FALLOFF_PX).toBe(180);
    expect(CUBE_TRIGGER_DISTANCE_PX).toBe(0);
    expect(POINTER_SPRING).toEqual({ stiffness: 90, damping: 13 });
    expect(scene().dataset.cubePitch).toBe("56");
    expect(scene().dataset.cubeActiveBudget).toBe(scene().dataset.cubeCount);
    expect(scene().dataset.cubeFlipDuration).toBe("1200");
    expect(scene().dataset.cubeStayDuration).toBe("1800");
    expect(scene().dataset.cubeTriggerRadius).toBe("72");
    expect(scene().dataset.cubeRippleFalloff).toBe("180");
    expect(scene().dataset.cubeTriggerDistance).toBe("0");
    expect(scene().dataset.cubeRotation).toBe("true");
    expect(CUBE_ROTATION_RPM).toBe(1.2);
    expect(scene().dataset.cubeRotationRpm).toBe("1.2");
    expect(scene().dataset.cubeRotationRpmMin).toBe("1.2");
    expect(scene().dataset.cubeRotationRpmMax).toBe("1.2");
  });

  it("reveals the neighbouring physical face as the front turns side-on", () => {
    expect(cubeProjection(0).faces).toHaveLength(2);
    expect(cubeProjection(Math.PI / 4).faces).toHaveLength(3);
    expect(cubeProjection(Math.PI / 2).faces).toHaveLength(2);
    expect(cubeProjection(Math.PI / 4).bounds.maxX).toBeCloseTo(22.62742);
  });

  it("rotates eight solid vertices around a stationary geometric center inside its cell", () => {
    for (let degrees = 0; degrees <= 360; degrees += 5) {
      const angle = (degrees / 180) * Math.PI;
      const projection = cubeProjection(angle);
      expect(projection).toHaveProperty("vertices");
      const { vertices } = projection as unknown as {
        vertices: Array<{ x: number; y: number }>;
      };
      expect(vertices).toHaveLength(8);
      expect(vertices.reduce((total, point) => total + point.x, 0)).toBeCloseTo(
        0,
      );
      expect(vertices.reduce((total, point) => total + point.y, 0)).toBeCloseTo(
        0,
      );
      for (const point of vertices) {
        expect(Math.abs(point.x)).toBeLessThan(27);
        expect(Math.abs(point.y)).toBeLessThan(27);
      }
    }
  });

  it("keeps a solid cube silhouette at side-on quarter turns", () => {
    const projection = cubeProjection(Math.PI / 2);
    expect(projection).toHaveProperty("bounds");
    const { bounds } = projection as unknown as {
      bounds: { minX: number; maxX: number; minY: number; maxY: number };
    };
    expect(bounds.maxX - bounds.minX).toBeCloseTo(32);
    expect(bounds.maxY - bounds.minY).toBeGreaterThan(32);
  });

  it("updates every idle cube once in the same animation frame", async () => {
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1440,
      bottom: 930,
      width: 1440,
      height: 930,
      toJSON: () => ({}),
    });
    await render();
    vi.mocked(context.clearRect).mockClear();
    await advanceFrame(0);
    const clearedCells = vi
      .mocked(context.clearRect)
      .mock.calls.filter(([, , width, height]) => width < 56 && height < 56);
    expect(clearedCells).toHaveLength(Number(scene().dataset.cubeCount));
  });

  it("advances the rendered idle angle monotonically with elapsed time without pointer input", async () => {
    await render();
    const angles: number[] = [];
    for (const time of [0, 500, 1000]) {
      const width = await firstCubeWidthAt(time);
      // Independently recover yaw from the measured solid silhouette in the
      // first quadrant: width = 32 * sqrt(2) * cos(yaw - pi/4).
      angles.push(Math.PI / 4 - Math.acos(width / (32 * Math.SQRT2)));
    }
    expect(Number(scene().dataset.activeFlips)).toBe(0);
    expect(angles[1]).toBeGreaterThan(angles[0]);
    expect(angles[2]).toBeGreaterThan(angles[1]);
    // The specified 1.2 RPM is 3.6 degrees during each half second.
    expect(angles[1] - angles[0]).toBeCloseTo(Math.PI / 50, 6);
    expect(angles[2] - angles[1]).toBeCloseTo(Math.PI / 50, 6);
  });

  it("keeps every cube fully inside the canvas through maximum camera scale and parallax", async () => {
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1440,
      bottom: 930,
      width: 1440,
      height: 930,
      toJSON: () => ({}),
    });
    await render();
    const clearBoxes = vi
      .mocked(context.clearRect)
      .mock.calls.filter(
        ([, , width, height]) => width === 55 && height === 55,
      );
    expect(clearBoxes.length).toBeGreaterThan(0);
    // Worst yaw envelope: half-edge16 × sqrt(2) = 22.62742.
    // Test all four screen edges at max camera translation and pushScale1.06.
    for (const [left, top, width, height] of clearBoxes) {
      const x = left + width / 2;
      const y = top + height / 2;
      expect(720 + (x - 22.62742 - 720) * 1.06 - 18).toBeGreaterThanOrEqual(2);
      expect(720 + (x + 22.62742 - 720) * 1.06 + 18).toBeLessThanOrEqual(1438);
      expect(465 + (y - 22.62742 - 465) * 1.06 - 11.16).toBeGreaterThanOrEqual(
        2,
      );
      expect(465 + (y + 22.62742 - 465) * 1.06 + 11.16).toBeLessThanOrEqual(
        928,
      );
    }
  });

  it("covers a fast pointer path beyond its endpoints and the former activation cap", async () => {
    await render();
    await movePointer(100, 270);
    await advanceFrame(0);
    await movePointer(860, 270);
    await advanceFrame(16);
    // Exactly 15 columns × 4 rows are in the centered 960×540 field capsule.
    expect(Number(scene().dataset.activeFlips)).toBe(60);
  });

  it("includes projected edge contact even when the cube center is outside the trigger disk", () => {
    const projection = cubeProjection(0);
    expect(
      cubeSweepIntersects(
        { from: { x: 188, y: 100 }, to: { x: 188, y: 100 } },
        { x: 100, y: 100 },
        projection,
        72,
      ),
    ).toBe(true);
    expect(
      cubeSweepIntersects(
        { from: { x: 188.01, y: 100 }, to: { x: 188.01, y: 100 } },
        { x: 100, y: 100 },
        projection,
        72,
      ),
    ).toBe(false);
  });

  it("keeps the trigger tangent at exactly 72 screen pixels under camera offsets and scale", () => {
    for (const { camera, point } of [
      {
        camera: { x: 18, y: -11.16, scale: 1.06 },
        point: { x: 184.16, y: 78.64 },
      },
      {
        camera: { x: -18, y: 11.16, scale: 1.06 },
        point: { x: 148.16, y: 100.96 },
      },
      { camera: { x: 7, y: -3, scale: 1.03 }, point: { x: 184.08, y: 91.9 } },
    ]) {
      const tangent = cameraSweepToField(
        { from: point, to: point },
        { width: 960, height: 540 },
        camera,
        72,
      );
      expect(
        cubeSweepIntersects(
          tangent,
          { x: 100, y: 100 },
          cubeProjection(0),
          tangent.radius,
        ),
      ).toBe(true);
      const outside = { x: point.x + 0.01, y: point.y };
      const miss = cameraSweepToField(
        { from: outside, to: outside },
        { width: 960, height: 540 },
        camera,
        72,
      );
      expect(
        cubeSweepIntersects(
          miss,
          { x: 100, y: 100 },
          cubeProjection(0),
          miss.radius,
        ),
      ).toBe(false);
    }
  });

  it("tests the swept segment against actual cube edges rather than endpoints or the bounds box", () => {
    expect(
      cubeSweepIntersects(
        { from: { x: -200, y: 0 }, to: { x: 200, y: 0 } },
        { x: 0, y: 0 },
        cubeProjection(Math.PI / 4),
        0,
      ),
    ).toBe(true);
    // (22,22) is inside the axis-aligned bounds, outside the sloping cube edge.
    expect(
      cubeSweepIntersects(
        { from: { x: 22, y: 22 }, to: { x: 22, y: 22 } },
        { x: 0, y: 0 },
        cubeProjection(Math.PI / 4),
        0.1,
      ),
    ).toBe(false);
  });

  it("covers hand-checked center cells along the entire horizontal capsule", () => {
    const sweep = { from: { x: 100, y: 280 }, to: { x: 860, y: 280 } };
    // These 13×4 literal centers are on the 56px grid and lie safely within
    // the swept disk plus solid boundary, including rows outside the disk alone.
    for (const x of [
      140, 196, 252, 308, 364, 420, 476, 532, 588, 644, 700, 756, 812,
    ]) {
      for (const y of [196, 252, 308, 364]) {
        expect(
          cubeSweepIntersects(sweep, { x, y }, cubeProjection(0), 72),
        ).toBe(true);
      }
    }
  });

  it("preserves intermediate coalesced pointer samples when the final point doubles back", async () => {
    await render();
    const event = new MouseEvent("pointermove", {
      bubbles: true,
      clientX: 100,
      clientY: 280,
    });
    Object.defineProperty(event, "getCoalescedEvents", {
      value: () => [
        { clientX: 100, clientY: 280 },
        { clientX: 860, clientY: 280 },
      ],
    });
    await act(async () => scene().dispatchEvent(event));
    await advanceFrame(0);
    expect(Number(scene().dataset.activeFlips)).toBeGreaterThan(50);
  });

  it("finishes a complete turn with continuous velocity back into idle", () => {
    expect(cubeTurnOffset(0)).toBe(0);
    expect(cubeTurnOffset(1200)).toBeCloseTo(Math.PI * 2);
    expect(cubeTurnOffset(1800)).toBeCloseTo(Math.PI * 2);
    expect(cubeTurnOffset(1)).toBeLessThan(0.001);
    expect(Math.PI * 2 - cubeTurnOffset(1199)).toBeLessThan(0.001);
    let previous = 0;
    for (let elapsed = 25; elapsed <= 1200; elapsed += 25) {
      const current = cubeTurnOffset(elapsed);
      expect(current).toBeGreaterThan(previous);
      previous = current;
    }
  });

  it("does not retrigger continuously while the pointer remains inside the same cubes", async () => {
    await render();
    for (const y of [40, 140, 240, 340, 440, 540]) {
      await movePointer(0, y);
      await movePointer(960, y);
    }
    await movePointer(480, 270);
    await advanceFrame(0);
    expect(Number(scene().dataset.activeFlips)).toBe(
      Number(scene().dataset.cubeCount),
    );
    const finish =
      CUBE_FLIP_DURATION_MS + CUBE_STAY_DURATION_MS + CUBE_RETURN_DURATION_MS;
    await advanceFrame(finish);
    expect(Number(scene().dataset.activeFlips)).toBe(0);
    await movePointer(480, 270);
    await advanceFrame(finish + CUBE_RETRIGGER_DELAY_MS - 1);
    expect(Number(scene().dataset.activeFlips)).toBe(0);
    await movePointer(480, 270);
    await advanceFrame(finish + CUBE_RETRIGGER_DELAY_MS);
    expect(Number(scene().dataset.activeFlips)).toBe(0);
  });

  it("starts another complete turn on re-entry during the accent hold", async () => {
    await render();
    await movePointer(88, 74);
    await advanceFrame(0);
    await advanceFrame(1200);
    await movePointer(860, 470);
    await movePointer(88, 74);
    await advanceFrame(1500);
    // At t2100 the second turn is halfway through. An idle cube at t2100 has
    // a 45.25px silhouette; the real second turn is about 37px wide here.
    expect(await firstCubeWidthAt(2100)).toBeLessThan(42);
  });

  it("queues one complete turn on re-entry after 240ms without interrupting the current turn", async () => {
    await render();
    await movePointer(88, 74);
    await advanceFrame(0);
    await movePointer(860, 470);
    await movePointer(88, 74);
    await advanceFrame(300);
    expect(await firstCubeWidthAt(1800)).toBeLessThan(42);
  });

  it("rejects another entry before the 240ms acceptance delay", async () => {
    await render();
    await movePointer(88, 74);
    await advanceFrame(0);
    await movePointer(860, 470);
    await movePointer(88, 74);
    await advanceFrame(120);
    expect(await firstCubeWidthAt(1800)).toBeGreaterThan(44);
  });

  it("bounds repeated in-turn entries to one pending full revolution", async () => {
    await render();
    await movePointer(88, 74);
    await advanceFrame(0);
    for (const time of [300, 600, 900]) {
      await movePointer(860, 470);
      await movePointer(88, 74);
      await advanceFrame(time);
    }
    expect(await firstCubeWidthAt(2700)).toBeGreaterThan(44);
  });

  it.each([false, true])(
    "resumes the same idle/active pose after a background pause (active=%s)",
    async (active) => {
      await render();
      if (active) await movePointer(88, 74);
      await advanceFrame(0);
      const beforeWidth = await firstCubeWidthAt(500);
      const camera = scene().querySelector<HTMLElement>(
        ".world-scene__camera",
      )!;
      const beforeCamera = camera.style.transform;
      await render(createElement(WorldScene, { paused: true }));
      expect(camera.style.transform).toBe(beforeCamera);
      await render(createElement(WorldScene, { paused: false }));
      expect(await firstCubeWidthAt(1_000_000)).toBeCloseTo(beforeWidth);
      expect(camera.style.transform).toBe(beforeCamera);
    },
  );

  it("returns accent opacity smoothly to idle without a final-frame jump", async () => {
    await render();
    for (const y of [40, 140, 240, 340, 440, 540]) {
      await movePointer(0, y);
      await movePointer(960, y);
    }
    await act(async () => window.dispatchEvent(new Event("blur")));
    await advanceFrame(0);
    const alpha: number[] = [];
    vi.mocked(context.fill).mockImplementation(() =>
      alpha.push(context.globalAlpha),
    );
    const finish =
      CUBE_FLIP_DURATION_MS + CUBE_STAY_DURATION_MS + CUBE_RETURN_DURATION_MS;
    await advanceFrame(finish - 1);
    const previousAlpha = alpha[0];
    alpha.length = 0;
    await advanceFrame(finish);
    expect(Math.abs(alpha[0] - previousAlpha)).toBeLessThan(0.005);
  });

  it("does not replay pointer paths collected before reduced motion was enabled", async () => {
    await render(createElement(WorldScene, { effects: "full" }));
    await movePointer(100, 280);
    await movePointer(860, 280);
    await render(
      createElement(WorldScene, { effects: "full", reducedMotion: true }),
    );
    await render(
      createElement(WorldScene, { effects: "full", reducedMotion: false }),
    );
    await advanceFrame(0);
    expect(Number(scene().dataset.activeFlips)).toBe(0);
  });

  it("does not connect pointer movement during a pause to the next visible sweep", async () => {
    await render(createElement(WorldScene, { effects: "full", paused: true }));
    await movePointer(100, 270);
    await render(createElement(WorldScene, { effects: "full", paused: false }));
    await movePointer(860, 270);
    await advanceFrame(0);
    expect(Number(scene().dataset.activeFlips)).toBeGreaterThan(0);
    expect(Number(scene().dataset.activeFlips)).toBeLessThan(30);
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

  it("starts visible turns for cubes under a fine pointer", async () => {
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
    expect(activeFlips).toBeLessThanOrEqual(Number(scene().dataset.cubeCount));
    await advanceFrame(CUBE_FLIP_DURATION_MS + 16);
    expect(context.createRadialGradient).toHaveBeenCalledWith(
      expect.any(Number),
      expect.any(Number),
      0,
      expect.any(Number),
      expect.any(Number),
      CUBE_GLOW_RADIUS_PX,
    );
    expect(context.fillRect).toHaveBeenCalled();
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
    const fillCalls = vi.mocked(context.fill).mock.calls.length;
    await act(async () => {
      document.documentElement.dataset.theme = "light";
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(vi.mocked(context.fill).mock.calls.length).toBeGreaterThan(
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

  it("respects operating system reduced motion even when full effects are selected", async () => {
    reducedMotion = true;
    await render(createElement(WorldScene, { effects: "full" }));
    expect(scene().dataset.motion).toBe("reduced");
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });

  it("keeps full effects static when application accessibility settings request reduced motion", async () => {
    await render(
      createElement(WorldScene, { effects: "full", reducedMotion: true }),
    );
    expect(scene().dataset.motion).toBe("reduced");
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });

  it("keeps lite effects static even when system motion is available", async () => {
    await render(createElement(WorldScene, { effects: "lite" }));
    expect(scene().dataset.motion).toBe("reduced");
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });
});
