// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLauncherI18n } from "../../i18n";
import { command, defaults, type Instance } from "../../lib/launcher";
import type { LauncherContextValue } from "../../app/controller/types";
import { LibraryPage } from "./LibraryPage";
import { isolatedStylesheetCss } from "../../test/isolatedStylesheetCss";

vi.mock("../../lib/launcher", async (original) => ({ ...await original<typeof import("../../lib/launcher")>(), command: vi.fn(), desktop: true }));
vi.mock("@tauri-apps/api/core", async (original) => ({ ...await original<typeof import("@tauri-apps/api/core")>(), convertFileSrc: (path: string) => `asset://fixture/${path}` }));
vi.mock("../../app/controller/LauncherProvider", () => ({ useLauncher: () => launcher }));
vi.mock("../../app/AppearanceProvider", () => ({ useAppearance: () => ({ effects: fullMotion ? "full" : "lite", reducedMotion: !fullMotion, reducedTransparency: false, highContrast: false }) }));
vi.mock("../../visual/glass/GlassSystem", () => ({ GlassSurface: ({ children, className }: { children: React.ReactNode; className?: string }) => <div className={className}>{children}</div> }));
vi.mock("../../visual/overture/OvertureProvider", () => ({ useOverture: () => ({ play: vi.fn() }) }));

const css = ["src/features/library/library-grid.css", "src/features/library/instance-detail.css"]
  .map(path => isolatedStylesheetCss(readFileSync(path, "utf8"), ["features", "overrides"])).join("\n");
const commandMock = vi.mocked(command);
let launcher: LauncherContextValue;
let root: Root;
let main: HTMLElement;
let container: HTMLDivElement;
let style: HTMLStyleElement;
let fullMotion = false;

function makeInstance(id: string, name: string): Instance {
  return { id, name, versionId: "1.21.1", gameDirectory: `C:\\Fixtures\\${id}`, createdAt: "2026-11-03T08:00:00Z",
    category: "", iconPath: null, notes: "", maxMemoryMb: null, javaPath: null, jvmArguments: null,
    screenWidth: null, screenHeight: null, totalPlayTime: 0, loader: "vanilla", loaderVersion: "" };
}
const first = makeInstance("first-world", "第一个世界");
const second = makeInstance("second-world", "第二个世界");
const created = makeInstance("created-world", "新建世界");

function fixture(): LauncherContextValue {
  const data = { config: { ...defaults }, accounts: [], instances: [{ ...first }, { ...second }],
    installedVersions: [{ id: "1.21.1", type: "release", installed: true, launchable: true, javaMajor: 21 }], capabilities: {} };
  return {
    bootstrapped: true, data, config: data.config, manifest: { latestRelease: "1.21.1", latestSnapshot: "", versions: [] },
    activeAccount: undefined,
    accountAppearance: { profile: null, setProfile: vi.fn(), skinUrl: undefined, model: "auto", capeUrl: undefined,
      hasAccountSkin: false, loading: false, error: "", refresh: vi.fn() },
    selectedInstance: data.instances[0], selectedVersion: data.installedVersions[0], selectedVersionId: "1.21.1",
    selectedRunningGame: undefined, running: [], progress: null, logs: [], busy: "", notice: null, gamePid: undefined,
    reload: vi.fn(async () => {}), saveConfig: vi.fn(async () => true), setConfig: vi.fn(), selectInstance: vi.fn(), selectVersion: vi.fn(),
    launch: vi.fn(async () => {}), launchMultiplayer: vi.fn(async () => {}), stop: vi.fn(async () => {}), cancelPreparation: vi.fn(async () => {}),
    run: vi.fn(async (_key, action) => action()), dismissNotice: vi.fn(),
  };
}

async function render(navResetTick = 0) {
  const i18n = createLauncherI18n("zh-CN", "zh-CN");
  await i18n.initPromise;
  await act(async () => root.render(<I18nextProvider i18n={i18n}><LibraryPage navResetTick={navResetTick} /></I18nextProvider>));
}
function button(label: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent?.trim() === label || element.getAttribute("aria-label") === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
async function click(label: string) { await act(async () => button(label).click()); }
function card(id = first.id) { return container.querySelector<HTMLButtonElement>(`[data-instance-id="${id}"] .vx-instance-card__select`)!; }
function versionCard() { return container.querySelector<HTMLButtonElement>('[data-version-directory="1.21.1"] [data-version-id="1.21.1"]')!; }
async function openCard(id = first.id) {
  const trigger = card(id);
  await act(async () => { trigger.focus(); trigger.click(); });
}
async function back() { await act(async () => container.querySelector<HTMLButtonElement>(".vx-detail-header button")!.click()); }

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  launcher = fixture();
  fullMotion = false;
  commandMock.mockReset();
  commandMock.mockImplementation(async (name) => {
    if (["list_local_resources", "list_worlds", "list_screenshots", "list_instance_backups"].includes(name)) return [];
    if (name === "list_versions") return { latestRelease: "1.21.1", latestSnapshot: "", versions: [] };
    if (name === "install_version") return { versionId: "1.21.1", downloaded: 0, reused: 1 };
    if (name === "create_instance") return created;
    return null;
  });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function () { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function () { this.open = false; this.dispatchEvent(new Event("close")); } });
  main = document.createElement("main"); main.className = "vx-app-main"; main.id = "main-content";
  container = document.createElement("div"); main.append(container); document.body.append(main); root = createRoot(container);
  style = document.createElement("style"); style.textContent = css; document.head.append(style);
});
afterEach(() => {
  act(() => root.unmount()); main.remove(); style.remove(); vi.restoreAllMocks();
});

describe("library drill focus and scroll", () => {
  it.each(["grid", "list"])("opens a %s card with the old subtree gone and a visible focused detail title", async (view) => {
    await render();
    if (view === "list") await click("列表视图");
    main.scrollTop = 420;
    await openCard();
    const heading = container.querySelector<HTMLElement>(".vx-detail-header h1")!;
    expect(container.querySelector(".vx-instance-sheet")).toBeNull();
    expect(main.scrollTop).toBe(0);
    expect(heading.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(heading);
  });

  it.each(["grid", "list"])("restores the exact %s listing scroll and original card on normal Back", async (view) => {
    await render();
    if (view === "list") await click("列表视图");
    main.scrollTop = 420;
    await openCard(second.id);
    main.scrollTop = 90;
    await back();
    expect(Boolean(container.querySelector(".vx-detail-page"))).toBe(false);
    expect(main.scrollTop).toBe(420);
    expect(document.activeElement).toBe(card(second.id));
  });

  it("focuses version-directory details and returns to the same directory card and scroll", async () => {
    await render(); await click("版本目录"); main.scrollTop = 360;
    await act(async () => versionCard().click());
    const heading = container.querySelector<HTMLElement>(".vx-detail-header h1")!;
    expect(main.scrollTop).toBe(0);
    expect(document.activeElement).toBe(heading);
    main.scrollTop = 80; await back();
    expect(main.scrollTop).toBe(360);
    expect(document.activeElement).toBe(versionCard());
  });

  it("same-nav reset leaves detail at the list top even when the origin card exists", async () => {
    await render(); main.scrollTop = 420; await openCard(); main.scrollTop = 60;
    await render(1);
    expect(Boolean(container.querySelector(".vx-detail-page"))).toBe(false);
    expect(main.scrollTop).toBe(0);
    expect(document.activeElement).toBe(card());
  });

  it("resolves a vanished instance detail to a visible fallback title even when selected IDs never change", async () => {
    await render(); main.scrollTop = 420; await openCard(); main.scrollTop = 180;
    launcher.data.instances = [{ ...second }];
    await render();
    const heading = container.querySelector<HTMLElement>(".vx-library-page h1")!;
    expect(Boolean(container.querySelector(".vx-detail-page"))).toBe(false);
    expect(heading.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(heading);
    expect(main.scrollTop).toBe(0);
  });

  it("does not resurrect an invalid detail after a later reload restores the entity", async () => {
    await render(); await openCard();
    launcher.data.instances = [{ ...second }]; await render();
    launcher.data.instances = [{ ...first }, { ...second }]; await render();
    expect(Boolean(container.querySelector(".vx-detail-page"))).toBe(false);
    expect(card()).not.toBeNull();
  });

  it("restores the list after version reload invalidation without resurrecting the stale directory ID", async () => {
    await render(); await click("版本目录"); main.scrollTop = 360;
    await act(async () => versionCard().click());
    const version = launcher.data.installedVersions[0];
    launcher.data.installedVersions = []; await render();
    expect(main.scrollTop).toBe(0);
    expect(document.activeElement).toBe(container.querySelector(".vx-library-page h1"));
    launcher.data.installedVersions = [version]; await render();
    expect(Boolean(container.querySelector(".vx-detail-page"))).toBe(false);
  });

  it("delete returns to a visible library title instead of restoring an invisible deleted card", async () => {
    vi.mocked(launcher.reload).mockImplementation(async () => { launcher.data.instances = [{ ...second }]; });
    await render(); main.scrollTop = 420; await openCard(); main.scrollTop = 110;
    await act(async () => container.querySelector<HTMLElement>(".vx-detail-manage summary")!.click());
    await click("移除实例");
    expect(commandMock).toHaveBeenCalledWith("remove_instance", { instanceId: first.id });
    expect(Boolean(container.querySelector(".vx-detail-page"))).toBe(false);
    expect(main.scrollTop).toBe(0);
    expect(document.activeElement).toBe(container.querySelector(".vx-library-page h1"));
  });

  it("focuses a newly installed instance selected directly by the create callback", async () => {
    vi.mocked(launcher.reload).mockImplementation(async () => {
      if (!launcher.data.instances.some((instance) => instance.id === created.id)) launcher.data.instances = [...launcher.data.instances, { ...created }];
    });
    await render(); main.scrollTop = 420; await click("创建实例");
    const input = container.querySelector<HTMLInputElement>('dialog[open] [id$="-create-instance-name"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, created.name);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("安装并准备游戏");
    const heading = container.querySelector<HTMLElement>(".vx-detail-header h1")!;
    expect(heading.textContent).toBe(created.name);
    expect(main.scrollTop).toBe(0);
    expect(document.activeElement).toBe(heading);
  });
});

describe("library drill identity continuity", () => {
  function identitySnapshot(element: Element) {
    return {
      identity: element.getAttribute("data-identity"),
      kind: element.getAttribute("data-identity-kind"),
      layoutId: element.getAttribute("data-layout-id"),
      letter: element.querySelector(".vx-instance-identity__letter")?.textContent ?? null,
      icon: element.querySelector("img")?.getAttribute("src") ?? null,
    };
  }

  it.each([false, true])("preserves the instance identity key, kind and artwork across drill and back (full motion=%s)", async (full) => {
    fullMotion = full;
    await render();
    const expected = { identity: "first-world", kind: "instance",
      layoutId: full ? "instance-identity-first-world" : null, letter: "第", icon: null };
    expect(identitySnapshot(card().querySelector(".vx-instance-identity")!)).toEqual(expected);
    await openCard();
    expect(identitySnapshot(container.querySelector(".vx-detail-header .vx-instance-identity")!)).toEqual(expected);
    await back();
    expect(identitySnapshot(card().querySelector(".vx-instance-identity")!)).toEqual(expected);
  });

  it("preserves the chosen icon and shared identity key when drilling an icon-backed instance", async () => {
    fullMotion = true;
    launcher.data.instances[0].iconPath = "first-world.png";
    await render();
    const expected = { identity: "first-world", kind: "instance", layoutId: "instance-identity-first-world",
      letter: null, icon: "asset://fixture/first-world.png" };
    expect(identitySnapshot(card().querySelector(".vx-instance-identity")!)).toEqual(expected);
    await openCard();
    expect(identitySnapshot(container.querySelector(".vx-detail-header .vx-instance-identity")!)).toEqual(expected);
    await back();
    expect(identitySnapshot(card().querySelector(".vx-instance-identity")!)).toEqual(expected);
  });

  it("keeps version-directory identity separate from instance identity in its detail header", async () => {
    fullMotion = true;
    await render(); await click("版本目录");
    const expected = { identity: "1.21.1", kind: "version-directory", layoutId: "version-directory-identity-1.21.1",
      letter: "M", icon: null };
    expect(identitySnapshot(versionCard().querySelector(".vx-instance-identity")!)).toEqual(expected);
    await act(async () => versionCard().click());
    expect(identitySnapshot(container.querySelector(".vx-detail-header .vx-instance-identity")!)).toEqual(expected);
  });

  it("keeps a failed icon fallback through card-detail-card subtree replacement", async () => {
    launcher.data.instances[0].iconPath = "damaged-icon.png";
    await render();
    const image = card().querySelector("img")!;
    expect(image).not.toBeNull();
    await act(async () => image.dispatchEvent(new Event("error")));
    expect(card().querySelector("img")).toBeNull();
    await openCard();
    expect(Boolean(container.querySelector(".vx-detail-header .vx-instance-identity img"))).toBe(false);
    await back();
    expect(card().querySelector("img")).toBeNull();
  });
});
