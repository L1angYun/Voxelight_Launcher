// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLauncherI18n } from "../../i18n";
import { HomeAnimationSelector } from "./HomeAnimationSelector";

const appearance = { effects: "lite", reducedMotion: false, reducedTransparency: false, highContrast: false };
vi.mock("../../app/AppearanceProvider", () => ({ useAppearance: () => appearance }));
vi.mock("../../visual/glass/GlassSystem", () => ({
  GlassSurface: ({ children, className }: { children: React.ReactNode; className?: string }) => createElement("div", { className }, children),
}));

let root: Root, container: HTMLDivElement;
const onChange = vi.fn();
const trigger = () => container.querySelector<HTMLButtonElement>('[role="combobox"]')!;
async function render(locale = "zh-CN", props: Partial<Parameters<typeof HomeAnimationSelector>[0]> = {}) {
  const i18n = createLauncherI18n(locale, locale);
  await i18n.initPromise;
  await act(async () => root.render(createElement(I18nextProvider, { i18n }, createElement(HomeAnimationSelector, {
    value: "idle", onChange, visible: true, ...props,
  }))));
}
async function key(key: string) {
  await act(async () => trigger().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  appearance.effects = "lite"; appearance.reducedMotion = false;
  appearance.reducedTransparency = false; appearance.highContrast = false;
  onChange.mockReset();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.getAttribute("role") === "combobox" ? new DOMRect(700, 120, 160, 48) : new DOMRect();
  });
  container = document.createElement("div"); container.className = "vx-glass-provider";
  document.body.append(container); root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount()); container.remove(); vi.restoreAllMocks();
});

describe("home animation selector", () => {
  it.each([
    ["zh-CN", "动画模式", "站立", "行走", "奔跑"],
    ["en-US", "Animation mode", "Idle", "Walk", "Run"],
  ])("selects a translated running mode through the shared control in %s", async (locale, label, idle, walk, run) => {
    await render(locale);
    expect(trigger().getAttribute("aria-label")).toBe(label);
    expect(trigger().textContent).toContain(idle);
    await act(async () => trigger().click());
    const choices = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(choices.map(choice => choice.textContent)).toEqual([idle, walk, run]);
    await act(async () => choices[2].click());
    expect(onChange).toHaveBeenCalledExactlyOnceWith("run");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    await render(locale, { value: "run" });
    expect(trigger().textContent).toContain(run);
  });

  it("keeps the shared keyboard choice and focus behavior when its hover state is hidden", async () => {
    await render("en-US", { visible: false, "aria-label": "Preview pose" });
    trigger().focus();
    await key("ArrowDown"); await key("ArrowDown"); await key("Enter");
    expect(trigger().getAttribute("aria-label")).toBe("Preview pose");
    expect(onChange).toHaveBeenCalledExactlyOnceWith("walk");
    expect(document.activeElement).toBe(trigger());
  });

  it("cannot change the selected pose while disabled for a launch state", async () => {
    await render("en-US", { value: "run", disabled: true });
    expect(trigger().disabled).toBe(true);
    await act(async () => trigger().click());
    await key("ArrowDown");
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger().textContent).toContain("Run");
  });

  it.each(["lite", "reduced motion"])("keeps pointer-opened selection static under %s", async policy => {
    appearance.effects = policy === "lite" ? "lite" : "full";
    appearance.reducedMotion = policy === "reduced motion";
    await render("en-US");
    await act(async () => trigger().dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true })));
    const popup = document.querySelector<HTMLElement>('.vx-listbox-popover');
    expect(popup?.dataset.animate).toBe("false");
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(3);
  });
});
