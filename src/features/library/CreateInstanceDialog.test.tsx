// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { createLauncherI18n } from "../../i18n";
import { command, defaults, type Bootstrap, type Instance, type VersionManifest } from "../../lib/launcher";
import type { LauncherContextValue } from "../../app/controller/types";
import { CreateInstanceDialog } from "./CreateInstanceDialog";

vi.mock("../../lib/launcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/launcher")>()),
  command: vi.fn(),
  desktop: true,
}));
vi.mock("../../app/controller/LauncherProvider", () => ({ useLauncher: () => launcher }));
vi.mock("../../app/AppearanceProvider", () => ({
  useAppearance: () => ({ effects: "lite", reducedMotion: true, reducedTransparency: false, highContrast: false }),
}));
vi.mock("../../visual/glass/GlassSystem", () => ({
  GlassSurface: ({ children, className }: { children: React.ReactNode; className?: string }) => createElement("div", { className }, children),
}));

const commandMock = vi.mocked(command);
let launcher: LauncherContextValue;
let root: Root;
let container: HTMLDivElement;

const instance: Instance = {
  id: "created-instance", name: "1.21.1", versionId: "1.21.1", gameDirectory: "C:\\SyntheticFixture\\created",
  createdAt: "2026-10-25T08:00:00Z", category: "", notes: "", totalPlayTime: 0, loader: "vanilla", loaderVersion: "",
};
const at = (id: string, type: string, releaseTime: string) => ({ id, type, releaseTime, url: "" });
const manifest: VersionManifest = {
  latestRelease: "1.21.4",
  latestSnapshot: "",
  versions: [
    at("1.21.4", "release", "2024-12-03T10:00:00Z"),
    at("1.21.3", "release", "2024-10-23T10:00:00Z"),
    at("1.21.2", "release", "2024-10-22T10:00:00Z"),
    at("1.21.1", "release", "2024-08-08T10:00:00Z"),
    at("1.21", "release", "2024-06-13T10:00:00Z"),
    at("1.20.6", "release", "2024-04-29T10:00:00Z"),
    at("1.20.4", "release", "2023-12-07T10:00:00Z"),
    at("1.20.1", "release", "2023-06-12T10:00:00Z"),
    at("b1.7.3", "old_beta", "2011-07-08T00:00:00Z"),
    at("a1.2.6", "old_alpha", "2010-12-03T00:00:00Z"),
  ],
} as VersionManifest;

function fixture(): LauncherContextValue {
  const data: Bootstrap = {
    config: { ...defaults }, accounts: [], instances: [],
    installedVersions: [{ id: "1.21.1", type: "release", installed: true, launchable: true, reason: undefined, javaMajor: 21 }],
    capabilities: {},
  };
  return {
    bootstrapped: true, data, config: data.config, manifest, activeAccount: undefined,
    accountAppearance: { profile: null, setProfile: vi.fn(), skinUrl: undefined, model: "auto", capeUrl: undefined, hasAccountSkin: false, loading: false, error: "", refresh: vi.fn() },
    selectedInstance: undefined, selectedVersion: undefined, selectedVersionId: "", selectedRunningGame: undefined,
    running: [], preparing: false, progress: null, resourceProgress: null, logs: [], busy: "", notice: null, gamePid: undefined,
    reload: vi.fn(async () => {}), saveConfig: vi.fn(async (next) => next),
    setTourCompleted: vi.fn(async (completed) => ({ ...defaults, tourCompleted: completed })), setConfig: vi.fn(),
    selectInstance: vi.fn(), selectVersion: vi.fn(), launch: vi.fn(async () => {}), launchMultiplayer: vi.fn(async () => {}),
    stop: vi.fn(async () => {}), cancelPreparation: vi.fn(async () => {}), run: vi.fn(async (_key, action) => action()), dismissNotice: vi.fn(),
  } as LauncherContextValue;
}

let i18n: ReturnType<typeof createLauncherI18n> | undefined;
/** Renders the dialog again with the same translator, as the launcher's re-renders do. */
async function open(isOpen = true) {
  if (!i18n) {
    i18n = createLauncherI18n("en-US", "en-US");
    await i18n.initPromise;
  }
  await act(async () => root.render(createElement(I18nextProvider, { i18n: i18n! },
    createElement(CreateInstanceDialog, { open: isOpen, onOpenChange, onInstalled }))));
}
const onOpenChange = vi.fn();
const onInstalled = vi.fn();
/** Gives the list rows of 36px in a 72px box, laid out only while its dialog is open. */
function layOutList() {
  const element = list()!;
  const shown = () => Boolean(element.closest("dialog")?.open);
  Object.defineProperty(element, "clientHeight", { configurable: true, get: () => shown() ? 72 : 0 });
  Object.defineProperty(element, "scrollTop", { configurable: true, writable: true, value: 0 });
  rows().forEach((row, index) => {
    Object.defineProperty(row, "offsetTop", { configurable: true, get: () => shown() ? index * 36 : 0 });
    Object.defineProperty(row, "offsetHeight", { configurable: true, get: () => shown() ? 36 : 0 });
  });
  return element;
}
const nextFrame = () => act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });

const list = () => container.querySelector<HTMLElement>('[role="listbox"][id$="-create-game-version"]');
const rows = () => [...list()!.querySelectorAll<HTMLElement>('[role="option"]')];
const picked = () => rows().find(row => row.getAttribute("aria-selected") === "true");
const press = (key: string) => act(async () => { list()!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.startsWith(label))!;
const install = () => container.querySelector<HTMLButtonElement>(".vx-dialog__footer button")!;
async function search(text: string) {
  const input = container.querySelector<HTMLInputElement>('input[type="search"][id$="-create-version-search"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  i18n = undefined;
  document.documentElement.dataset.effects = "lite";
  launcher = fixture();
  commandMock.mockReset();
  commandMock.mockImplementation(async (name, args) => {
    if (name === "list_versions") return manifest;
    if (name === "suggest_instance_name") return args?.gameVersion as string;
    if (name === "create_game_instance") return { ...instance, versionId: args?.gameVersion as string };
    return null;
  });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function () { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function () { this.open = false; this.dispatchEvent(new Event("close")); } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("create instance version list", () => {
  it("shows the shown versions as one visible single-choice list instead of a dropdown", async () => {
    await open();
    expect(container.querySelector('[role="combobox"][id$="-create-game-version"]')).toBeNull();
    expect(list()).not.toBeNull();
    expect(list()!.tabIndex).toBe(0);
    expect(document.getElementById(list()!.getAttribute("aria-labelledby")!)?.textContent).toBe("Game version");
    expect(rows().map(row => row.dataset.value)).toEqual(["1.21.4", "1.21.3", "1.21.2", "1.21.1", "1.21", "1.20.6", "1.20.4", "1.20.1"]);
    // The newest release is picked, marked and named as the list's active row.
    expect(picked()?.dataset.value).toBe("1.21.4");
    expect(picked()?.querySelector("svg[data-selected-mark]")).not.toBeNull();
    expect(list()!.getAttribute("aria-activedescendant")).toBe(picked()!.id);
    expect(rows().filter(row => row.querySelector("[data-selected-mark]"))).toHaveLength(1);
    // Each row: the version, a machine-readable date, and only the badges the filter does not already say.
    const installed = rows().find(row => row.dataset.value === "1.21.1")!;
    expect(installed.querySelector("time")?.getAttribute("datetime")).toBe("2024-08-08T10:00:00Z");
    expect(installed.querySelector("time")?.textContent).toBe("Aug 8, 2024");
    expect([...installed.querySelectorAll(".vx-create-version-option__badge")].map(badge => [badge.textContent, badge.getAttribute("data-tone")]))
      .toEqual([["Installed", "success"]]);
    expect(rows()[0].querySelectorAll(".vx-create-version-option__badge")).toHaveLength(0);
    await act(async () => button("Beta & Alpha").click());
    expect(rows().map(row => [row.dataset.value, row.querySelector(".vx-create-version-option__badge")?.textContent]))
      .toEqual([["b1.7.3", "Beta"], ["a1.2.6", "Alpha"]]);
  });

  it("moves the pick with the arrow, Home, End and page keys, and installs the version it lands on", async () => {
    await open();
    await press("ArrowDown");
    expect(picked()?.dataset.value).toBe("1.21.3");
    await press("End");
    expect(picked()?.dataset.value).toBe("1.20.1");
    await press("ArrowDown");
    expect(picked()?.dataset.value).toBe("1.20.1");
    await press("Home");
    expect(picked()?.dataset.value).toBe("1.21.4");
    await press("ArrowUp");
    expect(picked()?.dataset.value).toBe("1.21.4");
    await press("PageDown");
    expect(picked()?.dataset.value).toBe("1.20.6");
    await press("PageUp");
    expect(picked()?.dataset.value).toBe("1.21.4");
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => { list()!.dispatchEvent(enter); });
    expect(commandMock.mock.calls.some(([name]) => name === "create_game_instance")).toBe(false);
    await act(async () => rows().find(row => row.dataset.value === "1.20.4")!.click());
    expect(picked()?.dataset.value).toBe("1.20.4");
    expect(list()!.getAttribute("aria-activedescendant")).toBe(picked()!.id);
    await act(async () => install().click());
    expect(commandMock).toHaveBeenCalledWith("create_game_instance", expect.objectContaining({ gameVersion: "1.20.4", loader: "vanilla" }));
  });

  it("keeps the picked row in view when the keyboard moves it past the list's edge", async () => {
    await open();
    const element = layOutList();
    await press("End");
    expect(element.scrollTop).toBe(7 * 36 + 36 - 72);
    await press("Home");
    expect(element.scrollTop).toBe(0);
  });

  it("leaves a list the user scrolled where it is when the launcher renders the dialog again", async () => {
    await open();
    const element = layOutList();
    await press("End");
    expect(element.scrollTop).toBe(216);
    // The wheel scrolls back up to browse; then a log line or a progress event
    // hands the dialog a new launcher context and it renders again.
    element.scrollTop = 0;
    launcher = { ...launcher };
    await open();
    await open();
    expect(picked()?.dataset.value).toBe("1.20.1");
    expect(element.scrollTop).toBe(0);
  });

  it("shows the pick again when the dialog reopens", async () => {
    await open();
    const element = layOutList();
    await press("End");
    expect(element.scrollTop).toBe(216);
    await open(false);
    // A hidden list loses its scroll position.
    element.scrollTop = 0;
    await open(true);
    await nextFrame();
    expect(picked()?.dataset.value).toBe("1.20.1");
    expect(element.scrollTop).toBe(216);
  });

  it("names the list with the field's visible label, which moves focus to the list", async () => {
    await open();
    const label = document.getElementById(list()!.getAttribute("aria-labelledby")!) as HTMLLabelElement;
    expect(label.tagName).toBe("LABEL");
    expect(label.textContent).toBe("Game version");
    // A label's for cannot point at a list, so the label has none.
    expect(label.hasAttribute("for")).toBe(false);
    expect(list()!.hasAttribute("aria-label")).toBe(false);
    await act(async () => label.click());
    expect(document.activeElement).toBe(list());
  });

  it("says inside the list's place when a search matches nothing, and offers nothing to install", async () => {
    await open();
    await search("zzz");
    expect(list()).toBeNull();
    const well = container.querySelector(".vx-create-version-well")!;
    expect(well.getAttribute("data-empty")).toBe("true");
    expect(well.querySelector('[role="status"]')?.textContent).toBe("No versions match the search.");
    expect(install().disabled).toBe(true);
    await search("1.20");
    expect(rows().map(row => row.dataset.value)).toEqual(["1.20.6", "1.20.4", "1.20.1"]);
    expect(picked()?.dataset.value).toBe("1.20.6");
    expect(install().disabled).toBe(false);
  });

  it("shows a failed version request with its retry where the list would be", async () => {
    launcher.manifest = null;
    let attempts = 0;
    commandMock.mockImplementation(async (name) => {
      if (name !== "list_versions") return null;
      if (++attempts === 1) throw new Error("fixture-native-diagnostic");
      return manifest;
    });
    await open();
    const well = container.querySelector(".vx-create-version-well")!;
    expect(well.querySelector('[role="alert"]')?.textContent).toBe("Could not load Minecraft versions.");
    await act(async () => button("Retry").click());
    expect(attempts).toBe(2);
    expect(picked()?.dataset.value).toBe("1.21.4");
  });
});
