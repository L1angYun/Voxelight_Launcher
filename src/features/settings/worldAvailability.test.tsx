// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { createLauncherI18n } from "../../i18n";
import { defaults } from "../../lib/launcher";
import { publishWorldAvailability } from "../../components/world/worldAvailability";
import { AppearanceSettings } from "./AppearanceSettings";

vi.mock("../../app/AppearanceProvider", () => ({ useAppearance: () => ({ effects: "lite", reducedMotion: false, reducedTransparency: false, highContrast: false, accentColor: "#b4f17a" }) }));
vi.mock("../../visual/glass/GlassSystem", () => ({ GlassSurface: ({ children }: { children?: React.ReactNode }) => createElement("div", null, children) }));
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); publishWorldAvailability("unknown");
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); publishWorldAvailability("unknown"); vi.unstubAllGlobals(); });
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
    await act(async () => publishWorldAvailability("available"));
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(control.textContent).toContain(selected);
  });
}
