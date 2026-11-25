// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NavigationPage } from "./FloatingNav";
import type { LauncherContextValue } from "./controller/types";
import { defaults, type Config } from "../lib/launcher";
import { createLauncherI18n } from "../i18n";
import { useShortcuts } from "./useShortcuts";
import { AppShell } from "./App";

const allPages: NavigationPage[] = ["home", "library", "discover", "multiplayer", "downloads", "accounts", "settings"];

const shellState = vi.hoisted(() => ({ launcher: null as unknown as LauncherContextValue }));
vi.mock("./controller/LauncherProvider", () => ({ useLauncher: () => shellState.launcher }));
vi.mock("./AppearanceProvider", () => ({
  useAppearance: () => ({ effects: "lite", reducedMotion: true, reducedTransparency: true, highContrast: false }),
}));
vi.mock("../design/useMotionTier", () => ({ useMotionTier: () => ({ tier: "none", sceneStatic: true }) }));
vi.mock("../components/WorldScene", () => ({ WorldScene: () => null }));
vi.mock("../features/downloads/useDownloadTasks", () => ({ useDownloadTasks: () => ({ activeCount: 0 }) }));
vi.mock("./FloatingNav", () => ({ FloatingNav: () => null }));
vi.mock("../features/home/HomePage", () => ({ HomePage: () => null }));
vi.mock("../features/library/LibraryPage", () => ({ LibraryPage: () => null }));
vi.mock("../features/discover/DiscoverPage", () => ({ DiscoverPage: () => null }));
vi.mock("../features/downloads/DownloadsPage", () => ({ DownloadsPage: () => null }));
vi.mock("../features/accounts/AccountsPage", () => ({ AccountsPage: () => null }));
vi.mock("../features/multiplayer/MultiplayerPage", () => ({ MultiplayerPage: () => null }));
vi.mock("../features/settings/SettingsPage", () => ({ SettingsPage: () => null }));

let root: Root;
let container: HTMLDivElement;
const originalScrollTo = HTMLElement.prototype.scrollTo;

function Harness({
  onNavigate,
  onOpenAssistant,
  implemented = new Set(allPages),
  search = true,
}: {
  onNavigate: (page: NavigationPage) => void;
  onOpenAssistant?: () => void;
  implemented?: ReadonlySet<NavigationPage>;
  search?: boolean;
}) {
  const { helpOpen, setHelpOpen } = useShortcuts({ navigate: onNavigate, implemented, onOpenAssistant });
  return (
    <div>
      {helpOpen ? (
        <div data-shortcut-help>
          <button type="button" onClick={() => setHelpOpen(false)}>Close help</button>
        </div>
      ) : null}
      <main id="main-content" tabIndex={-1}>
        {search ? (
          <>
            <input type="search" aria-label="Hidden search" style={{ display: "none" }} />
            <input type="search" aria-label="Page search" />
          </>
        ) : null}
      </main>
      <input aria-label="Text field" />
    </div>
  );
}

async function render(element: ReactNode = <Harness onNavigate={() => {}} />) {
  await act(async () => root.render(element));
}

async function press(init: KeyboardEventInit): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    window.dispatchEvent(event);
  });
  return event;
}

function help(): Element | null {
  return container.querySelector("[data-shortcut-help]");
}

function installShellLauncher() {
  const config: Config = { ...defaults, tourCompleted: true };
  const launcher = {
    bootstrapped: true,
    bootstrapFailed: false,
    data: { config, accounts: [], instances: [], installedVersions: [], capabilities: {} },
    config,
    manifest: null,
    activeAccount: undefined,
    accountAppearance: { skinUrl: undefined },
    selectedInstance: undefined,
    selectedVersion: undefined,
    selectedVersionId: "",
    selectedRunningGame: undefined,
    running: [],
    preparing: false,
    progress: null,
    resourceProgress: null,
    logs: [],
    busy: "",
    notice: null,
    gamePid: undefined,
    reload: vi.fn(async () => {}),
    saveConfig: vi.fn(async (next: Config) => next),
    setConfig: vi.fn(),
    selectInstance: vi.fn(),
    selectVersion: vi.fn(),
    launch: vi.fn(async () => {}),
    launchMultiplayer: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    cancelPreparation: vi.fn(async () => {}),
    run: vi.fn(async (_label: string, action: () => Promise<unknown>) => action()),
    dismissNotice: vi.fn(),
  };
  shellState.launcher = launcher as unknown as LauncherContextValue;
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.querySelectorAll("dialog").forEach((dialog) => dialog.remove());
  if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: originalScrollTo });
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  vi.restoreAllMocks();
});

describe("useShortcuts", () => {
  it("navigates to implemented pages in registry order with Ctrl+number and opens Settings with Ctrl+,", async () => {
    const navigate = vi.fn();
    await render(<Harness onNavigate={navigate} />);

    for (const [index, page] of allPages.entries()) {
      const event = await press({ key: String(index + 1), ctrlKey: true });
      expect(navigate).toHaveBeenLastCalledWith(page);
      expect(event.defaultPrevented).toBe(true);
    }
    expect(navigate).toHaveBeenCalledTimes(7);

    navigate.mockClear();
    const settings = await press({ key: ",", ctrlKey: true });
    expect(navigate).toHaveBeenCalledWith("settings");
    expect(settings.defaultPrevented).toBe(true);
  });

  it("falls back to physical key codes on AZERTY, Cyrillic and numpad layouts", async () => {
    const navigate = vi.fn();
    await render(<Harness onNavigate={navigate} />);

    await press({ key: "&", code: "Digit1", ctrlKey: true });
    expect(navigate).toHaveBeenLastCalledWith("home");
    await press({ key: "End", code: "Numpad2", ctrlKey: true });
    expect(navigate).toHaveBeenLastCalledWith("library");
    navigate.mockClear();

    const settings = await press({ key: "б", code: "Comma", ctrlKey: true });
    expect(navigate).toHaveBeenCalledWith("settings");
    expect(settings.defaultPrevented).toBe(true);
    navigate.mockClear();

    const pageSearch = container.querySelector<HTMLInputElement>('input[aria-label="Page search"]')!;
    const find = await press({ key: "а", code: "KeyF", ctrlKey: true });
    expect(find.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(pageSearch);
  });

  it("follows the compacted order of implemented pages and ignores a number beyond them", async () => {
    const navigate = vi.fn();
    await render(<Harness onNavigate={navigate} implemented={new Set<NavigationPage>(["home", "library"])} />);

    await press({ key: "2", ctrlKey: true });
    expect(navigate).toHaveBeenLastCalledWith("library");
    navigate.mockClear();

    const event = await press({ key: "3", ctrlKey: true });
    expect(navigate).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("ignores modified, composing, repeated and already prevented events", async () => {
    const navigate = vi.fn();
    await render(<Harness onNavigate={navigate} />);

    await press({ key: "1", ctrlKey: true, altKey: true });
    await press({ key: "1", ctrlKey: true, metaKey: true });
    await press({ key: "1", ctrlKey: true, isComposing: true });
    await press({ key: "1", ctrlKey: true, repeat: true });
    const prevented = new KeyboardEvent("keydown", { key: "1", ctrlKey: true, bubbles: true, cancelable: true });
    prevented.preventDefault();
    await act(async () => window.dispatchEvent(prevented));

    expect(navigate).not.toHaveBeenCalled();
  });

  it("ignores shortcuts while a modal dialog is open", async () => {
    const navigate = vi.fn();
    await render(<Harness onNavigate={navigate} />);
    const dialog = document.createElement("dialog");
    dialog.open = true;
    document.body.append(dialog);

    await press({ key: "1", ctrlKey: true });
    await press({ key: "?", shiftKey: true });
    expect(navigate).not.toHaveBeenCalled();
    expect(help()).toBeNull();
  });

  it("ignores page shortcuts and help in text fields, but still focuses the page search with Ctrl+F", async () => {
    const navigate = vi.fn();
    await render(<Harness onNavigate={navigate} />);
    const field = container.querySelector<HTMLInputElement>('input[aria-label="Text field"]')!;
    field.focus();

    await press({ key: "2", ctrlKey: true });
    await press({ key: "?", shiftKey: true });
    await press({ key: "F1" });
    expect(navigate).not.toHaveBeenCalled();
    expect(help()).toBeNull();

    const pageSearch = container.querySelector<HTMLInputElement>('input[aria-label="Page search"]')!;
    const event = await press({ key: "f", ctrlKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(pageSearch);
  });

  it("focuses the first visible search input in main and prevents default only when one exists", async () => {
    await render(<Harness onNavigate={() => {}} search={false} />);
    const field = container.querySelector<HTMLInputElement>('input[aria-label="Text field"]')!;
    field.focus();

    const missing = await press({ key: "f", ctrlKey: true });
    expect(missing.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(field);

    await render(<Harness onNavigate={() => {}} />);
    const visibleSearch = container.querySelector<HTMLInputElement>('input[aria-label="Page search"]')!;
    const focused = await press({ key: "f", ctrlKey: true });
    expect(focused.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(visibleSearch);
  });

  it("keeps page and help shortcuts working after a checkbox or another non-text control is focused", async () => {
    const navigate = vi.fn();
    await render(<Harness onNavigate={navigate} />);

    for (const type of ["checkbox", "radio", "color", "range"]) {
      const control = document.createElement("input");
      control.type = type;
      document.body.append(control);
      await act(async () => control.focus());
      const event = await press({ key: "2", ctrlKey: true });
      expect(event.defaultPrevented, type).toBe(true);
      expect(navigate, type).toHaveBeenLastCalledWith("library");
      control.remove();
    }

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    document.body.append(checkbox);
    await act(async () => checkbox.focus());
    await press({ key: "F1" });
    expect(help()).not.toBeNull();
    checkbox.remove();
  });

  it("opens the shortcut help with ? and F1", async () => {
    const navigate = vi.fn();
    await render(<Harness onNavigate={navigate} />);

    const question = await press({ key: "?", shiftKey: true });
    expect(question.defaultPrevented).toBe(true);
    expect(help()).not.toBeNull();
    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-shortcut-help] button")!.click();
    });
    expect(help()).toBeNull();

    const f1 = await press({ key: "F1" });
    expect(f1.defaultPrevented).toBe(true);
    expect(help()).not.toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("navigates the AppShell and opens its real help dialog from the keyboard", async () => {
    installShellLauncher();
    const i18n = createLauncherI18n("en-US", "en-US");
    await i18n.initPromise;
    await render(createElement(I18nextProvider, { i18n }, createElement(AppShell)));

    const main = container.querySelector<HTMLElement>("main")!;
    expect(main.dataset.currentPage).toBe("home");

    const nextPage = await press({ key: "2", ctrlKey: true });
    expect(nextPage.defaultPrevented).toBe(true);
    expect(main.dataset.currentPage).toBe("library");

    const dialog = document.querySelector<HTMLDialogElement>("dialog.vx-shortcuts-dialog");
    expect(dialog?.open).toBe(false);
    const f1 = await press({ key: "F1" });
    expect(f1.defaultPrevented).toBe(true);
    const opened = document.querySelector<HTMLDialogElement>("dialog.vx-shortcuts-dialog");
    expect(opened?.open).toBe(true);
    expect(opened?.querySelector("h2")?.textContent).toBe("Keyboard shortcuts");
  });

  it("opens the built-in assistant with Ctrl+K (including physical KeyK) outside text fields", async () => {
    const onOpenAssistant = vi.fn();
    await render(<Harness onNavigate={() => {}} onOpenAssistant={onOpenAssistant} />);

    const event = await press({ key: "k", ctrlKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(onOpenAssistant).toHaveBeenCalledTimes(1);

    const cyrillic = await press({ key: "л", code: "KeyK", ctrlKey: true });
    expect(cyrillic.defaultPrevented).toBe(true);
    expect(onOpenAssistant).toHaveBeenCalledTimes(2);

    const field = container.querySelector<HTMLInputElement>('input[aria-label="Text field"]')!;
    field.focus();
    const inText = await press({ key: "k", ctrlKey: true });
    expect(inText.defaultPrevented).toBe(false);
    expect(onOpenAssistant).toHaveBeenCalledTimes(2);
  });
});
