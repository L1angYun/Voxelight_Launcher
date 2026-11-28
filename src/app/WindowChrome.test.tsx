// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { readFileSync } from "node:fs";
import { parse, type Root as Root_, type Rule } from "postcss";
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

  it("draws the brand mark at the lg icon size and the window controls at the sm control size", async () => {
    await render();
    const mark = container.querySelector(".vx-window-chrome__brand svg")!;
    expect(mark.getAttribute("width")).toBe("20");
    expect(mark.getAttribute("height")).toBe("20");
    expect(mark.getAttribute("stroke-width")).toBe("2");
    const controls = [...container.querySelectorAll<HTMLButtonElement>(".vx-window-chrome__controls .vx-button")];
    expect(controls).toHaveLength(3);
    for (const control of controls) {
      expect(control.classList.contains("vx-button--sm"), control.getAttribute("aria-label") ?? "").toBe(true);
      expect(control.querySelector("svg")?.getAttribute("width")).toBe("14");
    }
  });
});

describe("shell stylesheets", () => {
  const shell = parse(readFileSync("src/app/shell.css", "utf8"));
  const fileDrop = parse(readFileSync("src/app/file-drop.css", "utf8"));
  function declarations(sheet: Root_, selector: string, media?: RegExp) {
    const found: Record<string, string> = {};
    sheet.walkRules((rule: Rule) => {
      if (!rule.selectors.some((item) => item.trim() === selector)) return;
      const parent = rule.parent as { type?: string; name?: string; params?: string } | undefined;
      const inMedia = parent?.type === "atrule" && parent.name === "media" ? parent.params ?? "" : "";
      if (media ? !media.test(inMedia) : inMedia) return;
      rule.walkDecls((declaration) => { found[declaration.prop] = declaration.value; });
    });
    return found;
  }

  it("lifts the skip link above every overlay and drops the dead scene opacity", () => {
    expect(declarations(shell, ".vx-skip-link")["z-index"]).toBe("var(--z-skip-link)");
    expect(declarations(shell, ".vx-app-body > .vx-global-scene.world-scene").opacity).toBeUndefined();
  });

  it("keeps window controls on the shared sm geometry with the concentric window radius", () => {
    const controls = declarations(shell, ".vx-window-chrome__controls .vx-button");
    expect(controls["min-height"]).toBeUndefined();
    expect(controls["min-width"]).toBeUndefined();
    expect(controls["border-radius"]).toBe("var(--radius-window-control)");
    const close = declarations(shell, ".vx-window-chrome__controls .vx-button:last-child:hover", /hover: hover/);
    expect(close.background).toBe("var(--danger-fill)");
    expect(close.color).toBe("var(--text-on-danger)");
    expect(declarations(shell, ".vx-floating-nav__avatar").width).toBe("var(--icon-lg)");
  });

  it("uses tokens instead of ad hoc colour mixes and retired aliases", () => {
    const css = readFileSync("src/app/shell.css", "utf8");
    expect(css).not.toContain("color-mix(");
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    for (const alias of ["--bg-base", "--bg-raised", "--text-brand", "--surface-hover", "--text-xs", "--text-sm", "--text-md", "--text-2xl"])
      expect(css, alias).not.toContain(`var(${alias}`);
  });

  it("dims the page behind a file drop with the strong scrim and frames the target with the indicator accent", () => {
    expect(declarations(fileDrop, ".vx-file-drop-overlay").background).toBe("var(--scrim-strong)");
    const card = declarations(fileDrop, ".vx-file-drop-overlay__card");
    expect(card.border).toBe("2px dashed var(--accent-indicator)");
    expect(card["box-shadow"]).toBe("var(--shadow-5)");
    const css = readFileSync("src/app/file-drop.css", "utf8");
    for (const alias of ["--bg-overlay", "--bg-raised", "--shadow-glass", "--text-sm"])
      expect(css, alias).not.toContain(`var(${alias}`);
  });
});
