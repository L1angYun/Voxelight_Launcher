// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { createLauncherI18n } from "../../i18n";
import { defaults } from "../../lib/launcher";
import { publishWorldAvailability, publishWorldPaused } from "../../components/world/worldAvailability";
import { WORLD_INTRO_REPLAY_EVENT } from "../../components/world/worldReplay";
import { AppearanceSettings } from "./AppearanceSettings";

const appearanceState = vi.hoisted(() => ({
  current: { effects: "lite" as "lite" | "full", reducedMotion: false, reducedTransparency: false, highContrast: false, accentColor: "#0078d4" },
}));
vi.mock("../../app/AppearanceProvider", () => ({ useAppearance: () => appearanceState.current }));
vi.mock("../../visual/glass/GlassSystem", () => ({ GlassSurface: ({ children }: { children?: React.ReactNode }) => createElement("div", null, children) }));
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  appearanceState.current = { effects: "lite", reducedMotion: false, reducedTransparency: false, highContrast: false, accentColor: "#b4f17a" };
  publishWorldAvailability("unknown");
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); publishWorldAvailability("unknown"); publishWorldPaused(false); vi.unstubAllGlobals(); });
for (const [locale, label, selected] of [["en-US", "World material", "Lattice"], ["zh-CN", "世界材质", "点阵"]]) {
  it(`${locale} explains actual fallback while retaining the requested particle material`, async () => {
    const i18n = createLauncherI18n(locale, locale); await i18n.initPromise;
    const onChange = vi.fn();
    await act(async () => {
      publishWorldAvailability("solid-only");
      root.render(createElement(I18nextProvider, { i18n }, createElement(AppearanceSettings, { config: defaults, onChange, onPersisted: vi.fn(), onPersistedPatch: vi.fn(), onError: vi.fn(), onNotice: vi.fn() })));
    });
    const status = container.querySelector<HTMLElement>('[role="status"]')!;
    expect(status.textContent).toMatch(/floating-point|浮点/i);
    const control = container.querySelector(`[role="combobox"][aria-label="${label}"]`)!;
    expect(control.textContent).toContain(selected);
    expect(control.getAttribute("aria-describedby")).toContain(status.id);
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => publishWorldAvailability("lite"));
    expect(container.querySelector('[role="status"]')?.textContent).toMatch(/Lite|精简/i);
    await act(async () => publishWorldAvailability("available"));
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(control.textContent).toContain(selected);
  });
}

it("shows the replay entrance button in Settings > Appearance only when an animated lattice intro is active", async () => {
  const i18n = createLauncherI18n("zh-CN", "zh-CN");
  await i18n.initPromise;
  const replayed = vi.fn();
  window.addEventListener(WORLD_INTRO_REPLAY_EVENT, replayed);
  const renderSettings = async (overrides: Partial<typeof defaults> = {}) => {
    await act(async () => {
      root.render(createElement(I18nextProvider, { i18n }, createElement(AppearanceSettings, {
        config: { ...defaults, ...overrides },
        onChange: vi.fn(),
        onPersisted: vi.fn(),
        onPersistedPatch: vi.fn(),
        onError: vi.fn(),
        onNotice: vi.fn(),
      })));
    });
  };
  try {
    // Hidden in Lite effects.
    await renderSettings({ effects: "lite" });
    expect(container.querySelector("[data-world-intro-replay]")).toBeNull();

    // Shown in Full + Lattice + available, with localized accessible name.
    appearanceState.current = { effects: "full", reducedMotion: false, reducedTransparency: false, highContrast: false, accentColor: "#b4f17a" };
    await act(async () => publishWorldAvailability("available"));
    await renderSettings({ effects: "full", worldMaterial: "lattice", worldScene: "horizon" });
    const button = container.querySelector<HTMLButtonElement>("[data-world-intro-replay]");
    expect(button).not.toBeNull();
    expect(button?.type).toBe("button");
    expect(button?.getAttribute("aria-label")).toBe("重播入场动画");
    expect(button?.textContent?.trim()).toBe("重播入场动画");
    await act(async () => { button!.click(); });
    expect(replayed).toHaveBeenCalledTimes(1);

    // Also shown for Massif + Lattice.
    await renderSettings({ effects: "full", worldMaterial: "lattice", worldScene: "massif" });
    expect(container.querySelector("[data-world-intro-replay]")).not.toBeNull();

    // Hidden for Solid material.
    await renderSettings({ effects: "full", worldMaterial: "solid" });
    expect(container.querySelector("[data-world-intro-replay]")).toBeNull();

    // Hidden for reduced motion and high contrast (static tier).
    appearanceState.current = { ...appearanceState.current, reducedMotion: true };
    await renderSettings({ effects: "full", worldMaterial: "lattice" });
    expect(container.querySelector("[data-world-intro-replay]")).toBeNull();

    appearanceState.current = { ...appearanceState.current, reducedMotion: false, highContrast: true };
    await renderSettings({ effects: "full", worldMaterial: "lattice" });
    expect(container.querySelector("[data-world-intro-replay]")).toBeNull();

    // Hidden when availability reports solid-only, css, or lite.
    appearanceState.current = { ...appearanceState.current, highContrast: false };
    await renderSettings({ effects: "full", worldMaterial: "lattice" });
    expect(container.querySelector("[data-world-intro-replay]")).not.toBeNull();
    for (const unavailable of ["solid-only", "css", "lite"] as const) {
      await act(async () => publishWorldAvailability(unavailable));
      expect(container.querySelector("[data-world-intro-replay]"), unavailable).toBeNull();
    }
  } finally {
    window.removeEventListener(WORLD_INTRO_REPLAY_EVENT, replayed);
  }
});

it("hides Replay intro while the shell pauses the world scene under a custom background", async () => {
  const i18n = createLauncherI18n("en-US", "en-US");
  await i18n.initPromise;
  appearanceState.current = { effects: "full", reducedMotion: false, reducedTransparency: false, highContrast: false, accentColor: "#b4f17a" };
  await act(async () => {
    publishWorldAvailability("available");
    root.render(createElement(I18nextProvider, { i18n }, createElement(AppearanceSettings, {
      config: { ...defaults, effects: "full", worldMaterial: "lattice", worldScene: "horizon", customBackground: "C:\\SyntheticFixture\\background.png" },
      onChange: vi.fn(), onPersisted: vi.fn(), onPersistedPatch: vi.fn(), onError: vi.fn(), onNotice: vi.fn(),
    })));
  });
  // A configured image that fails to load leaves the scene running: the button stays.
  expect(container.querySelector("[data-world-intro-replay]")).not.toBeNull();
  await act(async () => publishWorldPaused(true));
  expect(container.querySelector("[data-world-intro-replay]")).toBeNull();
  await act(async () => publishWorldPaused(false));
  expect(container.querySelector("[data-world-intro-replay]")).not.toBeNull();
});
