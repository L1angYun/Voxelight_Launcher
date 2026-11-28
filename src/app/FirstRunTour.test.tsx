// @vitest-environment jsdom
import { act, createElement, useEffect, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { parse, type Rule } from "postcss";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { defaults, type Config } from "../lib/launcher";
import type { LauncherContextValue } from "./controller/types";
import { createLauncherI18n, type LauncherI18n } from "../i18n";
import { publishWorldAvailability } from "../components/world/worldAvailability";
import { WORLD_INTRO_REPLAY_EVENT } from "../components/world/worldReplay";
import { FirstRunTour } from "./FirstRunTour";
import { ShortcutHelp } from "./ShortcutHelp";
import type { NavigationPage } from "./FloatingNav";

const allPages = new Set<NavigationPage>(["home", "library", "discover", "multiplayer", "downloads", "accounts", "settings"]);
const tourSheet = parse(readFileSync("src/app/tour.css", "utf8"));
function tourDeclarations(selector: string) {
  const found: Record<string, string> = {};
  tourSheet.walkRules((rule: Rule) => {
    if (rule.parent?.type === "atrule" && (rule.parent as { name?: string }).name === "media") return;
    if (!rule.selectors.some((item) => item.trim() === selector)) return;
    rule.walkDecls((declaration) => { found[declaration.prop] = declaration.value; });
  });
  return found;
}

const state = vi.hoisted(() => ({
  launcher: null as unknown as LauncherContextValue,
  appearance: { effects: "full" as "full" | "lite", accentColor: "#0078d4", resolvedTheme: "dark" as "dark" | "light", reducedMotion: true, highContrast: false },
  motionTier: { tier: "none" as "full" | "fade" | "none", sceneStatic: true },
}));
vi.mock("./controller/LauncherProvider", () => ({ useLauncher: () => state.launcher }));
vi.mock("./AppearanceProvider", () => ({
  useAppearance: () => state.appearance,
}));
vi.mock("../visual/glass/GlassSystem", () => ({
  GlassSurface: ({ children, className }: { children: ReactNode; className?: string }) => createElement("div", { className }, children),
}));
vi.mock("../design/useMotionTier", () => ({ useMotionTier: () => state.motionTier }));

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
  state.appearance = { effects: "full", accentColor: "#0078d4", resolvedTheme: "dark", reducedMotion: true, highContrast: false };
  state.motionTier = { tier: "none", sceneStatic: true };
  publishWorldAvailability("unknown");
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
  publishWorldAvailability("unknown");
  container.remove();
  main.remove();
  document.querySelectorAll("dialog").forEach((dialog) => dialog.remove());
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("FirstRunTour", () => {
  it("appears after the first successful bootstrap until completed", async () => {
    const stub = installLauncher({ bootstrapped: false, tourCompleted: false });
    await render(createElement(FirstRunTour));
    expect(tour()).toBeNull();

    stub.bootstrapped = true;
    await render(createElement(FirstRunTour));
    expect(tour()).not.toBeNull();
    expect(tour()?.textContent).toContain("1 of 5");
    expect(tour()?.getAttribute("data-tour-total")).toBe("5");

    stub.config = { ...stub.config, tourCompleted: true };
    await render(createElement(FirstRunTour));
    expect(tour()).toBeNull();
  });

  it("moves through all 5 OOBE steps, introduces Lumen and finishes via tour-only command when unmodified", async () => {
    const stub = installLauncher();
    await render(createElement(FirstRunTour));

    expect(tour()?.textContent).toContain("1 of 5");
    await click(tourButton("Next"));
    expect(tour()?.textContent).toContain("2 of 5");
    await click(tourButton("Back"));
    expect(tour()?.textContent).toContain("1 of 5");

    await click(tourButton("Next"));
    await click(tourButton("Next"));
    expect(tour()?.textContent).toContain("3 of 5");
    await click(tourButton("Next"));
    expect(tour()?.textContent).toContain("4 of 5");
    expect(tour()?.textContent).toContain("Lumen");
    expect(tour()?.textContent).toContain("You bring your own API key");
    expect(tour()?.textContent).toContain("read-only by default");
    expect(tour()?.textContent).toContain("always asks before making a change");
    await click(tourButton("Next"));
    expect(tour()?.textContent).toContain("5 of 5");
    await click(tourButton("Start using Voxelight"));

    expect(tour()).toBeNull();
    expect(stub.setTourCompleted).toHaveBeenCalledTimes(1);
    expect(stub.setTourCompleted).toHaveBeenCalledWith(true);
    expect(stub.saveConfig).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(main);
  });

  it("opens Settings > Lumen from Set up now after the first run ends", async () => {
    const stub = installLauncher();
    const onSetUpLumen = vi.fn();
    await render(createElement(FirstRunTour, { onSetUpLumen }));

    await click(tourButton("Next"));
    await click(tourButton("Next"));
    await click(tourButton("Next"));
    const card = tour()!;
    expect(card.textContent).toContain("4 of 5");
    expect(card.querySelector('[role="status"][aria-live="polite"]')?.textContent).toContain("Meet Lumen");
    const later = tourButton("Later"), setUp = tourButton("Set up now");
    expect(later.disabled).toBe(false);
    expect(setUp.disabled).toBe(false);

    await click(setUp);
    expect(onSetUpLumen).toHaveBeenCalledTimes(1);
    expect(tour()).toBeNull();
    expect(stub.setTourCompleted).toHaveBeenCalledWith(true);
    expect(stub.saveConfig).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(main);
  });

  it("moves to the final step with Later without opening Settings", async () => {
    const stub = installLauncher();
    const onSetUpLumen = vi.fn();
    await render(createElement(FirstRunTour, { onSetUpLumen }));

    await click(tourButton("Next"));
    await click(tourButton("Next"));
    await click(tourButton("Next"));
    await click(tourButton("Later"));

    expect(tour()?.textContent).toContain("5 of 5");
    expect(onSetUpLumen).not.toHaveBeenCalled();
    expect(stub.setTourCompleted).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(tourButton("Start using Voxelight"));
  });

  it("keeps Escape and focus containment working on the Lumen step", async () => {
    const stub = installLauncher();
    await render(createElement(FirstRunTour));
    await click(tourButton("Next"));
    await click(tourButton("Next"));
    await click(tourButton("Next"));
    expect(tour()?.textContent).toContain("4 of 5");
    expect(tour()?.contains(document.activeElement)).toBe(true);
    expect(tourButton("Set up now").tabIndex).toBe(0);
    expect(tourButton("Later").tabIndex).toBe(0);

    await pressKey("Escape");
    expect(tour()).toBeNull();
    expect(stub.setTourCompleted).toHaveBeenCalledWith(true);
    expect(document.activeElement).toBe(main);
  });

  it("live-previews appearance changes, reverts them on Skip, and persists them on Finish", async () => {
    const stub = installLauncher();
    await render(createElement(FirstRunTour));

    await click(tourButton("Massif"));
    expect(stub.setConfig).toHaveBeenCalledWith(expect.objectContaining({ worldScene: "massif" }));
    const callsAfterMassif = vi.mocked(stub.setConfig).mock.calls.length;
    // Re-clicking the active option must not churn preview state.
    await click(tourButton("Massif"));
    expect(stub.setConfig).toHaveBeenCalledTimes(callsAfterMassif);
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
    await click(tourButton("Later"));
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

  it("opens on the step title, keeps reading order from it and traps Tab inside the card", async () => {
    installLauncher();
    await render(createElement(FirstRunTour));
    const card = tour()!;
    const heading = card.querySelector<HTMLElement>("h2.vx-tour__heading")!;
    // The title takes focus so the card frame never shows a focus ring.
    expect(document.activeElement).toBe(heading);
    expect(heading.tabIndex).toBe(-1);

    // Tab from the title reaches the first control after it (the language
    // picker on the first step), not Skip above it.
    await pressKey("Tab");
    expect(document.activeElement).toBe(tourButton("Language"));
    expect(heading.compareDocumentPosition(document.activeElement!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Shift+Tab from the title reaches Skip, the control just before it.
    await act(async () => heading.focus());
    await pressKey("Tab", { shiftKey: true });
    expect(document.activeElement).toBe(tourButton("Skip"));

    // Only the ends wrap.
    await pressKey("Tab", { shiftKey: true });
    expect(document.activeElement).toBe(tourButton("Next"));
    await pressKey("Tab");
    expect(document.activeElement).toBe(tourButton("Skip"));

    // From the card frame, Tab enters the controls from the matching end.
    await act(async () => card.focus());
    await pressKey("Tab");
    expect(document.activeElement).toBe(tourButton("Skip"));
    await act(async () => card.focus());
    await pressKey("Tab", { shiftKey: true });
    expect(document.activeElement).toBe(tourButton("Next"));
  });

  it("anchors the card by its top edge with a stable minimum height below the window chrome", () => {
    const card = tourDeclarations(".vx-tour__card");
    expect(card["--tour-top"]).toBe("max(clamp(24px, 10vh, 96px), calc(var(--shell-height, 82px) + var(--space-3)))");
    expect(card["min-block-size"]).toBe("min(560px, var(--tour-room))");
    expect(card["max-height"]).toBe("var(--tour-room)");
    const centred = tourDeclarations('.vx-tour__card[data-position="centred"]');
    expect(centred.top).toBe("var(--tour-top)");
    expect(centred.transform).toBe("translateX(-50%)");
    // The actions row sits on the bottom edge of the fixed-height card.
    expect(tourDeclarations(".vx-tour__actions")["margin-top"]).toBe("auto");
    expect(tourDeclarations(".vx-tour__heading:focus").outline).toBe("none");
  });

  it("keeps static summaries neutral and draws pixel squares instead of dots", () => {
    for (const selector of [".vx-oobe__chip", ".vx-oobe__telemetry"]) {
      const chip = tourDeclarations(selector);
      expect(chip.background, selector).toBe("var(--fill-hover)");
      expect(chip.border, selector).toBe("1px solid var(--border-subtle)");
    }
    expect(tourDeclarations(".vx-oobe__dot")["border-radius"]).toBe("0");
    expect(tourDeclarations(".vx-oobe__lumen-points li::before")["border-radius"]).toBe("0");
    // Doto is not used below 20px.
    expect(tourDeclarations(".vx-oobe__wordmark").font).toBe("var(--type-caption-strong)");
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
    expect(tour()?.textContent).toContain("1 of 5");
    expect(document.activeElement).toBe(tourButton("Next"));
  });

  it("announces the newly selected step through a polite live region", async () => {
    installLauncher();
    await render(createElement(FirstRunTour));
    const card = tour()!;
    const live = card.querySelector<HTMLElement>('[role="status"][aria-live="polite"]');
    expect(live).not.toBeNull();
    expect(live?.textContent).toContain("1 of 5");
    expect(live?.textContent).toContain("Shape your Voxelight space");
    expect(card.getAttribute("aria-describedby")).toBe(card.querySelector(".vx-tour__body")?.id);

    await click(tourButton("Next"));
    expect(live?.textContent).toContain("2 of 5");
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
    expect(tour()?.textContent).toContain("1 of 5");
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

  it("describes Lumen naturally in all seven locales without separator dots", async () => {
    const english = createLauncherI18n("en-US", "en-US");
    await english.initPromise;
    const keys = ["title", "body", "ownKey", "readOnly", "asksFirst", "setUp", "later"] as const;
    for (const locale of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "ru-RU", "es-ES"] as const) {
      const local = createLauncherI18n(locale, locale);
      await local.initPromise;
      for (const key of keys) {
        const text = local.t(`shell:tour.oobe.lumen.${key}`);
        expect(text.trim(), `${locale} lumen.${key}`).not.toBe("");
        expect(text, `${locale} lumen.${key}`).not.toContain("·");
        if (locale !== "en-US") {
          expect(text, `${locale} lumen.${key} must be translated`).not.toBe(english.t(`shell:tour.oobe.lumen.${key}`));
        }
      }
    }
  });

  it("shows the replay entrance button only when the full lattice intro is available and dispatches replay on activation", async () => {
    installLauncher();
    const replayed = vi.fn();
    window.addEventListener(WORLD_INTRO_REPLAY_EVENT, replayed);
    try {
      // Hidden under reduced motion / static tier by default in this suite.
      await render(createElement(FirstRunTour));
      expect(tour()?.querySelector("[data-world-intro-replay]")).toBeNull();

      // Shown when Full + Lattice + animated + available.
      state.appearance = { effects: "full", accentColor: "#0078d4", resolvedTheme: "dark", reducedMotion: false, highContrast: false };
      state.motionTier = { tier: "full", sceneStatic: false };
      await act(async () => publishWorldAvailability("available"));
      await render(createElement(FirstRunTour));
      const button = tour()?.querySelector<HTMLButtonElement>("[data-world-intro-replay]");
      expect(button).not.toBeNull();
      expect(button?.type).toBe("button");
      expect(button?.getAttribute("aria-label")).toBe("Replay entrance animation");
      expect(button?.textContent?.trim()).toBe("Replay entrance animation");

      await click(button!);
      expect(replayed).toHaveBeenCalledTimes(1);

      // Hidden when switching material to Solid, restored on Lattice.
      await click(tourButton("Solid"));
      expect(tour()?.querySelector("[data-world-intro-replay]")).toBeNull();
      await click(tourButton("Lattice"));
      expect(tour()?.querySelector("[data-world-intro-replay]")).not.toBeNull();

      // Hidden when switching effects to Lite, restored on Full.
      await click(tourButton("Lite (essential motion)"));
      expect(tour()?.querySelector("[data-world-intro-replay]")).toBeNull();
      await click(tourButton("Full (all effects)"));
      expect(tour()?.querySelector("[data-world-intro-replay]")).not.toBeNull();

      // Hidden when hardware or fallback tier cannot play the lattice intro.
      for (const unavailable of ["solid-only", "css", "lite"] as const) {
        await act(async () => publishWorldAvailability(unavailable));
        expect(tour()?.querySelector("[data-world-intro-replay]"), unavailable).toBeNull();
      }
      await act(async () => publishWorldAvailability("available"));
      expect(tour()?.querySelector("[data-world-intro-replay]")).not.toBeNull();

      // Hidden in high contrast or on non-appearance steps.
      state.appearance = { ...state.appearance, highContrast: true };
      await render(createElement(FirstRunTour));
      expect(tour()?.querySelector("[data-world-intro-replay]")).toBeNull();
      state.appearance = { ...state.appearance, highContrast: false };
      await render(createElement(FirstRunTour));
      expect(tour()?.querySelector("[data-world-intro-replay]")).not.toBeNull();
      await click(tourButton("Next"));
      expect(tour()?.querySelector("[data-world-intro-replay]")).toBeNull();
    } finally {
      window.removeEventListener(WORLD_INTRO_REPLAY_EVENT, replayed);
    }
  });

  it("localizes the replay entrance label naturally without middle dots in all seven locales", async () => {
    for (const locale of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "ru-RU", "es-ES"] as const) {
      const local = createLauncherI18n(locale, locale);
      await local.initPromise;
      const label = local.t("settings:worldPreview.replayIntro");
      expect(label.trim().length, locale).toBeGreaterThan(0);
      expect(label, locale).not.toContain("·");
      if (locale === "zh-CN") expect(label).toBe("重播入场动画");
    }
  });
});
