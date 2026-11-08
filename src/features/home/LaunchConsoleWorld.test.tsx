// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createLauncherI18n } from "../../i18n";
import { WorldScene } from "../../components/WorldScene";
import { LaunchConsole } from "./LaunchConsole";

const world = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../../components/world/renderer", () => ({ createWorldRenderer: world.create }));
vi.mock("../../app/AppearanceProvider", () => ({ useAppearance: () => ({
  effects: "full", reducedMotion: false, reducedTransparency: false, highContrast: false,
}) }));
vi.mock("../../visual/glass/GlassSystem", () => ({
  GlassSurface: ({ className, children }: { className?: string; children?: ReactNode }) => <div className={className}>{children}</div>,
}));
vi.mock("./InstancePicker", () => ({ InstancePicker: () => <button>Instance picker</button> }));

let root: Root, container: HTMLDivElement;
let renderer: { press: ReturnType<typeof vi.fn>; shock: ReturnType<typeof vi.fn> };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("pointer: fine"),
    addEventListener() {}, removeEventListener() {} }));
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  renderer = { press: vi.fn(), shock: vi.fn() };
  world.create.mockReturnValue({ ...renderer, capabilities: { webgl2: true, floatTargets: true },
    material: "solid", melt: 0, release: vi.fn(), resize: vi.fn(), setTier: vi.fn(), setPalette: vi.fn(),
    setAnchor: vi.fn(), setPointer: vi.fn(), dispose: vi.fn(), pollFrameComplete: vi.fn(() => true),
    draw: vi.fn(() => ({ cpuMs: 1, gpuMs: null, submitted: true, pointsSubmitted: true })),
  });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

async function tap(target: Element) {
  await act(async () => {
    for (const type of ["pointerdown", "pointerup"]) {
      const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: 500, clientY: 400 });
      Object.assign(event, { pointerId: 1, pointerType: "mouse" }); target.dispatchEvent(event);
    }
  });
}

it("keeps a running launch pill's bare area out of the actual world's press and shock handlers", async () => {
  const i18n = createLauncherI18n("en-US", "en-US"); await i18n.initPromise;
  async function render(running: boolean) {
    await act(async () => root.render(<I18nextProvider i18n={i18n}>
      <WorldScene phase={running ? "running" : "idle"} fraction={null} page="home" scene="horizon" material="lattice" />
      <LaunchConsole instances={[]} pickerOpen={false} onPickerOpenChange={() => {}} onSelectInstance={() => {}}
        onLaunch={async () => {}} onStop={async () => {}} onCancel={async () => {}} onOpenFolder={() => {}}
        busy="" running={running} progress={null} />
      <div data-testid="blank-world" />
    </I18nextProvider>));
  }
  await render(false);
  await tap(container.querySelector('[data-testid="blank-world"]')!);
  expect(renderer.press).toHaveBeenCalledTimes(1);
  expect(renderer.shock).toHaveBeenCalledTimes(1);
  renderer.press.mockClear(); renderer.shock.mockClear();
  await render(true);
  const bare = container.querySelector('.vx-launch-console__content:not([inert]) .vx-launch-console__running')!;
  expect(bare).not.toBeNull();
  await tap(bare);
  expect(renderer.press).not.toHaveBeenCalled();
  expect(renderer.shock).not.toHaveBeenCalled();
  expect(container.querySelector('.vx-launch-console__launch')?.classList.contains("vx-glass-surface")).toBe(false);
});
