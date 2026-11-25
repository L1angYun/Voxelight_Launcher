// @vitest-environment jsdom
import { act, createElement, useEffect, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { defaults, type Config } from "../lib/launcher";
import type { LauncherContextValue } from "./controller/types";
import { createLauncherI18n, type LauncherI18n } from "../i18n";
import { FirstRunTour } from "./FirstRunTour";
import { ShortcutHelp } from "./ShortcutHelp";
import type { NavigationPage } from "./FloatingNav";

const allPages = new Set<NavigationPage>(["home", "library", "discover", "multiplayer", "downloads", "accounts", "settings"]);

const state = vi.hoisted(() => ({ launcher: null as unknown as LauncherContextValue }));
vi.mock("./controller/LauncherProvider", () => ({ useLauncher: () => state.launcher }));
vi.mock("./AppearanceProvider", () => ({
  useAppearance: () => ({ effects: "full", accentColor: "#b4f17a", resolvedTheme: "dark", reducedMotion: true, highContrast: false }),
}));
vi.mock("../visual/glass/GlassSystem", () => ({
  GlassSurface: ({ children, className }: { children: ReactNode; className?: string }) => createElement("div", { className }, children),
}));
vi.mock("../design/useMotionTier", () => ({ useMotionTier: () => ({ tier: "none", sceneStatic: true }) }));

type LauncherStub = Pick<
  LauncherContextValue,
  "bootstrapped" | "config" | "data" | "setConfig" | "saveConfig" | "setTourCompleted" | "reload"
>;

let i18n: LauncherI18n;
let root: Root;
let container: HTMLDivElement;
let main: HTMLElement;

function installLauncher({ bootstrapped = true, tourCompleted = false }: { bootstrapped?: boolean; tourCompleted?: boolean } = {}): LauncherStub {
  const config: Config = { ...defaults, tourCompleted };
  const stub: LauncherStub = {
    bootstrapped,
    config,
    data: { config, accounts: [], instances: [], installedVersions: [], capabilities: {} },
    setConfig: vi.fn((next: Config) => {
      stub.config = next;
    }),
    saveConfig: vi.fn(async (next: Config) => {
      stub.config = next;
      return next;
    }),
    setTourCompleted: vi.fn(),
    reload: vi.fn(async () => {}),
  };
  vi.mocked(stub.setTourCompleted).mockImplementation(async (completed: boolean) => {
    const next = { ...stub.config, tourCompleted: completed };
    stub.config = next;
    return next;
  });
  state.launcher = stub as unknown as LauncherContextValue;
  return stub;
}

async function render(element: ReactNode) {
  await act(async () => root.render(createElement(I18nextProvider, { i18n }, element)));
}

function tour(): HTMLElement | null {
  return container.querySelector<HTMLElement>(".vx-tour__card");
}

function tourButton(label: string): HTMLButtonElement {
  const card = tour();
  if (!card) throw new Error("The tour is not open");
  const button = [...card.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.trim() === label || candidate.getAttribute("aria-label") === label);
  if (!button) throw new Error(`Missing tour button: ${label}`);
  return button;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
}

async function pressKey(key: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  });
}

function ReopenHarness() {
  const [helpOpen, setHelpOpen] = useState(false);
  const [reopen, setReopen] = useState(false);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "F1") return;
      event.preventDefault();
      setHelpOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  return (
    <>
      <FirstRunTour reopen={reopen} onDismissed={() => setReopen(false)} />
      <main><button type="button">Launch</button></main>
      <ShortcutHelp
        open={helpOpen}
        onOpenChange={setHelpOpen}
        onShowTour={() => setReopen(true)}
        implemented={allPages}
      />
    </>
  );
}

let restoreDialogMethods: (() => void) | null = null;

function installChromiumDialog() {
  const proto = HTMLDialogElement.prototype;
  const showModal = Object.getOwnPropertyDescriptor(proto, "showModal");
  const close = Object.getOwnPropertyDescriptor(proto, "close");
  const opener = new WeakMap<HTMLDialogElement, HTMLElement | null>();
  Object.defineProperty(proto, "showModal", {
    configurable: true,
    writable: true,
    value(this: HTMLDialogElement) {
      opener.set(this, document.activeElement instanceof HTMLElement ? document.activeElement : null);
      this.setAttribute("open", "");
    },
  });
  Object.defineProperty(proto, "close", {
    configurable: true,
    writable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute("open");
      const previous = opener.get(this);
      if (previous?.isConnected) previous.focus();
      window.setTimeout(() => this.dispatchEvent(new Event("close")), 0);
    },
  });
  restoreDialogMethods = () => {
    if (showModal) Object.defineProperty(proto, "showModal", showModal);
    else Reflect.deleteProperty(proto, "showModal");
    if (close) Object.defineProperty(proto, "close", close);
    else Reflect.deleteProperty(proto, "close");
    restoreDialogMethods = null;
  };
}

async function openHelpFromKeyboard(launch: HTMLButtonElement) {
  await act(async () => launch.focus());
  expect(document.activeElement).toBe(launch);
  await pressKey("F1");
  const dialog = document.querySelector<HTMLDialogElement>("dialog.vx-shortcuts-dialog")!;
  expect(dialog).not.toBeNull();
  expect(dialog.open).toBe(true);
  return dialog;
}

function showTourAgain(dialog: HTMLDialogElement): HTMLButtonElement {
  const button = [...dialog.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === "Open welcome setup");
  if (!button) throw new Error("Missing Open welcome setup");
  return button;
}

beforeEach(async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  i18n = createLauncherI18n("en-US", "en-US");
  await i18n.initPromise;
  main = document.createElement("main");
  main.id = "main-content";
  main.tabIndex = -1;
  document.body.append(main);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  restoreDialogMethods?.();
  container.remove();
  main.remove();
  document.querySelectorAll("dialog").forEach((dialog) => dialog.remove());
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("FirstRunTour", () => {
  it("appears after the first successful bootstrap until completed, with zero mention of Lumen", async () => {
    const stub = installLauncher({ bootstrapped: false, tourCompleted: false });
    await render(createElement(FirstRunTour));
    expect(tour()).toBeNull();

    stub.bootstrapped = true;
    await render(createElement(FirstRunTour));
    expect(tour()).not.toBeNull();
    expect(tour()?.textContent).toContain("1 of 4");
    expect(tour()?.textContent).not.toContain("Lumen");

    stub.config = { ...stub.config, tourCompleted: true };
    await render(createElement(FirstRunTour));
    expect(tour()).toBeNull();
  });

  it("moves through all 4 OOBE steps without mentioning Lumen and finishes via tour-only command when unmodified", async () => {
    const stub = installLauncher();
    await render(createElement(FirstRunTour));

    expect(tour()?.textContent).toContain("1 of 4");
    expect(tour()?.textContent).not.toContain("Lumen");
    await click(tourButton("Next"));
    expect(tour()?.textContent).toContain("2 of 4");
    expect(tour()?.textContent).not.toContain("Lumen");
    await click(tourButton("Back"));
    expect(tour()?.textContent).toContain("1 of 4");

    await click(tourButton("Next"));
    await click(tourButton("Next"));
    expect(tour()?.textContent).toContain("3 of 4");
    expect(tour()?.textContent).not.toContain("Lumen");
    await click(tourButton("Next"));
    expect(tour()?.textContent).toContain("4 of 4");
    expect(tour()?.textContent).not.toContain("Lumen");
    await click(tourButton("Start using Voxelight"));

    expect(tour()).toBeNull();
    expect(stub.setTourCompleted).toHaveBeenCalledTimes(1);
    expect(stub.setTourCompleted).toHaveBeenCalledWith(true);
    expect(stub.saveConfig).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(main);
  });

  it("live-previews appearance changes, reverts them on Skip, and persists them on Finish", async () => {
    const stub = installLauncher();
    await render(createElement(FirstRunTour));

    await click(tourButton("Massif"));
    expect(stub.setConfig).toHaveBeenCalledWith(expect.objectContaining({ worldScene: "massif" }));
    await click(tourButton("Skip"));
    expect(stub.setConfig).toHaveBeenLastCalledWith(expect.objectContaining({ worldScene: "horizon" }));
    expect(stub.saveConfig).not.toHaveBeenCalled();

    // Reopen and persist an appearance change + download source change on Finish.
    await render(createElement(FirstRunTour, { reopen: true }));
    await click(tourButton("Solid"));
    await click(tourButton("Next"));
    await click(tourButton("Next"));
    await click(tourButton("BMCLAPI"));
    await click(tourButton("Next"));
    await click(tourButton("Start using Voxelight"));

    expect(stub.saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ worldMaterial: "solid" }),
      { appearancePatch: { worldMaterial: "solid" } },
    );
    expect(stub.saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ downloadSource: "bmclapi" }),
      { preserveAppearance: true },
    );
    expect(stub.setTourCompleted).toHaveBeenCalledWith(true);
  });

  it("skips with the Skip button and records completion without a whole-config save", async () => {
    const stub = installLauncher();
    await render(createElement(FirstRunTour));

    await click(tourButton("Skip"));
    expect(tour()).toBeNull();
    expect(stub.setTourCompleted).toHaveBeenCalledTimes(1);
    expect(stub.setTourCompleted).toHaveBeenCalledWith(true);
    expect(stub.saveConfig).not.toHaveBeenCalled();
  });

  it("skips with Escape and returns focus to the main content", async () => {
    const stub = installLauncher();
    await render(createElement(FirstRunTour));
    expect(tour()?.contains(document.activeElement)).toBe(true);

    await pressKey("Escape");
    expect(tour()).toBeNull();
    expect(stub.setTourCompleted).toHaveBeenCalledTimes(1);
    expect(stub.saveConfig).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(main);
  });

  it("traps Tab inside the card", async () => {
    installLauncher();
    await render(createElement(FirstRunTour));
    const card = tour()!;
    expect(document.activeElement).toBe(card);

    await pressKey("Tab");
    expect(document.activeElement).toBe(tourButton("Skip"));
    await pressKey("Tab", { shiftKey: true });
    expect(document.activeElement).toBe(tourButton("Next"));
  });

  it("does not pull focus away from page controls the user can still use", async () => {
    installLauncher();
    const pageControl = document.createElement("input");
    pageControl.setAttribute("aria-label", "Discover search");
    main.append(pageControl);
    await render(createElement(FirstRunTour));

    await act(async () => pageControl.focus());
    expect(document.activeElement).toBe(pageControl);

    await act(async () => pageControl.blur());
    expect(document.activeElement).not.toBe(tour());
  });

  it("moves focus from the disabled Back button to Next", async () => {
    installLauncher();
    await render(createElement(FirstRunTour));
    await click(tourButton("Next"));

    const back = tourButton("Back");
    await act(async () => {
      back.focus();
      back.click();
      await Promise.resolve();
    });

    expect(back.disabled).toBe(true);
    expect(tour()?.textContent).toContain("1 of 4");
    expect(document.activeElement).toBe(tourButton("Next"));
  });

  it("announces the newly selected step through a polite live region", async () => {
    installLauncher();
    await render(createElement(FirstRunTour));
    const card = tour()!;
    const live = card.querySelector<HTMLElement>('[role="status"][aria-live="polite"]');
    expect(live).not.toBeNull();
    expect(live?.textContent).toContain("1 of 4");
    expect(live?.textContent).toContain("Shape your Voxelight space");
    expect(card.getAttribute("aria-describedby")).toBe(card.querySelector(".vx-tour__body")?.id);

    await click(tourButton("Next"));
    expect(live?.textContent).toContain("2 of 4");
    expect(live?.textContent).toContain("Player identity");
  });

  it("closes after a failed tour save for this session", async () => {
    const stub = installLauncher();
    vi.mocked(stub.setTourCompleted).mockRejectedValueOnce(new Error("save failed"));
    await render(createElement(FirstRunTour));

    await click(tourButton("Skip"));
    expect(tour()).toBeNull();
    expect(document.activeElement).toBe(main);
    expect(stub.setTourCompleted).toHaveBeenCalledTimes(1);
    expect(stub.saveConfig).not.toHaveBeenCalled();
  });

  it("closes the help dialog and moves focus into the reopened setup", async () => {
    installChromiumDialog();
    installLauncher({ tourCompleted: true });
    await render(createElement(ReopenHarness));
    expect(tour()).toBeNull();

    const launch = container.querySelector<HTMLButtonElement>("main button")!;
    const dialog = await openHelpFromKeyboard(launch);
    await click(showTourAgain(dialog));

    expect(tour()).not.toBeNull();
    expect(tour()?.textContent).toContain("1 of 4");
    expect(dialog.hasAttribute("open")).toBe(false);
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(tour()?.contains(document.activeElement)).toBe(true);
  });

  it("keeps focus in the setup when reopened after skipping earlier in the session", async () => {
    installChromiumDialog();
    const stub = installLauncher();
    await render(createElement(ReopenHarness));
    expect(tour()).not.toBeNull();

    await click(tourButton("Skip"));
    expect(tour()).toBeNull();
    expect(stub.setTourCompleted).toHaveBeenCalledWith(true);

    const launch = container.querySelector<HTMLButtonElement>("main button")!;
    const dialog = await openHelpFromKeyboard(launch);
    await click(showTourAgain(dialog));

    expect(tour()).not.toBeNull();
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(tour()?.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(launch);
  });

  it("hides Lumen from ShortcutHelp when unconfigured and reveals Ctrl+K once configured", async () => {
    installLauncher({ tourCompleted: true });
    await render(createElement(ShortcutHelp, {
      open: true,
      onOpenChange: () => {},
      onShowTour: () => {},
      implemented: allPages,
      canShowTour: false,
    }));

    const dialog = document.querySelector<HTMLDialogElement>("dialog.vx-shortcuts-dialog")!;
    expect(dialog.querySelector("h2")?.textContent).toBe("Keyboard shortcuts");
    const list = dialog.querySelector<HTMLDListElement>("dl.vx-shortcut-help")!;
    expect(list).not.toBeNull();
    const rows = [...list.querySelectorAll<HTMLElement>(".vx-shortcut-help__row")];
    expect(rows).toHaveLength(11);
    expect(list.textContent).not.toContain("Lumen");
    expect(rows[0].textContent).toContain("Go to Play");
    expect(rows[6].textContent).toContain("Go to Settings");
    expect(rows[7].textContent).toContain(",");
    expect(rows[8].textContent).toContain("Focus the page search");

    const showAgain = [...dialog.querySelectorAll<HTMLButtonElement>("button")]
      .find((candidate) => candidate.textContent?.trim() === "Open welcome setup");
    expect(showAgain?.disabled).toBe(true);

    // When Lumen is configured, Ctrl+K appears.
    await render(createElement(ShortcutHelp, {
      open: true,
      onOpenChange: () => {},
      onShowTour: () => {},
      implemented: allPages,
      showAssistant: true,
    }));
    const configuredRows = [...document.querySelectorAll<HTMLElement>(".vx-shortcut-help__row")];
    expect(configuredRows).toHaveLength(12);
    expect(configuredRows[8].textContent).toContain("Open Lumen");
  });

  it("keeps Ctrl+number rows aligned with a compacted implemented-page list", async () => {
    installLauncher({ tourCompleted: true });
    await render(createElement(ShortcutHelp, {
      open: true,
      onOpenChange: () => {},
      onShowTour: () => {},
      implemented: new Set<NavigationPage>(["home", "settings"]),
    }));

    const rows = [...document.querySelectorAll<HTMLElement>(".vx-shortcut-help__row")];
    expect(rows[0].textContent).toContain("Go to Play");
    expect(rows[1].textContent).toContain("Go to Settings");
    expect(rows[2].textContent).toContain(",");
    expect(rows[3].textContent).toContain("Focus the page search");
  });

  it("names each orientation card exactly like the navigation item it points at", async () => {
    for (const locale of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "ru-RU", "es-ES"] as const) {
      const local = createLauncherI18n(locale, locale);
      await local.initPromise;
      for (const step of ["library", "discover", "downloads", "settings"] as const) {
        expect(local.t(`shell:tour.steps.${step}.title`), `${locale} ${step}`)
          .toBe(local.t(`navigation.${step}`));
      }
    }
  });
});
