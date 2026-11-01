// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createLauncherI18n } from "../../i18n";
import type { Instance } from "../../lib/launcher";
import { InstancePicker } from "./InstancePicker";

vi.mock("../../visual/glass/GlassSystem", () => ({
  GlassSurface: ({ children, className, style }: { children: React.ReactNode; className?: string; style?: React.CSSProperties }) =>
    createElement("div", { className, style }, children),
}));
vi.mock("../../app/AppearanceProvider", () => ({
  useAppearance: () => ({ effects: mockEffects, reducedMotion: false, reducedTransparency: false, highContrast: false }),
}));
let mockEffects: "full" | "lite" = "lite";

function instance(id: string, name: string, loader = "vanilla"): Instance {
  return {
    id, name, loader, versionId: "1.21.1", loaderVersion: loader === "fabric" ? "0.16.5" : "",
    gameDirectory: `C:\\Fixtures\\${id}`, createdAt: "2026-10-25T08:00:00Z", category: "",
    iconPath: null, notes: "", maxMemoryMb: null, javaPath: null, jvmArguments: null,
    screenWidth: null, screenHeight: null, totalPlayTime: 0,
  };
}

const choices = [instance("alpha", "Alpha world", "fabric"), instance("alpine", "Alpine world"), instance("beta", "Beta world", "forge")];
let root: Root;
let container: HTMLDivElement;
let onSelect: Mock<(id?: string) => void>;
let anchor = { x: 24, y: 600, width: 208, height: 48 };
let clock = 0;

function trigger() { return container.querySelector<HTMLButtonElement>('[role="combobox"]')!; }
function listbox() { return [...document.querySelectorAll<HTMLElement>('[role="listbox"]')].find((list) => !list.closest('[aria-hidden="true"]')) ?? null; }
function activeOption() { return document.getElementById(trigger().getAttribute("aria-activedescendant") ?? ""); }
async function press(key: string) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  await act(async () => trigger().dispatchEvent(event));
  return event;
}
async function render(instances = choices, selected = "alpha") {
  const i18n = createLauncherI18n("en-US", "en-US");
  await i18n.initPromise;
  await act(async () => root.render(createElement(I18nextProvider, { i18n },
    createElement("div", { style: { overflow: "hidden", transform: "translateX(0)" } },
      createElement(InstancePicker, { instance: instances.find((item) => item.id === selected), instances, versionId: "1.21.1", onSelectInstance: onSelect })),
    createElement("button", { id: "outside" }, "Outside"))));
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  clock = 0;
  mockEffects = "lite";
  onSelect = vi.fn<(id?: string) => void>();
  anchor = { x: 24, y: 600, width: 208, height: 48 };
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1050 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 720 });
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.getAttribute("role") !== "combobox") return new DOMRect();
    return new DOMRect(anchor.x, anchor.y, anchor.width, anchor.height);
  });
  container = document.createElement("div");
  container.className = "vx-glass-provider";
  container.dataset.glassMode = "full";
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("InstancePicker", () => {
  it("renders real names and loader metadata, marks the selection, and chooses a visible option", async () => {
    const long = "A very long custom instance name ".repeat(8);
    await render([instance("alpha", long, "fabric"), choices[2]]);
    expect(container.querySelector("select")).toBeNull();
    expect(trigger().textContent).toContain(long);
    await act(async () => trigger().click());
    const selected = listbox()!.querySelector('[role="option"][aria-selected="true"]')!;
    expect(selected.textContent).toContain("1.21.1 · fabric 0.16.5");
    expect(selected.querySelector("svg[data-selected-mark]")).not.toBeNull();
    expect(selected.querySelector<HTMLElement>("[title]")!.title).toBe(long);
    await act(async () => listbox()!.querySelector<HTMLElement>('[data-instance-id="beta"]')!.click());
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("beta");
    expect(listbox()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("keeps DOM focus on the trigger while Arrow, Home and End explore without committing", async () => {
    await render();
    trigger().focus();
    await press("ArrowDown");
    expect(document.activeElement).toBe(trigger());
    expect(activeOption()?.getAttribute("data-instance-id")).toBe("alpha");
    await press("End");
    expect(activeOption()?.hasAttribute("data-version-directory")).toBe(true);
    await press("Home");
    await press("ArrowDown");
    expect(activeOption()?.getAttribute("data-instance-id")).toBe("alpine");
    expect(onSelect).not.toHaveBeenCalled();
    await press("Enter");
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("alpine");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("commits the explicit version-directory option with Space", async () => {
    await render();
    await press(" ");
    await press("End");
    expect(activeOption()?.textContent).toContain("Use version directory");
    await press(" ");
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("cancels with Escape and lets Tab commit without preventing native focus movement", async () => {
    await render();
    trigger().focus();
    await press("ArrowDown");
    await press("ArrowDown");
    await press("Escape");
    expect(onSelect).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger());
    await press("ArrowDown");
    await press("ArrowDown");
    const tab = await press("Tab");
    expect(tab.defaultPrevented).toBe(false);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("alpine");
    expect(listbox()).toBeNull();
  });

  it("supports buffered typeahead and repeated-letter cycling without changing selection early", async () => {
    await render();
    await press("a");
    expect(activeOption()?.getAttribute("data-instance-id")).toBe("alpine");
    clock += 50;
    await press("a");
    expect(activeOption()?.getAttribute("data-instance-id")).toBe("alpha");
    clock += 800;
    await press("a");
    await press("l");
    await press("p");
    await press("h");
    expect(activeOption()?.getAttribute("data-instance-id")).toBe("alpha");
    expect(onSelect).not.toHaveBeenCalled();
    await press("Enter");
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("alpha");
  });

  it("closes for an outside pointer without preventing or restoring the target focus", async () => {
    await render();
    trigger().focus();
    await press("ArrowDown");
    const outside = container.querySelector<HTMLButtonElement>("#outside")!;
    outside.addEventListener("pointerdown", (event) => event.stopPropagation());
    const pointer = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });
    await act(async () => outside.dispatchEvent(pointer));
    expect(listbox()).toBeNull();
    await act(async () => outside.focus());
    expect(pointer.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(outside);
    expect(listbox()).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("portals above a low anchor and keeps a tall menu within viewport margins", async () => {
    await render(Array.from({ length: 40 }, (_, index) => instance(String(index), `World ${index}`)), "0");
    anchor.x = 980;
    await act(async () => trigger().click());
    const popup = document.querySelector<HTMLElement>(".vx-instance-picker__popover")!;
    expect(popup.parentElement).toBe(container);
    expect(popup.dataset.placement).toBe("top");
    expect(popup.style.position).toBe("fixed");
    expect(Number.parseFloat(popup.style.left)).toBeGreaterThanOrEqual(16);
    expect(Number.parseFloat(popup.style.left) + Number.parseFloat(popup.style.width)).toBeLessThanOrEqual(1034);
    expect(Number.parseFloat(popup.style.top)).toBeGreaterThanOrEqual(16);
    expect(Number.parseFloat(popup.style.top) + Number.parseFloat(popup.style.maxHeight)).toBeLessThanOrEqual(704);
    expect(Number.parseFloat(listbox()!.style.maxHeight)).toBeLessThan(40 * 60);
  });

  it("repositions on viewport changes and closes without focusing when the anchor scrolls away", async () => {
    await render();
    anchor.y = 100;
    await act(async () => trigger().click());
    expect(document.querySelector<HTMLElement>(".vx-instance-picker__popover")!.dataset.placement).toBe("bottom");
    anchor.y = 600;
    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(document.querySelector<HTMLElement>(".vx-instance-picker__popover")!.dataset.placement).toBe("top");
    const outside = container.querySelector<HTMLButtonElement>("#outside")!;
    outside.focus();
    anchor.y = -100;
    await act(async () => window.dispatchEvent(new Event("scroll")));
    expect(listbox()).toBeNull();
    expect(document.activeElement).toBe(outside);
  });

  it("keeps the active bottom option visible when the open menu loses vertical space", async () => {
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("role") === "option" ? Number(this.id.split("-").at(-1)) * 60 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("role") === "option" ? 60 : 0;
    });
    vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("role") === "listbox" ? Number.parseFloat(this.style.maxHeight) : 0;
    });
    await render(Array.from({ length: 40 }, (_, index) => instance(String(index), `World ${index}`)), "39");
    await press("ArrowDown");
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 420 });
    anchor.y = 200;
    await act(async () => window.dispatchEvent(new Event("resize")));
    const list = listbox()!;
    const option = activeOption()!;
    expect(option.offsetTop).toBeGreaterThanOrEqual(list.scrollTop);
    expect(option.offsetTop + option.offsetHeight).toBeLessThanOrEqual(list.scrollTop + list.clientHeight);
  });

  it("commits immediately and makes exiting pointer options inert before their transition finishes", async () => {
    mockEffects = "full";
    await render();
    await act(async () => trigger().dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
    const option = listbox()!.querySelector<HTMLElement>('[data-instance-id="beta"]')!;
    await act(async () => option.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("beta");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(listbox()).toBeNull();
    const exiting = document.querySelector(".vx-instance-picker__popover");
    expect(exiting?.getAttribute("aria-hidden")).toBe("true");
    expect(exiting?.hasAttribute("inert")).toBe(true);
  });

  it("keeps the glass positioning ancestor opaque throughout a pointer entrance", async () => {
    mockEffects = "full";
    await render();
    await act(async () => trigger().dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
    const popup = document.querySelector<HTMLElement>(".vx-instance-picker__popover")!;
    // An alpha below one on an ancestor cuts off the glass's real backdrop.
    expect(Number(popup.style.opacity || 1)).toBe(1);
  });
});
