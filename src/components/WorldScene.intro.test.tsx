// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("./world/renderer", () => ({ createWorldRenderer: bridge.create }));
let react: typeof import("react"), component: typeof import("./WorldScene");
let root: Root, container: HTMLDivElement, now: number, sequence: number;
let frames: Map<number, FrameRequestCallback>;
let fake: ReturnType<typeof renderer>;
const inputs = { phase: "idle" as const, fraction: null, page: "home" as const, scene: "horizon" as const, material: "lattice" as const };
function renderer() {
  return { capabilities: { webgl2: true as const, floatTargets: true }, material: "lattice" as const,
    melt: 0, press: vi.fn(), release: vi.fn(), shock: vi.fn(), resize: vi.fn(), setTier: vi.fn(), setPalette: vi.fn(), setAnchor: vi.fn(), setPointer: vi.fn(),
    draw: vi.fn((_frame: any, _dt: number) => ({ cpuMs: 1, gpuMs: 1 })), dispose: vi.fn() };
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
  bridge.create.mockImplementation(() => fake);
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
