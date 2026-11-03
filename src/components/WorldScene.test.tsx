// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorldScene } from "./WorldScene";

const bridge = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("./world/renderer", () => ({ createWorldRenderer: bridge.create }));
let root: Root, container: HTMLDivElement, now: number, sequence: number;
let frames: Map<number, FrameRequestCallback>;
let fake: ReturnType<typeof renderer>;
let callbacks: { onLost(): void; onRestored(): void };
let hidden = false;
const media = new Map<string, { matches: boolean; listeners: Set<() => void> }>();
const inputs = { phase: "idle" as const, fraction: null, page: "home" as const, scene: "horizon" as const, material: "lattice" as const };
function renderer() {
  return { capabilities: { webgl2: true as const, floatTargets: true }, material: "solid" as const,
    melt: 0, press: vi.fn(), release: vi.fn(), shock: vi.fn(),
    resize: vi.fn(), setTier: vi.fn(), setPalette: vi.fn(), setAnchor: vi.fn(), setPointer: vi.fn(),
    draw: vi.fn((_frame: any, _dt: number) => ({ cpuMs: 2, gpuMs: null })), dispose: vi.fn() };
}
async function render(props: Partial<Parameters<typeof WorldScene>[0]> = {}) {
  await act(async () => root.render(createElement(WorldScene, { ...inputs, ...props })));
}
async function advance(milliseconds = 1000, fps = 60) {
  await act(async () => {
    for (let index = 0; index < Math.ceil(milliseconds * fps / 1000); index++) {
      now += 1000 / fps;
      for (const [id, callback] of [...frames]) if (frames.delete(id)) callback(now);
    }
  });
}
const scene = () => container.querySelector<HTMLElement>(".world-scene")!;
beforeEach(() => {
  vi.clearAllMocks(); now = 1000; sequence = 0; frames = new Map(); hidden = false; media.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.spyOn(performance, "now").mockImplementation(() => now);
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  vi.stubGlobal("matchMedia", (query: string) => {
    let state = media.get(query);
    if (!state) { state = { matches: query.includes("pointer: fine"), listeners: new Set() }; media.set(query, state); }
    return { get matches() { return state!.matches; }, addEventListener: (_: string, callback: () => void) => state!.listeners.add(callback), removeEventListener: (_: string, callback: () => void) => state!.listeners.delete(callback) };
  });
  fake = renderer(); bridge.create.mockImplementation((_canvas, handlers) => { callbacks = handlers; return fake; });
  document.documentElement.dataset.theme = "dark";
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  document.documentElement.removeAttribute("data-theme"); document.documentElement.style.cssText = "";
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
it("falls back to CSS without WebGL2 and keeps one inert canvas", async () => {
  bridge.create.mockReturnValue(null); await render();
  expect(scene().dataset.worldTier).toBe("css"); expect(scene().getAttribute("aria-hidden")).toBe("true");
  expect(scene().querySelectorAll(".world-scene__canvas")).toHaveLength(1); expect(frames.size).toBe(0);
});
it("static tier draws exactly one frame and schedules no animation", async () => {
  await render({ effects: "lite" }); expect(scene().dataset.worldTier).toBe("static");
  expect(fake.draw).toHaveBeenCalledTimes(1); expect(frames.size).toBe(0);
  await advance(); expect(fake.draw).toHaveBeenCalledTimes(1);
});
it("a paused scene requests no frames and resumes the same renderer", async () => {
  await render({ paused: true }); expect(frames.size).toBe(0); expect(fake.draw).not.toHaveBeenCalled();
  await render({ paused: false }); expect(frames.size).toBeGreaterThan(0);
  await advance(100); expect(fake.draw).toHaveBeenCalled(); expect(bridge.create).toHaveBeenCalledTimes(1);
});
it("disposes its renderer and cancels all pending frames on unmount", async () => {
  await render(); await act(async () => root.render(null));
  expect(fake.dispose).toHaveBeenCalledTimes(1); expect(frames.size).toBe(0);
  for (const value of media.values()) expect(value.listeners.size).toBe(0);
});
it("reads the live palette without recreating the context", async () => {
  await render(); const first = fake.setPalette.mock.calls.at(-1)![0];
  await act(async () => { document.documentElement.dataset.theme = "light"; document.documentElement.style.setProperty("--accent", "#cc3366"); });
  const next = fake.setPalette.mock.calls.at(-1)![0];
  expect(next.light).toBe(true); expect(next.accent).toEqual([.8, .2, .4]);
  expect(first.light).toBe(false); expect(bridge.create).toHaveBeenCalledTimes(1);
});
it("switches accessibility policy to a static frame without remounting", async () => {
  await render(); await advance(100); const query = media.get("(prefers-reduced-motion: reduce)")!;
  await act(async () => { query.matches = true; query.listeners.forEach(callback => callback()); });
  expect(scene().dataset.worldTier).toBe("static"); expect(frames.size).toBe(0);
  const count = fake.draw.mock.calls.length; await advance(500); expect(fake.draw).toHaveBeenCalledTimes(count);
});
it("stops on hidden documents and continues without a sleep-time jump", async () => {
  await render(); await advance(100);
  await act(async () => { hidden = true; document.dispatchEvent(new Event("visibilitychange")); });
  expect(frames.size).toBe(0); const count = fake.draw.mock.calls.length; now += 30000;
  await act(async () => { hidden = false; document.dispatchEvent(new Event("visibilitychange")); });
  await advance(50); expect(fake.draw.mock.calls.length).toBeGreaterThan(count);
  expect(fake.draw.mock.calls.at(-1)![1]).toBeLessThanOrEqual(.05);
});
it("uses CSS during context loss and resumes only after restoration", async () => {
  await render(); await act(async () => callbacks.onLost());
  expect(scene().dataset.worldTier).toBe("css"); expect(frames.size).toBe(0);
  await act(async () => callbacks.onRestored());
  expect(scene().dataset.worldTier).toBe("animated"); expect(frames.size).toBeGreaterThan(0);
  expect(bridge.create).toHaveBeenCalledTimes(1);
});
it("updates page composition and phase on the existing renderer", async () => {
  await render(); await render({ page: "content", scene: "massif", phase: "preparing", fraction: .5 });
  await advance(3000); const frame = fake.draw.mock.calls.at(-1)![0];
  expect(frame.front).toBeCloseTo(97.5, 0); expect(frame.profile).toBeGreaterThan(.99);
  expect(scene().dataset.worldPhase).toBe("preparing"); expect(bridge.create).toHaveBeenCalledTimes(1);
});
it("downgrades after two real seconds even when physical simulation dt is capped", async () => {
  fake.draw.mockReturnValue({ cpuMs: 20, gpuMs: null });
  await render(); await advance(2100, 10);
  expect(fake.setTier.mock.calls.at(-1)![0].dprCap).toBe(1);
});
it("snaps static scene, page and running targets without adding animation frames", async () => {
  await render({ effects: "lite" });
  await render({ effects: "lite", scene: "massif", page: "content" });
  expect(fake.draw.mock.calls.at(-1)![0]).toMatchObject({ profile: 1, exposure: .42, eye: [-22, 46, 66], runDim: .5 });
  await render({ effects: "lite", scene: "massif", phase: "running" });
  expect(fake.draw.mock.calls.at(-1)![0]).toMatchObject({ front: 165, exposure: .3, runDim: .3, settled: true });
  expect(frames.size).toBe(0);
});
it("detects an unthrottled RAF bottleneck when GPU timing is unavailable", async () => {
  fake.draw.mockReturnValue({ cpuMs: 0, gpuMs: null });
  await render(); await advance(2200, 10);
  expect(fake.setTier.mock.calls.at(-1)![0].dprCap).toBe(1);
});
it("renders every available full-policy RAF callback without an idle frame cap", async () => {
  await render();
  const count = fake.draw.mock.calls.length;
  await advance(100, 120);
  expect(fake.draw.mock.calls.length - count).toBe(12);
});
async function pointer(type: string, target: Element, init: Partial<MouseEventInit> = {}) {
  await act(async () => {
    const event = new MouseEvent(type, { clientX: 500, clientY: 400, bubbles: true, button: 0, ...init });
    Object.assign(event, { pointerId: 1, pointerType: "mouse" }); target.dispatchEvent(event);
  });
}
function target(markup = "<div></div>") { container.insertAdjacentHTML("beforeend", markup); return container.lastElementChild!; }
it("presses blank home space and turns a short release into one shock", async () => {
  await render(); const blank = target();
  await pointer("pointerdown", blank); expect(fake.press).toHaveBeenCalledTimes(1);
  now += 100; await pointer("pointerup", blank);
  expect(fake.release).toHaveBeenCalled(); expect(fake.shock).toHaveBeenCalledTimes(1);
});
it("does not shock after a hold, drag or a rapid press with residual melt", async () => {
  await render(); const blank = target();
  await pointer("pointerdown", blank); now += 500; await pointer("pointerup", blank);
  expect(fake.shock).not.toHaveBeenCalled();
  await pointer("pointerdown", blank); await pointer("pointermove", blank, { clientX: 550 }); now += 100;
  await pointer("pointerup", blank, { clientX: 550 }); expect(fake.shock).not.toHaveBeenCalled();
  fake.melt = .7; await pointer("pointerdown", blank); now += 50; await pointer("pointerup", blank);
  expect(fake.shock).not.toHaveBeenCalled(); expect(fake.release).toHaveBeenCalled();
});
it("leaves controls, readable copy and drag regions outside the press field", async () => {
  await render();
  for (const markup of ['<button>Launch</button>', '<p>Readable text<span></span></p>', '<div data-tauri-drag-region></div>', '<article data-visual-owner="lattice"></article>']) {
    await pointer("pointerdown", target(markup));
  }
  expect(fake.press).not.toHaveBeenCalled();
});
it("only presses on home, and disabling motion releases an existing hold", async () => {
  await render({ page: "content" }); await pointer("pointerdown", target()); expect(fake.press).not.toHaveBeenCalled();
  await render(); await pointer("pointerdown", target()); expect(fake.press).toHaveBeenCalledTimes(1);
  await render({ effects: "lite" }); expect(fake.release).toHaveBeenCalled();
  fake.press.mockClear(); await pointer("pointerdown", target()); expect(fake.press).not.toHaveBeenCalled();
});
it("releases a hold on pointer cancellation and blur without adding a shock", async () => {
  await render(); const blank = target(); await pointer("pointerdown", blank); await pointer("pointercancel", blank);
  expect(fake.release).toHaveBeenCalled(); fake.release.mockClear();
  await pointer("pointerdown", blank); window.dispatchEvent(new Event("blur"));
  expect(fake.release).toHaveBeenCalled(); expect(fake.shock).not.toHaveBeenCalled();
});
it("reports solid material when float targets are unavailable without overwriting the request", async () => {
  fake.capabilities.floatTargets = false; await render();
  expect(scene().dataset.worldMaterial).toBe("solid");
  expect(fake.draw.mock.calls.at(-1)![0].lat).toBe(0);
});
it("measures the character anchor and retains its last NDC while another page is mounted", async () => {
  const anchor = document.createElement("div"); anchor.dataset.worldAnchor = "";
  anchor.getBoundingClientRect = () => new DOMRect(300, 100, 200, 400);
  document.body.append(anchor);
  try {
    await render();
    expect(fake.setAnchor.mock.calls.at(-1)![0][0]).toBeCloseTo(-.21875);
    expect(fake.setAnchor.mock.calls.at(-1)![0][1]).toBeCloseTo(-.3020833333);
    anchor.getBoundingClientRect = () => new DOMRect(600, 50, 100, 500);
    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(fake.setAnchor.mock.calls.at(-1)![0][0]).toBeCloseTo(.26953125);
    expect(fake.setAnchor.mock.calls.at(-1)![0][1]).toBeCloseTo(-.4322916667);
    anchor.remove(); await render({ page: "content" });
    expect(fake.setAnchor.mock.calls.at(-1)![0][0]).toBeCloseTo(.26953125);
    expect(fake.setAnchor.mock.calls.at(-1)![0][1]).toBeCloseTo(-.4322916667);
  } finally { anchor.remove(); }
});
it("remeasures a newly committed anchor and paints one static frame on its layout event", async () => {
  await render({ effects: "lite" });
  const anchor = document.createElement("div"); anchor.dataset.worldAnchor = "";
  anchor.getBoundingClientRect = () => new DOMRect(300, 100, 200, 400);
  document.body.append(anchor);
  try {
    const draws = fake.draw.mock.calls.length;
    await act(async () => window.dispatchEvent(new Event("vx:world-anchor")));
    expect(fake.setAnchor.mock.calls.at(-1)![0][0]).toBeCloseTo(-.21875);
    expect(fake.draw.mock.calls.length).toBe(draws + 1);
  } finally { anchor.remove(); }
});
it("observes a replacement home anchor even when its geometry matches the prior node", async () => {
  const observed = new Set<Element>();
  vi.stubGlobal("ResizeObserver", class {
    observe(element: Element) { observed.add(element); }
    unobserve(element: Element) { observed.delete(element); }
    disconnect() { observed.clear(); }
  });
  const first = document.createElement("div"); first.dataset.worldAnchor = "";
  first.getBoundingClientRect = () => new DOMRect(300, 100, 200, 400);
  document.body.append(first);
  await render({ effects: "lite" });
  const replacement = first.cloneNode() as HTMLElement;
  replacement.getBoundingClientRect = first.getBoundingClientRect;
  first.remove(); document.body.append(replacement);
  try {
    await act(async () => window.dispatchEvent(new Event("vx:world-anchor")));
    expect(observed.has(replacement)).toBe(true);
    expect(observed.has(first)).toBe(false);
  } finally { first.remove(); replacement.remove(); }
});
it("publishes the actual rounded crystal frontier and returns to zero after cancel", async () => {
  await render({ phase: "preparing", fraction: .37 }); await advance(3000);
  expect(scene().dataset.worldFront).toBe("80");
  await render(); await advance(3000);
  expect(scene().dataset.worldFront).toBe("0");
});
it("shocks once from the character anchor on a new preparation, without replay on progress", async () => {
  await render();
  await render({ phase: "preparing", fraction: 0 });
  expect(fake.shock).toHaveBeenCalledExactlyOnceWith(fake.setAnchor.mock.calls.at(-1)![0]);
  await render({ phase: "preparing", fraction: .6 });
  expect(fake.shock).toHaveBeenCalledTimes(1);
});
it("does not create a launch shock for initial preparation or a static scene", async () => {
  await render({ phase: "preparing", fraction: .3 });
  expect(fake.shock).not.toHaveBeenCalled();
  await render({ effects: "lite" });
  await render({ effects: "lite", phase: "preparing", fraction: 0 });
  expect(fake.shock).not.toHaveBeenCalled();
});
