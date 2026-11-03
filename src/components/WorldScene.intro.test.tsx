// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
import type { Root } from "react-dom/client";
import type { WorldDrawMetrics } from "./world/renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("./world/renderer", () => ({ createWorldRenderer: bridge.create }));
let react: typeof import("react"), component: typeof import("./WorldScene");
let root: Root, container: HTMLDivElement, now: number, sequence: number;
let frames: Map<number, FrameRequestCallback>;
let fake: ReturnType<typeof renderer>;
let callbacks: { onLost(): void; onRestored(): void };
const inputs = { phase: "idle" as const, fraction: null, page: "home" as const, scene: "horizon" as const, material: "lattice" as const };
function renderer() {
  return { capabilities: { webgl2: true as const, floatTargets: true }, material: "lattice" as const,
    melt: 0, press: vi.fn(), release: vi.fn(), shock: vi.fn(), resize: vi.fn(), setTier: vi.fn(), setPalette: vi.fn(), setAnchor: vi.fn(), setPointer: vi.fn(),
    draw: vi.fn((_frame: any, _dt: number): WorldDrawMetrics => ({ cpuMs: 1, gpuMs: 1, submitted: true, pointsSubmitted: true })), dispose: vi.fn() };
}
async function render(props: Partial<Parameters<typeof component.WorldScene>[0]> = {}, strict = false) {
  const element = react.createElement(component.WorldScene, { ...inputs, ...props });
  await react.act(async () => root.render(strict ? react.createElement(react.StrictMode, null, element) : element));
}
async function frame(milliseconds = 16) {
  await react.act(async () => {
    now += milliseconds;
    for (const [id, callback] of [...frames]) if (frames.delete(id)) callback(now);
  });
}
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers();
  react = await import("react"); component = await import("./WorldScene");
  const { createRoot } = await import("react-dom/client");
  now = 1000; sequence = 0; frames = new Map(); fake = renderer();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("pointer: fine"), addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  bridge.create.mockImplementation((_canvas, handlers) => { callbacks = handlers; return fake; });
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  document.documentElement.dataset.theme = "dark"; delete document.documentElement.dataset.worldIntro;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await react.act(async () => root.unmount()); container.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});
it("survives StrictMode setup and plays only once across a genuine remount", async () => {
  await render({}, true); await frame();
  expect(fake.draw.mock.calls.at(-1)![0].introActive).toBe(true);
  expect(document.documentElement.dataset.worldIntro).toBe("on");
  await react.act(async () => root.unmount());
  expect(document.documentElement.dataset.worldIntro).toBe("off");
  const { createRoot } = await import("react-dom/client"); root = createRoot(container);
  await render(); await frame();
  expect(fake.draw.mock.calls.at(-1)![0].introActive).toBe(false);
  expect(document.documentElement.dataset.worldIntro).toBe("off");
});
it("ends by a real deadline even without another animation frame", async () => {
  await render(); await frame();
  expect(document.documentElement.dataset.worldIntro).toBe("on");
  await react.act(async () => { now += 2500; vi.advanceTimersByTime(2500); });
  expect(document.documentElement.dataset.worldIntro).toBe("off");
  expect(fake.draw.mock.calls.at(-1)![0].introActive).toBe(false);
});
it("includes a delayed first scheduled draw in the 2.5 second entrance deadline", async () => {
  await render();
  expect(document.documentElement.dataset.worldIntro).toBe("on");
  await react.act(async () => { now += 1000; vi.advanceTimersByTime(1000); });
  await frame(0);
  expect(fake.draw.mock.calls.at(-1)![0].introActive).toBe(true);
  await react.act(async () => { now += 1500; vi.advanceTimersByTime(1500); });
  expect(document.documentElement.dataset.worldIntro).toBe("off");
  expect(fake.draw.mock.calls.at(-1)![0].introActive).toBe(false);
});
it("a press on a usable control immediately ends the intro without consuming its click", async () => {
  await render(); await frame();
  const button = document.createElement("button"), clicked = vi.fn(); button.addEventListener("click", clicked); container.append(button);
  await react.act(async () => {
    button.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    button.click();
  });
  expect(clicked).toHaveBeenCalledOnce();
  expect(document.documentElement.dataset.worldIntro).toBe("off");
  await frame(); expect(fake.draw.mock.calls.at(-1)![0].introActive).toBe(false);
  expect(fake.press).not.toHaveBeenCalled();
});
it("a press before the first scheduled draw cancels the pending entrance", async () => {
  await render();
  await react.act(async () => document.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
  await frame();
  expect(document.documentElement.dataset.worldIntro).toBe("off");
  expect(fake.draw.mock.calls.every(([value]) => !value.introActive)).toBe(true);
});
it("the real deadline still expires while rendering is paused", async () => {
  await render(); await frame(); await render({ paused: true });
  await react.act(async () => { now += 2500; vi.advanceTimersByTime(2500); });
  expect(document.documentElement.dataset.worldIntro).toBe("off");
  await render(); await frame();
  expect(fake.draw.mock.calls.at(-1)![0].introActive).toBe(false);
});
it("an unavailable background skips the entrance", async () => {
  bridge.create.mockReturnValue(null); await render(); await frame();
  expect(document.documentElement.dataset.worldIntro).toBe("off");
  expect(frames.size).toBe(0);
});
it.each([{ effects: "lite" as const }, { reducedMotion: true }, { page: "content" as const }, { material: "solid" as const }])("skips the first entry for %o and never replays later", async props => {
  await render(props); await frame();
  expect(document.documentElement.dataset.worldIntro).toBe("off");
  expect(fake.draw.mock.calls.every(([value]) => !value.introActive)).toBe(true);
  await render(); await frame();
  expect(document.documentElement.dataset.worldIntro).toBe("off");
});
it("preparation or leaving home ends an active entrance", async () => {
  await render(); await frame();
  expect(document.documentElement.dataset.worldIntro).toBe("on");
  await render({ phase: "preparing", fraction: .37 });
  expect(document.documentElement.dataset.worldIntro).toBe("off");
  await render({ page: "content" }); await frame();
  expect(document.documentElement.dataset.worldIntro).toBe("off");
});

it("submits a missed word keyframe after sparse draws, then resumes the real return clock", async () => {
  await render(); await frame(0); await frame(700);
  expect(fake.draw.mock.calls.at(-1)![0].introTime).toBeCloseTo(.7);
  await frame(900);
  const word = fake.draw.mock.calls.at(-1)![0];
  expect(word).toMatchObject({ introActive: true, introTime: 1, morph: { toWord: true, fromWord: false } });
  await frame(100);
  expect(fake.draw.mock.calls.at(-1)![0].introTime).toBe(1);
  await frame(21);
  const returning = fake.draw.mock.calls.at(-1)![0];
  expect(returning.morph).toMatchObject({ toWord: false, fromWord: true });
  expect(returning.introTime).toBeCloseTo(.321);
  expect(returning.simTime).toBeCloseTo(.171);
});

it.each([16, 1000 / 6])("keeps the ordinary %s ms word and return timeline without an extra hold", async interval => {
  await render(); await frame(0);
  let elapsed = 0;
  while (elapsed < 1800) {
    elapsed += interval; await frame(interval);
    const drawn = fake.draw.mock.calls.at(-1)![0];
    expect(drawn.introTime).toBeCloseTo((elapsed < 1400 ? elapsed : elapsed - 1400) / 1000);
    expect(drawn.morph.toWord).toBe(elapsed < 1400);
    expect(drawn.morph.fromWord).toBe(elapsed >= 1400);
  }
});

it("does not acknowledge a formed word from a publish-only paused update", async () => {
  await render(); await frame(0); await frame(700);
  now += 200;
  const count = fake.draw.mock.calls.length;
  await render({ paused: true });
  expect(fake.draw).toHaveBeenCalledTimes(count);
  now += 700; await render();
  expect(fake.draw.mock.calls.at(-1)![0]).toMatchObject({ introTime: 1, morph: { toWord: true, fromWord: false } });
});

it("acknowledges only actual submitted points and retries an unsuccessful supplemental draw", async () => {
  fake.draw.mockReturnValue({ cpuMs: 1, gpuMs: 1, submitted: true, pointsSubmitted: false });
  await render(); await frame(0); await frame(900); await frame(700);
  expect(fake.draw.mock.calls.at(-1)![0]).toMatchObject({ introTime: 1, morph: { toWord: true } });
  fake.draw.mockReturnValue({ cpuMs: 1, gpuMs: 1, submitted: true, pointsSubmitted: true });
  await frame(50);
  expect(fake.draw.mock.calls.at(-1)![0]).toMatchObject({ introTime: 1, morph: { toWord: true } });
  await frame(110);
  expect(fake.draw.mock.calls.at(-1)![0].morph.toWord).toBe(true);
  await frame(11);
  expect(fake.draw.mock.calls.at(-1)![0].morph.fromWord).toBe(true);
  expect(fake.draw.mock.calls.at(-1)![0].introTime).toBeCloseTo(.371);
});

it("clips a late supplemental hold at the original queue deadline", async () => {
  await render(); await frame(0); await frame(700); await frame(1750);
  expect(fake.draw.mock.calls.at(-1)![0]).toMatchObject({ introTime: 1, morph: { toWord: true } });
  await frame(49);
  expect(fake.draw.mock.calls.at(-1)![0].morph.toWord).toBe(true);
  await frame(2);
  expect(fake.draw.mock.calls.at(-1)![0].introActive).toBe(false);
  expect(document.documentElement.dataset.worldIntro).toBe("off");
});

it("does not renew the supplemental hold when the live palette updates", async () => {
  await render(); await frame(0); await frame(700); await frame(900); await frame(100);
  expect(fake.draw.mock.calls.at(-1)![0].morph.toWord).toBe(true);
  await react.act(async () => { document.documentElement.dataset.theme = "light"; });
  await frame(21);
  expect(fake.draw.mock.calls.at(-1)![0].morph.fromWord).toBe(true);
  expect(fake.draw.mock.calls.at(-1)![0].introTime).toBeCloseTo(.321);
});

it.each(["float", "lost"])("checks %s failure before reading a submitted-word acknowledgement", async failure => {
  await render(); await frame(0); await frame(700);
  const acknowledged = vi.fn(() => true);
  fake.draw.mockImplementationOnce(() => {
    if (failure === "float") fake.capabilities.floatTargets = false;
    else callbacks.onLost();
    return { cpuMs: 1, gpuMs: 1, submitted: failure !== "lost", get pointsSubmitted() { return acknowledged(); } };
  });
  await frame(900);
  expect(acknowledged).not.toHaveBeenCalled();
  expect(document.documentElement.dataset.worldIntro).toBe("off");
  if (failure === "float") {
    expect(fake.draw.mock.calls.at(-1)![0].introActive).toBe(false);
    expect(container.querySelector<HTMLElement>(".world-scene")!.dataset.worldParticles).toBe("0");
  } else expect(frames.size).toBe(0);
});

it.each([false, true])("expires an %s active entrance before drawing a stale rAF delivered after its deadline", async active => {
  await render();
  if (active) { await frame(0); await frame(700); }
  await react.act(async () => {
    now = 3501;
    for (const [id, callback] of [...frames]) if (frames.delete(id)) callback(1800);
  });
  expect(fake.draw.mock.calls.at(-1)![0].introActive).toBe(false);
  expect(document.documentElement.dataset.worldIntro).toBe("off");
});

it.each(["press", "prepare", "static", "pause", "hidden"])("lets %s immediately interrupt the supplemental hold", async interrupt => {
  await render(); await frame(0); await frame(700); await frame(900);
  expect(fake.draw.mock.calls.at(-1)![0].morph.toWord).toBe(true);
  if (interrupt === "press") {
    await react.act(async () => document.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
    await frame(16);
  } else if (interrupt === "prepare") await render({ phase: "preparing", fraction: .37 });
  else if (interrupt === "static") await render({ effects: "lite" });
  else {
    const count = fake.draw.mock.calls.length;
    if (interrupt === "pause") await render({ paused: true });
    else await react.act(async () => {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await frame(16);
    expect(fake.draw).toHaveBeenCalledTimes(count);
    if (interrupt === "pause") await render();
    else await react.act(async () => {
      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      document.dispatchEvent(new Event("visibilitychange"));
    });
  }
  expect(fake.draw.mock.calls.at(-1)![0].morph.toWord).toBe(false);
});
