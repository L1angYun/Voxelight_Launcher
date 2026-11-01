// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createLauncherI18n } from "../../i18n";
import { Select, type SelectOption } from "./Select";
import { Dialog } from "./Dialog";

vi.mock("../../visual/glass/GlassSystem", () => ({
  GlassSurface: ({ children, className, style }: { children: React.ReactNode; className?: string; style?: React.CSSProperties }) => createElement("div", { className, style }, children),
}));
vi.mock("../../app/AppearanceProvider", () => ({
  useAppearance: () => ({ effects: "lite", reducedMotion: true, reducedTransparency: false, highContrast: false }),
}));

const options: SelectOption[] = [
  { value: "official", label: "Official only" },
  { value: "blocked", label: "Unavailable mirror", disabled: true },
  { value: "auto", label: "Automatic fallback" },
  { value: "bmclapi", label: "BMCLAPI preferred" },
];
let root: Root;
let container: HTMLDivElement;
let onChange: Mock<(value: string) => void>;
let dialogChanges: Mock<(open: boolean) => void>;
const anchor = { y: 600 };

function trigger() { return container.querySelector<HTMLButtonElement>('[role="combobox"]')!; }
function listbox() { return [...document.querySelectorAll<HTMLElement>('[role="listbox"]')].find((list) => !list.closest('[aria-hidden="true"]')) ?? null; }
function active() { return document.getElementById(trigger().getAttribute("aria-activedescendant") ?? ""); }
async function key(value: string) {
  await act(async () => trigger().dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })));
}
async function render({ choices = options, disabled = false, dialog = false }: { choices?: SelectOption[]; disabled?: boolean; dialog?: boolean } = {}) {
  const i18n = createLauncherI18n("en-US", "en-US");
  await i18n.initPromise;
  const control = createElement(Select, { id: "source", "aria-label": "Game download source", value: "official", options: choices, onChange, disabled });
  await act(async () => root.render(createElement(I18nextProvider, { i18n }, dialog
    ? createElement(Dialog, { open: true, onOpenChange: dialogChanges, title: "Install" }, control)
    : createElement("div", { style: { overflow: "hidden", transform: "translateX(0)" } }, control))));
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  anchor.y = 600;
  onChange = vi.fn<(value: string) => void>();
  dialogChanges = vi.fn<(open: boolean) => void>();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1050 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 720 });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function () { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function () { this.open = false; } });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => {} });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.getAttribute("role") === "combobox" ? new DOMRect(24, anchor.y, 260, 48) : new DOMRect();
  });
  container = document.createElement("div");
  container.className = "vx-glass-provider";
  container.dataset.glassMode = "lite";
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("shared Select", () => {
  it("has one visible control and no native select, and selects real rendered options", async () => {
    await render();
    expect(container.querySelector("select")).toBeNull();
    expect(trigger().textContent).toContain("Official only");
    await act(async () => trigger().click());
    const option = [...listbox()!.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent?.includes("BMCLAPI"))!;
    await act(async () => option.click());
    expect(onChange).toHaveBeenCalledExactlyOnceWith("bmclapi");
    expect(listbox()).toBeNull();
  });

  it("keeps focus on its trigger, skips disabled rows and commits with Enter", async () => {
    await render();
    trigger().focus();
    await key("ArrowDown");
    await key("ArrowDown");
    expect(active()?.textContent).toContain("Automatic fallback");
    expect(document.activeElement).toBe(trigger());
    expect(onChange).not.toHaveBeenCalled();
    await key("Enter");
    expect(onChange).toHaveBeenCalledExactlyOnceWith("auto");
  });

  it("does not open or emit selection when disabled or all options are unavailable", async () => {
    await render({ disabled: true });
    await act(async () => trigger().click());
    expect(listbox()).toBeNull();
    await render({ choices: [{ value: "official", label: "Unavailable", disabled: true }] });
    await act(async () => trigger().click());
    expect(listbox()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("places a bounded shared popup above a low trigger outside its clipped wrapper", async () => {
    await render();
    await act(async () => trigger().click());
    const popup = document.querySelector<HTMLElement>(".vx-listbox-popover");
    expect(popup).not.toBeNull();
    expect(popup!.parentElement).toBe(container);
    expect(popup!.dataset.placement).toBe("top");
    expect(Number.parseFloat(popup!.style.top)).toBeGreaterThanOrEqual(16);
  });

  it("keeps a dialog menu inside that dialog and Escape closes only the menu", async () => {
    await render({ dialog: true });
    await key("ArrowDown");
    const popup = document.querySelector<HTMLElement>(".vx-listbox-popover");
    expect(popup?.parentElement).toBe(container.querySelector("dialog"));
    await key("Escape");
    expect(listbox()).toBeNull();
    expect(dialogChanges).not.toHaveBeenCalled();
    expect(container.querySelector("dialog")!.open).toBe(true);
  });
});
