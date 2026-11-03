// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountCursorHalo, type CursorHalo } from "./cursor";
import { DotField } from "./dots";

type Circle = { x: number; y: number; radius: number; alpha: number };
let circles: Circle[];
let context: CanvasRenderingContext2D;
let callbacks: Map<number, FrameRequestCallback>;
let frameId: number;
let now: number;
let pageHidden: boolean;
let media: Record<string, boolean>;
let mediaListeners: Map<string, Set<() => void>>;
let halo: CursorHalo | null;
let originalMatchMedia: PropertyDescriptor | undefined;

function frame(time: number) {
  now = time;
  const pending = [...callbacks.values()];
  callbacks.clear();
  pending.forEach((callback) => callback(time));
}

function settle(start = 0, count = 120) {
  for (let index = 0; index < count; index += 1)
    frame(start + (index * 1000) / 60);
}

function pointer(element: Element, x: number, y: number, type = "pointermove") {
  element.dispatchEvent(
    new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }),
  );
}

function box(
  element: HTMLElement,
  left: number,
  top: number,
  width: number,
  height: number,
) {
  element.style.borderRadius = "16px";
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    left,
    top,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    width,
    height,
    toJSON: () => ({}),
  });
}

function card() {
  const element = document.createElement("article");
  element.dataset.visualOwner = "lattice";
  element.setAttribute("aria-current", "true");
  element.innerHTML =
    '<span class="vx-lattice-frame vx-lattice-frame--selected" aria-hidden="true" style="visibility:visible"></span><button>Launch</button>';
  box(element, 200, 100, 400, 240);
  const button = element.querySelector("button")!;
  box(button, 480, 280, 100, 40);
  document.body.append(element);
  return {
    element,
    button,
    outline: element.querySelector<HTMLElement>(".vx-lattice-frame")!,
  };
}

function advanceAtRate(start: number, milliseconds: number, hz: number): number {
  const interval = 1000 / hz;
  let count = 0;
  for (let elapsed = interval; elapsed < milliseconds - 1e-6; elapsed += interval) {
    frame(start + elapsed);
    count++;
  }
  frame(start + milliseconds);
  return count + 1;
}

function beginCardMigration() {
  const fixture = card();
  halo = mountCursorHalo(document.body);
  pointer(document.body, 700, 600);
  settle();
  pointer(fixture.button, 530, 300);
  return { ...fixture, startedAt: (119 * 1000) / 60 };
}

function expectCompleteCardContour(points: Circle[]) {
  expect(points).toHaveLength(30);
  for (const distances of [
    points.map(point => Math.abs(point.x - 194)),
    points.map(point => Math.abs(point.x - 606)),
    points.map(point => Math.abs(point.y - 94)),
    points.map(point => Math.abs(point.y - 346)),
  ]) expect(Math.min(...distances)).toBeLessThan(8);
  for (const point of points) {
    expect(point.alpha).toBeGreaterThan(.8);
    expect(Math.min(Math.abs(point.x - 194), Math.abs(point.x - 606), Math.abs(point.y - 94), Math.abs(point.y - 346))).toBeLessThan(12);
  }
}

function migrationPath(hz: number) {
  const { element, startedAt } = beginCardMigration();
  advanceAtRate(startedAt, 500, hz);
  const middle = circles.map(point => ({ ...point }));
  advanceAtRate(startedAt + 500, 600, hz);
  const finished = circles.map(point => ({ ...point }));
  halo!.dispose();
  halo = null;
  element.remove();
  return { middle, finished };
}

beforeEach(() => {
  circles = [];
  callbacks = new Map();
  frameId = 0;
  now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  pageHidden = false;
  halo = null;
  document.body.innerHTML = "";
  document.documentElement.dataset.effects = "full";
  document.documentElement.dataset.reducedMotion = "false";
  document.documentElement.dataset.highContrast = "false";
  media = { "(any-pointer: fine)": true, "(pointer: fine)": true };
  mediaListeners = new Map();
  originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => {
      if (!mediaListeners.has(query)) mediaListeners.set(query, new Set());
      return {
        get matches() {
          return Boolean(media[query]);
        },
        media: query,
        addEventListener: (_event: string, callback: () => void) =>
          mediaListeners.get(query)!.add(callback),
        removeEventListener: (_event: string, callback: () => void) =>
          mediaListeners.get(query)!.delete(callback),
      };
    }),
  });
  vi.spyOn(document, "hidden", "get").mockImplementation(() => pageHidden);
  context = {
    clearRect: vi.fn(() => {
      circles = [];
    }),
    setTransform: vi.fn(),
    beginPath: vi.fn(),
    fill: vi.fn(),
    globalAlpha: 1,
    fillStyle: "",
    arc: vi.fn((x: number, y: number, radius: number) => {
      circles.push({ x, y, radius, alpha: context.globalAlpha });
    }),
  } as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as never,
  );
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      callbacks.set(++frameId, callback);
      return frameId;
    }),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => callbacks.delete(id)),
  );
});

afterEach(() => {
  halo?.dispose();
  document.body.innerHTML = "";
  delete document.documentElement.dataset.effects;
  delete document.documentElement.dataset.reducedMotion;
  delete document.documentElement.dataset.highContrast;
  if (originalMatchMedia)
    Object.defineProperty(window, "matchMedia", originalMatchMedia);
  else Reflect.deleteProperty(window, "matchMedia");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Lattice cursor halo", () => {
  it("stops drawing a settled pointer and restarts for movement and a press", () => {
    halo = mountCursorHalo(document.body);
    pointer(document.body, 400, 300); settle();
    expect(callbacks.size).toBe(0);
    const draws = vi.mocked(context.clearRect).mock.calls.length;
    settle(2000);
    expect(vi.mocked(context.clearRect).mock.calls.length).toBe(draws);
    pointer(document.body, 480, 320);
    expect(callbacks.size).toBe(1);
    settle(4000); expect(callbacks.size).toBe(0);
    expect(circles[30]).toMatchObject({ x: 480, y: 320 });
    pointer(document.body, 480, 320, "pointerdown");
    expect(callbacks.size).toBe(1);
    settle(6000); expect(callbacks.size).toBe(0);
  });

  it("stops a settled card contour and resumes for scroll and keyboard handoff", () => {
    const first = card(); const second = card();
    box(second.element, 650, 400, 250, 220); box(second.button, 660, 410, 100, 40);
    halo = mountCursorHalo(document.body);
    pointer(first.button, 530, 300); settle();
    expect(callbacks.size).toBe(0);
    document.dispatchEvent(new Event("scroll"));
    expect(callbacks.size).toBe(1);
    settle(2000); expect(callbacks.size).toBe(0);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    second.button.focus();
    expect(callbacks.size).toBe(1);
    settle(4000); expect(callbacks.size).toBe(0);
    expect(first.element.hasAttribute("data-halo-owned")).toBe(false);
    expect(second.element.dataset.haloOwned).toBe("true");
  });

  it("releases a settled target removed from the document without another pointer event", async () => {
    const { element, button, outline } = card();
    halo = mountCursorHalo(document.body); pointer(button, 530, 300); settle();
    element.remove(); await Promise.resolve();
    expect(element.hasAttribute("data-halo-owned")).toBe(false);
    expect(outline.style.visibility).toBe("visible");
    settle(2000); expect(callbacks.size).toBe(0);
    expect(circles).toHaveLength(31);
  });

  it("uses readable primary ink for the control contour", () => {
    document.documentElement.style.setProperty("--text-primary", "#eee8dc");
    document.documentElement.style.setProperty("--optical-cold", "#cc99ff");
    const { button } = card(); halo = mountCursorHalo(document.body);
    pointer(button, 530, 300); settle();
    expect(context.fillStyle).toBe("#eee8dc");
    document.documentElement.style.removeProperty("--text-primary");
    document.documentElement.style.removeProperty("--optical-cold");
  });
  it("responds to actual pointer events with one center and all thirty visible orbit points", () => {
    halo = mountCursorHalo(document.body);
    expect(halo).not.toBeNull();
    expect(callbacks.size).toBe(0);
    pointer(document.body, 700, 600);
    settle();
    expect(circles).toHaveLength(31);
    const ring = circles.slice(0, 30);
    expect(ring.every((point) => point.alpha > 0.5)).toBe(true);
    expect(
      ring.every(
        (point) => Math.abs(Math.hypot(point.x - 700, point.y - 600) - 18) < 3,
      ),
    ).toBe(true);
    expect(circles[30]).toMatchObject({ x: 700, y: 600 });
  });

  it("springs the same pool onto all four rounded card sides instead of its inner button", () => {
    const { element, button, outline } = card();
    halo = mountCursorHalo(document.body);
    const canvas = document.querySelector("canvas");
    pointer(document.body, 700, 600);
    settle();
    expect(circles).toHaveLength(31);
    const previous = { ...circles[0] };
    pointer(button, 530, 300);
    frame(2000);
    expect(circles).toHaveLength(30);
    expect(
      Math.hypot(circles[0].x - previous.x, circles[0].y - previous.y),
    ).toBeLessThan(100);
    settle(2017);
    expect(circles).toHaveLength(30);
    expect(Math.min(...circles.map((point) => point.x))).toBeLessThan(204);
    expect(Math.max(...circles.map((point) => point.x))).toBeGreaterThan(596);
    expect(Math.min(...circles.map((point) => point.y))).toBeLessThan(104);
    expect(Math.max(...circles.map((point) => point.y))).toBeGreaterThan(336);
    expect(document.querySelectorAll("canvas")).toHaveLength(1);
    expect(document.querySelector("canvas")).toBe(canvas);
    expect(element.dataset.haloOwned).toBe("true");
    expect(outline.style.visibility).toBe("hidden");
    expect(element.getAttribute("aria-current")).toBe("true");
    pointer(document.body, 700, 600);
    settle(4017);
    expect(circles).toHaveLength(31);
    expect(element.hasAttribute("data-halo-owned")).toBe(false);
    expect(outline.style.visibility).toBe("visible");
  });

  it.each([6, 60])("covers all four stable card edges within 1100 ms at %d Hz", (hz) => {
    const { element, startedAt } = beginCardMigration();
    const bounds = vi.mocked(element.getBoundingClientRect);
    bounds.mockClear();
    const frameCount = advanceAtRate(startedAt, 1100, hz);
    expectCompleteCardContour(circles);
    // Usability and the current target bounds may each read layout once per RAF.
    expect(bounds.mock.calls.length).toBeLessThanOrEqual(frameCount * 2);
  });

  it("keeps the same migration path at 6 Hz and 60 Hz for equal elapsed time", () => {
    const sixty = migrationPath(60);
    const six = migrationPath(6);
    for (const stage of ["middle", "finished"] as const) {
      expect(six[stage]).toHaveLength(30);
      expect(sixty[stage]).toHaveLength(30);
      six[stage].forEach((point, index) => {
        expect(Math.hypot(point.x - sixty[stage][index].x, point.y - sixty[stage][index].y), `${stage} point ${index}`).toBeLessThan(2);
      });
    }
  });

  it("bounds catch-up work after a long visible stall and continues to converge", () => {
    const { element, startedAt } = beginCardMigration();
    const initialDistance = circles.slice(0, 30).reduce((sum, point) => sum + Math.hypot(point.x - 400, point.y - 220), 0);
    const steps = vi.spyOn(DotField.prototype, "step");
    const bounds = vi.mocked(element.getBoundingClientRect);
    bounds.mockClear();
    frame(startedAt + 10_000);
    expect(steps.mock.calls.length).toBeGreaterThan(0);
    expect(steps.mock.calls.length).toBeLessThanOrEqual(60);
    expect(bounds.mock.calls.length).toBeLessThanOrEqual(2);
    expect(circles).toHaveLength(30);
    for (const point of circles) {
      expect([point.x, point.y, point.radius, point.alpha].every(Number.isFinite)).toBe(true);
      expect(point.alpha).toBeGreaterThanOrEqual(0);
      expect(point.alpha).toBeLessThanOrEqual(1);
    }
    expect(circles.reduce((sum, point) => sum + Math.hypot(point.x - 400, point.y - 220), 0)).toBeLessThan(initialDistance);
    advanceAtRate(startedAt + 10_000, 1100, 60);
    expectCompleteCardContour(circles);
  });

  it("respects opt-out ancestry and lets Lens controls keep their own primary material", () => {
    const excluded = document.createElement("div");
    excluded.dataset.noHalo = "";
    excluded.innerHTML = "<button>Excluded</button>";
    const lens = document.createElement("div");
    lens.dataset.visualOwner = "lens";
    lens.innerHTML = "<button>Glass</button>";
    document.body.append(excluded, lens);
    halo = mountCursorHalo(document.body);
    for (const element of [
      excluded.firstElementChild!,
      lens.firstElementChild!,
    ]) {
      box(element as HTMLElement, 10, 10, 200, 50);
      pointer(element, 100, 100);
      settle();
      expect(circles).toHaveLength(31);
      expect(
        circles.every((point) => Math.hypot(point.x - 100, point.y - 100) < 20),
      ).toBe(true);
    }
  });

  it("absorbs an ordinary operable control even when an aria-hidden icon receives the pointer", () => {
    const button = document.createElement("button");
    button.innerHTML = '<span aria-hidden="true">icon</span>';
    box(button, 100, 100, 200, 50);
    document.body.append(button);
    halo = mountCursorHalo(document.body);
    pointer(button.firstElementChild!, 200, 125);
    settle();
    expect(circles).toHaveLength(30);
    expect(Math.min(...circles.map((point) => point.x))).toBeLessThan(110);
    expect(Math.max(...circles.map((point) => point.x))).toBeGreaterThan(290);
    expect(Math.min(...circles.map((point) => point.y))).toBeLessThan(105);
    expect(Math.max(...circles.map((point) => point.y))).toBeGreaterThan(145);
  });

  it("can form a keyboard focus contour without a preceding pointer event", () => {
    const { element, button } = card();
    halo = mountCursorHalo(document.body);
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
    );
    button.focus();
    settle();
    expect(circles).toHaveLength(30);
    expect(element.dataset.haloOwned).toBe("true");
    document.body.tabIndex = -1;
    document.body.focus();
    frame(2100);
    expect(callbacks.size).toBe(0);
    expect(element.hasAttribute("data-halo-owned")).toBe(false);
  });

  it("retains point positions while keyboard focus transfers between cards", () => {
    const first = card();
    const second = card();
    box(second.element, 650, 400, 250, 220);
    box(second.button, 660, 410, 100, 40);
    halo = mountCursorHalo(document.body);
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
    );
    first.button.focus();
    settle();
    expect(circles).toHaveLength(30);
    const previous = { ...circles[0] };
    second.button.focus();
    frame(2000);
    expect(circles).toHaveLength(30);
    expect(
      Math.hypot(circles[0].x - previous.x, circles[0].y - previous.y),
    ).toBeLessThan(100);
    expect(first.element.hasAttribute("data-halo-owned")).toBe(false);
    expect(second.element.dataset.haloOwned).toBe("true");
  });

  it("restores the native keyboard outline exactly when the halo is disabled", () => {
    const { element, button } = card();
    button.style.outline = "3px solid red";
    const original = button.style.outline;
    halo = mountCursorHalo(document.body);
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
    );
    button.focus();
    settle();
    expect(button.style.outline).toBe("none");
    halo!.setEnabled(false);
    expect(button.style.outline).toBe(original);
    expect(element.hasAttribute("data-halo-owned")).toBe(false);
  });

  it("bursts the current point pool outward on press", () => {
    halo = mountCursorHalo(document.body);
    pointer(document.body, 400, 300);
    settle();
    const radius = () =>
      circles
        .slice(0, 30)
        .reduce(
          (sum, point) => sum + Math.hypot(point.x - 400, point.y - 300),
          0,
        ) / 30;
    const before = radius();
    pointer(document.body, 400, 300, "pointerdown");
    frame(2000);
    expect(radius()).toBeGreaterThan(before + 1);
  });

  it.each(["blur", "hidden", "iframe", "disabled"])(
    "clears pixels, ownership and scheduling on %s",
    (reason) => {
      const { element, button, outline } = card();
      halo = mountCursorHalo(document.body);
      pointer(button, 530, 300);
      settle();
      pointer(button, 530, 300, "pointerdown");
      expect(callbacks.size).toBe(1);
      if (reason === "blur") window.dispatchEvent(new Event("blur"));
      if (reason === "hidden") {
        pageHidden = true;
        document.dispatchEvent(new Event("visibilitychange"));
      }
      if (reason === "iframe") {
        const iframe = document.createElement("iframe");
        document.body.append(iframe);
        pointer(iframe, 500, 400, "pointerover");
      }
      if (reason === "disabled") halo!.setEnabled(false);
      expect(callbacks.size).toBe(0);
      expect(circles).toHaveLength(0);
      expect(element.hasAttribute("data-halo-owned")).toBe(false);
      expect(outline.style.visibility).toBe("visible");
      if (reason === "disabled" || reason === "hidden") {
        pointer(button, 530, 300);
        expect(callbacks.size).toBe(0);
      }
    },
  );

  it.each([
    "(prefers-reduced-motion: reduce)",
    "(prefers-contrast: more)",
    "(forced-colors: active)",
  ])("stops on %s without waiting for another pointer event", (query) => {
    halo = mountCursorHalo(document.body);
    pointer(document.body, 400, 300);
    frame(0);
    pointer(document.body, 500, 400);
    expect(callbacks.size).toBe(1);
    media[query] = true;
    mediaListeners.get(query)?.forEach((listener) => listener());
    expect(callbacks.size).toBe(0);
    pointer(document.body, 500, 400);
    expect(callbacks.size).toBe(0);
    expect(circles).toHaveLength(0);
  });

  it("ignores touch and leaves no canvas on devices without a fine pointer", () => {
    halo = mountCursorHalo(document.body);
    const event = new MouseEvent("pointermove", {
      bubbles: true,
      clientX: 400,
      clientY: 300,
    });
    Object.defineProperty(event, "pointerType", { value: "touch" });
    document.body.dispatchEvent(event);
    expect(callbacks.size).toBe(0);
    halo!.dispose();
    media["(any-pointer: fine)"] = false;
    halo = mountCursorHalo(document.body);
    expect(halo).toBeNull();
    expect(document.querySelector("canvas")).toBeNull();
  });

  it.each([
    ["effects", "lite"],
    ["reducedMotion", "true"],
    ["highContrast", "true"],
  ])(
    "suspends immediately when root policy %s changes to %s",
    async (key, value) => {
      halo = mountCursorHalo(document.body);
      pointer(document.body, 400, 300);
      frame(0);
      pointer(document.body, 500, 400);
      expect(callbacks.size).toBe(1);
      document.documentElement.dataset[key] = value;
      await Promise.resolve();
      expect(callbacks.size).toBe(0);
      expect(circles).toHaveLength(0);
      pointer(document.body, 500, 400);
      expect(callbacks.size).toBe(0);
    },
  );

  it.each(["dialog", "popover"])(
    "keeps native focus and the original card frame inside a %s top layer",
    (kind) => {
      const { element, button, outline } = card();
      const layer = document.createElement(
        kind === "dialog" ? "dialog" : "div",
      );
      if (kind === "dialog") layer.setAttribute("open", "");
      else layer.setAttribute("popover", "auto");
      layer.append(element);
      document.body.append(layer);
      button.style.outline = "3px solid red";
      const original = button.style.outline;
      halo = mountCursorHalo(document.body);
      pointer(button, 530, 300);
      settle();
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
      );
      button.focus();
      settle(2100);
      expect(element.hasAttribute("data-halo-owned")).toBe(false);
      expect(outline.style.visibility).toBe("visible");
      expect(button.style.outline).toBe(original);
      expect(callbacks.size).toBe(0);
      expect(document.querySelectorAll("canvas")).toHaveLength(1);
    },
  );

  it("releases its frame if an active card is moved into a native top layer", async () => {
    const { element, button, outline } = card();
    halo = mountCursorHalo(document.body);
    pointer(button, 530, 300);
    settle();
    expect(element.dataset.haloOwned).toBe("true");
    const layer = document.createElement("dialog");
    layer.open = true;
    layer.append(element);
    document.body.append(layer);
    await Promise.resolve();
    frame(2000);
    expect(element.hasAttribute("data-halo-owned")).toBe(false);
    expect(outline.style.visibility).toBe("visible");
    expect(callbacks.size).toBe(0);
  });

  it("disposes listeners and restores an owned frame so later events cannot restart it", () => {
    const { element, button, outline } = card();
    halo = mountCursorHalo(document.body);
    pointer(button, 530, 300);
    settle();
    expect(element.dataset.haloOwned).toBe("true");
    halo!.dispose();
    expect(document.querySelector("canvas")).toBeNull();
    expect(element.hasAttribute("data-halo-owned")).toBe(false);
    expect(outline.style.visibility).toBe("visible");
    pointer(button, 530, 300);
    window.dispatchEvent(new Event("resize"));
    expect(callbacks.size).toBe(0);
  });
});
