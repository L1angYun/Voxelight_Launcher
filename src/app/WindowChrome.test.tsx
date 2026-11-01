// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLauncherI18n } from "../i18n";
import { GlassProvider, GlassSurface } from "../visual/glass/GlassSystem";
import { WindowChrome } from "./WindowChrome";

const desktopWindow = vi.hoisted(() => ({
  maximized: false,
  isMaximized: vi.fn(async (): Promise<boolean> => desktopWindow.maximized),
  toggleMaximize: vi.fn(async (): Promise<void> => { desktopWindow.maximized = !desktopWindow.maximized; }),
  minimize: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  disposeResize: vi.fn(),
  onResized: vi.fn(async (_callback: () => void): Promise<() => void> => desktopWindow.disposeResize),
}));

vi.mock("../lib/window", () => ({ getLauncherWindow: () => desktopWindow }));
vi.mock("../visual/glass/renderer", () => ({
  createGlassRenderer: () => ({
    mode: "fallback", surfaceCount: 0,
    upsert() {}, remove() {}, resize() {}, update() {}, setQuality() {},
    setBackground() {}, pause() {}, dispose() {},
  }),
}));

describe("window chrome navigation track", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    desktopWindow.maximized = false;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete document.documentElement.dataset.windowState;
  });

  async function render(locale: "zh-CN" | "en-US" = "zh-CN", children?: ReactNode) {
    const i18n = createLauncherI18n(locale, locale);
    await i18n.initPromise;
    await act(async () => root.render(
      <I18nextProvider i18n={i18n}>
        <GlassProvider effects="lite">
          <WindowChrome>{children}</WindowChrome>
        </GlassProvider>
      </I18nextProvider>,
    ));
  }

  it("registers only the selected capsule as glass, leaving its exterior track clear", async () => {
    await render("zh-CN", <GlassSurface variant="control" className="vx-floating-nav__indicator" />);
    const track = container.querySelector<HTMLElement>(".vx-window-chrome__bar")!;
    expect(track.classList.contains("vx-glass-surface")).toBe(false);
    expect(track.getAttribute("data-glass-variant")).toBeNull();
    expect(container.querySelector(".vx-glass-provider")?.getAttribute("data-glass-surface-count")).toBe("1");
    expect(track.querySelectorAll(".vx-glass-surface")).toHaveLength(1);
    expect(track.querySelector(".vx-floating-nav__indicator")?.getAttribute("data-visual-owner")).toBe("lens");
  });

  it.each([
    { locale: "zh-CN" as const, group: "窗口控制", minimize: "最小化", maximize: "最大化", restore: "还原", close: "关闭" },
    { locale: "en-US" as const, group: "Window controls", minimize: "Minimize", maximize: "Maximize", restore: "Restore", close: "Close" },
  ])("preserves localized desktop window actions in $locale", async (labels) => {
    await render(labels.locale);
    const group = container.querySelector(`[role="group"][aria-label="${labels.group}"]`)!;
    const click = async (label: string) => {
      const button = group.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
      expect(button).not.toBeNull();
      await act(async () => button!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    };
    await click(labels.minimize);
    expect(desktopWindow.minimize).toHaveBeenCalledTimes(1);
    await click(labels.maximize);
    expect(container.querySelector("header")?.getAttribute("data-window-state")).toBe("maximized");
    expect(document.documentElement.dataset.windowState).toBe("maximized");
    await click(labels.restore);
    expect(container.querySelector("header")?.getAttribute("data-window-state")).toBe("normal");
    expect(desktopWindow.toggleMaximize).toHaveBeenCalledTimes(2);
    await click(labels.close);
    expect(desktopWindow.close).toHaveBeenCalledTimes(1);
    expect(container.querySelector("header")?.getAttribute("data-tauri-drag-region")).toBe("deep");
    expect(container.querySelector(".vx-window-chrome__brand")?.textContent).toBe("Voxelight");
    await act(async () => root.unmount());
    expect(desktopWindow.disposeResize).toHaveBeenCalledTimes(1);
    root = createRoot(container);
  });
});
