// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLauncherI18n, type LauncherI18n } from "../i18n";
import type { NavigationPage } from "./FloatingNav";
import { ShortcutHelp } from "./ShortcutHelp";

const allPages = new Set<NavigationPage>(["home", "library", "discover", "multiplayer", "downloads", "accounts", "settings"]);
const locales = ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "ru-RU", "es-ES"] as const;

let root: Root;
let container: HTMLDivElement;
let i18n: LauncherI18n;

async function render(element: ReactNode) {
  await act(async () => root.render(createElement(I18nextProvider, { i18n }, element)));
}

async function renderHelp(props: { implemented?: ReadonlySet<NavigationPage>; showAssistant?: boolean; canShowTour?: boolean } = {}) {
  await render(createElement(ShortcutHelp, {
    open: true,
    onOpenChange: () => {},
    onShowTour: () => {},
    implemented: props.implemented ?? allPages,
    showAssistant: props.showAssistant,
    canShowTour: props.canShowTour,
  }));
  return document.querySelector<HTMLDialogElement>("dialog.vx-shortcuts-dialog")!;
}

function group(dialog: HTMLElement, id: "navigation" | "general") {
  return dialog.querySelector<HTMLElement>(`[data-shortcut-group="${id}"]`);
}

function rows(scope: ParentNode) {
  return [...scope.querySelectorAll<HTMLElement>(".vx-shortcut-help__row")];
}

/** The key combinations of a row, as "Ctrl+7" strings. */
function combos(row: HTMLElement) {
  return [...row.querySelectorAll(".vx-shortcut-help__combo")]
    .map((combo) => [...combo.querySelectorAll("kbd")].map((key) => key.textContent).join("+"));
}

beforeEach(async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  i18n = createLauncherI18n("en-US", "en-US");
  await i18n.initPromise;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.querySelectorAll("dialog").forEach((dialog) => dialog.remove());
});

describe("ShortcutHelp", () => {
  it("groups shortcuts under Navigation and General headings", async () => {
    const dialog = await renderHelp();
    expect(dialog.querySelector("h2")?.textContent).toBe("Keyboard shortcuts");
    const navigation = group(dialog, "navigation")!, general = group(dialog, "general")!;
    expect(navigation.querySelector("h3")?.textContent).toBe("Navigation");
    expect(general.querySelector("h3")?.textContent).toBe("General");
    expect(navigation.getAttribute("aria-labelledby")).toBe(navigation.querySelector("h3")?.id);
    expect(general.getAttribute("aria-labelledby")).toBe(general.querySelector("h3")?.id);
    expect(navigation.compareDocumentPosition(general) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(rows(navigation).map((row) => row.querySelector("dt")?.textContent)).toEqual([
      "Go to Play", "Go to Library", "Go to Discover", "Go to Multiplayer", "Go to Downloads", "Go to Players", "Go to Settings",
    ]);
    expect(rows(general).map((row) => row.querySelector("dt")?.textContent)).toEqual([
      "Focus the page search", "Show keyboard shortcuts",
    ]);
  });

  it("lists Settings once with Ctrl+7 or Ctrl+, and help once with ? or F1", async () => {
    const dialog = await renderHelp();
    const all = rows(dialog);
    expect(all).toHaveLength(9);
    const settings = all.filter((row) => row.textContent?.includes("Go to Settings"));
    expect(settings).toHaveLength(1);
    expect(combos(settings[0])).toEqual(["Ctrl+7", "Ctrl+,"]);
    // The action is the term and its keys the definition, in reading order.
    expect(settings[0].querySelector("dt")?.textContent).toBe("Go to Settings");
    expect(settings[0].querySelectorAll("dd .vx-shortcut-help__combo")).toHaveLength(2);
    expect(settings[0].querySelector(".vx-shortcut-help__or")?.textContent).toBe("or");
    const help = all.filter((row) => row.textContent?.includes("Show keyboard shortcuts"));
    expect(help).toHaveLength(1);
    expect(combos(help[0])).toEqual(["?", "F1"]);
    // Single-shortcut rows have no alternative word.
    expect(all[0].querySelector(".vx-shortcut-help__or")).toBeNull();
    expect(combos(all[0])).toEqual(["Ctrl+1"]);
  });

  it("hides Lumen until it is configured, then lists Ctrl+K under General", async () => {
    let dialog = await renderHelp({ canShowTour: false });
    expect(dialog.textContent).not.toContain("Lumen");
    const showAgain = [...dialog.querySelectorAll<HTMLButtonElement>("button")]
      .find((candidate) => candidate.textContent?.trim() === "Open welcome setup");
    expect(showAgain?.disabled).toBe(true);

    dialog = await renderHelp({ showAssistant: true });
    const general = rows(group(dialog, "general")!);
    expect(general).toHaveLength(3);
    expect(general[0].textContent).toContain("Open Lumen");
    expect(combos(general[0])).toEqual(["Ctrl+K"]);
    expect(rows(dialog)).toHaveLength(10);
  });

  it("keeps Ctrl+number rows aligned with a compacted implemented-page list", async () => {
    let dialog = await renderHelp({ implemented: new Set<NavigationPage>(["home", "settings"]) });
    let navigation = rows(group(dialog, "navigation")!);
    expect(navigation.map((row) => row.querySelector("dt")?.textContent)).toEqual(["Go to Play", "Go to Settings"]);
    expect(combos(navigation[0])).toEqual(["Ctrl+1"]);
    expect(combos(navigation[1])).toEqual(["Ctrl+2", "Ctrl+,"]);

    // Without a Settings page there is no Ctrl+, alternative anywhere.
    dialog = await renderHelp({ implemented: new Set<NavigationPage>(["home", "library"]) });
    navigation = rows(group(dialog, "navigation")!);
    expect(navigation.flatMap(combos)).toEqual(["Ctrl+1", "Ctrl+2"]);
    expect(dialog.querySelector(".vx-shortcut-help")?.textContent).not.toContain(",");
  });

  it("translates the group headings and the alternative word in all seven locales without separator dots", async () => {
    const english = createLauncherI18n("en-US", "en-US");
    await english.initPromise;
    for (const locale of locales) {
      const local = createLauncherI18n(locale, locale);
      await local.initPromise;
      for (const key of ["shell:shortcuts.or", "shell:shortcuts.groups.navigation", "shell:shortcuts.groups.general"]) {
        const text = local.t(key);
        expect(text.trim(), `${locale} ${key}`).not.toBe("");
        expect(text, `${locale} ${key}`).not.toBe(key);
        expect(text, `${locale} ${key}`).not.toContain("·");
        // Spanish shares the word "General" with English; every other value differs.
        if (locale !== "en-US" && !(locale === "es-ES" && key.endsWith("general")))
          expect(text, `${locale} ${key} must be translated`).not.toBe(english.t(key));
      }
      // A group heading must not read as the name of a page listed beneath it.
      const pageNames = [...allPages].map((page) => local.t(`navigation.${page}`));
      for (const key of ["shell:shortcuts.groups.navigation", "shell:shortcuts.groups.general"])
        expect(pageNames, `${locale} ${key} collides with a page name`).not.toContain(local.t(key));
    }
  });

  it("renders the grouped list in Russian", async () => {
    i18n = createLauncherI18n("ru-RU", "ru-RU");
    await i18n.initPromise;
    const dialog = await renderHelp();
    expect(group(dialog, "navigation")?.querySelector("h3")?.textContent).toBe("Навигация");
    expect(group(dialog, "general")?.querySelector("h3")?.textContent).toBe("Общие");
    const settings = rows(dialog).find((row) => row.textContent?.includes("Настройки"))!;
    expect(settings.querySelector(".vx-shortcut-help__or")?.textContent).toBe("или");
  });
});
