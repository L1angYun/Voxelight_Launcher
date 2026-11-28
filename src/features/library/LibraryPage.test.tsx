// @vitest-environment jsdom
import { act, createElement, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { createLauncherI18n } from "../../i18n";
import { command, defaults, type Bootstrap, type Instance, type ResourceProject } from "../../lib/launcher";
import type { LocalModMetadata, LocalResource, ModpackVersion, ResourceUpdate } from "./types";
import type { LauncherContextValue } from "../../app/controller/types";
import { instanceTabRegistry } from "../../app/registry";
import { resetViewState } from "../../app/viewState";
import { LibraryPage } from "./LibraryPage";
import { InstanceDetailPage } from "./InstanceDetailPage";
import { InstanceLogs } from "./InstanceLogs";
import { InstanceOverview } from "./InstanceOverview";
import { InstanceContent } from "./InstanceContent";
import { CreateInstanceDialog } from "./CreateInstanceDialog";
import { ConfirmContext, type ConfirmFn } from "../../components/ui/ConfirmDialog";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const instanceDetailCss = readFileSync(join(process.cwd(), "src/features/library/instance-detail.css"), "utf8");

function giveBackupSelectBounds(button: HTMLElement) {
  vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
    x: 100, y: 100, width: 240, height: 40, top: 100, bottom: 140, left: 100, right: 340,
    toJSON: () => ({}),
  });
}

const commandMock = vi.mocked(command);
// Stands in for the awaited dialog; an unanswered confirmation declines.
const confirmMock = vi.fn<ConfirmFn>(async () => false);
let mockLauncher: LauncherContextValue;
let root: Root;
let container: HTMLDivElement;

vi.mock("../../lib/launcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/launcher")>()),
  command: vi.fn(),
  desktop: true,
}));
vi.mock("../../app/controller/LauncherProvider", () => ({
  useLauncher: () => mockLauncher,
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));
vi.mock("../../app/AppearanceProvider", () => ({
  useAppearance: () => ({ effects: "lite", reducedMotion: true, reducedTransparency: false, highContrast: false }),
}));
vi.mock("../../visual/glass/GlassSystem", () => ({
  GlassSurface: ({ children, className }: { children: React.ReactNode; className?: string }) => createElement("div", { className }, children),
}));
vi.mock("../../visual/overture/OvertureProvider", () => ({
  useOverture: () => ({ current: null, playing: false, reducedMotion: false, soundEnabled: false, play: vi.fn(), dismiss: vi.fn() }),
}));

const instance: Instance = {
  id: "fixture-world",
  name: "合成测试世界",
  versionId: "1.21.1",
  gameDirectory: "C:\\SyntheticFixture\\world",
  createdAt: "2026-10-25T08:00:00Z",
  lastPlayed: undefined,
  category: "",
  iconPath: null,
  notes: "",
  maxMemoryMb: null,
  javaPath: null,
  jvmArguments: null,
  screenWidth: null,
  screenHeight: null,
  totalPlayTime: 0,
  loader: "vanilla",
  loaderVersion: "",
};

function fixture(): LauncherContextValue {
  const data: Bootstrap = {
    config: { ...defaults },
    accounts: [],
    instances: [instance],
    installedVersions: [{ id: "1.21.1", type: "release", installed: true, launchable: true, reason: undefined, javaMajor: 21 }],
    capabilities: {},
  };
  return {
    bootstrapped: true,
    data,
    config: data.config,
    manifest: { latestRelease: "1.21.1", latestSnapshot: "", versions: [] },
    activeAccount: undefined,
    accountAppearance: { profile: null, setProfile: vi.fn(), skinUrl: undefined, model: "auto", capeUrl: undefined, hasAccountSkin: false, loading: false, error: "", refresh: vi.fn() },
    selectedInstance: instance,
    selectedVersion: data.installedVersions[0],
    selectedVersionId: "1.21.1",
    selectedRunningGame: undefined,
    running: [],
    preparing: false, progress: null, resourceProgress: null,
    logs: [],
    busy: "",
    notice: null,
    gamePid: undefined,
    reload: vi.fn(async () => {}),
    saveConfig: vi.fn(async (next) => next),
    setTourCompleted: vi.fn(async (completed) => ({ ...defaults, tourCompleted: completed })),
    setConfig: vi.fn(),
    selectInstance: vi.fn(),
    selectVersion: vi.fn(),
    launch: vi.fn(async () => {}),
    launchMultiplayer: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    cancelPreparation: vi.fn(async () => {}),
    run: vi.fn(async (_key, action) => action()),
    dismissNotice: vi.fn(),
  };
}

async function render(node: React.ReactNode, language = "zh-CN") {
  const i18n = createLauncherI18n(language, language);
  await i18n.initPromise;
  await act(async () => root.render(createElement(I18nextProvider, { i18n },
    createElement(ConfirmContext.Provider, { value: confirmMock }, node))));
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetViewState();
  document.documentElement.dataset.effects = "full";
  document.documentElement.dataset.reducedMotion = "false";
  mockLauncher = fixture();
  commandMock.mockReset();
  confirmMock.mockReset();
  confirmMock.mockResolvedValue(false);
  commandMock.mockImplementation(async (name, args) => {
    if (name === "list_instance_backups") return { backups: [], warnings: [], recovery: null };
    if (name === "list_local_resources" || name === "list_worlds" || name === "list_screenshots") return [];
    if (name === "list_loader_versions") return [{ id: "0.16.9", stable: true, recommended: true }];
    if (name === "install_loader") return { versionId: "fabric-loader-0.16.9-1.21.1", loader: "fabric", loaderVersion: "0.16.9" };
    if (name === "create_instance") return { ...instance, id: "created-instance", name: args?.name as string };
    if (name === "create_game_instance") return { ...instance, id: "created-instance", name: (args?.name as string) || "1.21.1" };
    if (name === "suggest_instance_name") return args?.loader === "vanilla" ? args?.gameVersion : `${args?.gameVersion}-Fabric`;
    if (name === "install_version") return { versionId: "1.21.1", downloaded: 0, reused: 1 };
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

describe("library and instance details", () => {
  it("batches a large library without hiding search results or losing focus after drilling into a later card", async () => {
    mockLauncher.data.instances = Array.from({ length: 500 }, (_, i) => ({
      ...instance,
      id: "bench-" + i,
      name: i === 499 ? "稀有目标" : "合成世界 " + i,
    }));
    mockLauncher.data.installedVersions = Array.from({ length: 60 }, (_, i) => ({
      ...mockLauncher.data.installedVersions[0],
      id: "loaded-version-" + i,
    }));
    await render(createElement(LibraryPage));
    const visible = () => Array.from(container.querySelectorAll<HTMLElement>("[data-instance-id]"));
    const added = () => [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("再显示"));
    expect(visible()).toHaveLength(48);
    expect(container.querySelector("[data-create-instance]")).toBeNull();
    expect(added()?.textContent).toContain("452");
    await act(async () => { added()?.click(); });
    expect(visible()).toHaveLength(96);
    const target = visible().at(-1)!;
    const id = target.dataset.instanceId;
    await act(async () => target.querySelector<HTMLButtonElement>(".vx-instance-card__select")!.click());
    await act(async () => container.querySelector<HTMLButtonElement>(".vx-detail-header button")!.click());
    expect(visible()).toHaveLength(96);
    expect(document.activeElement?.closest<HTMLElement>("[data-instance-id]")?.dataset.instanceId).toBe(id);

    const input = container.querySelector<HTMLInputElement>("input[aria-label='搜索实例']")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(input, "稀有");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(visible().map((node) => node.dataset.instanceId)).toEqual(["bench-499"]);
    expect(added()).toBeUndefined();
    await act(async () => {
      setValue.call(input, "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(visible()).toHaveLength(48);
  });

  it("restores search, sort and view after leaving and returning", async () => {
    const buttonWithText = (label: string) => {
      const found = [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((candidate) => candidate.textContent?.trim() === label);
      if (!found) throw new Error(`Missing button: ${label}`);
      return found;
    };
    await render(createElement(LibraryPage));

    const search = container.querySelector<HTMLInputElement>('input[aria-label="搜索实例"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "1.21");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const sort = container.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="排序"]')!;
    giveBackupSelectBounds(sort);
    await act(async () => sort.click());
    const name = [...document.querySelectorAll<HTMLElement>('[role="option"][data-value="name"]')]
      .find((option) => !option.closest('[aria-hidden="true"]'));
    await act(async () => name!.click());
    await act(async () => buttonWithText("列表视图").click());

    expect(container.querySelector<HTMLInputElement>('input[aria-label="搜索实例"]')?.value).toBe("1.21");
    expect(container.querySelector('[role="combobox"][aria-label="排序"]')?.textContent).toContain("名称");
    expect(buttonWithText("列表视图").getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".vx-library-scope")).toBeNull();

    await act(async () => root.render(null));
    await render(createElement(LibraryPage));

    expect(container.querySelector<HTMLInputElement>('input[aria-label="搜索实例"]')?.value).toBe("1.21");
    expect(container.querySelector('[role="combobox"][aria-label="排序"]')?.textContent).toContain("名称");
    expect(buttonWithText("列表视图").getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".vx-instance-sheet--list")).not.toBeNull();
  });

  it("does not give a background install the Library launch preparation controls", async () => {
    mockLauncher.busy = "instance.install";
    mockLauncher.progress = { taskId: "separate-install", operation: "install", stage: "assets", completed: 3, total: 10, bytesCompleted: 0, bytesTotal: 0, versionId: "1.21.1", message: "fixture" };
    await render(createElement(LibraryPage));
    expect(container.querySelector(".vx-launch-status")).toBeNull();
    expect(container.textContent).not.toContain("取消准备");
  });

  it("keeps the final directory segment separately visible with an accessible directory prefix", async () => {
    const directoryInstance = { ...mockLauncher.data.instances[0],
      gameDirectory: "C:\\Long parent directory\\Another long component\\Final-world", lastPlayed: undefined };
    mockLauncher.data.instances = [directoryInstance]; mockLauncher.selectedInstance = directoryInstance;
    await render(createElement(LibraryPage));
    const path = container.querySelector<HTMLElement>(".vx-instance-card__path")!;
    expect(path.querySelector(".vx-instance-card__path-tail")?.textContent).toBe("Final-world");
    expect(path.querySelector(".vx-instance-card__path-head")?.textContent).toBe("C:\\Long parent directory\\Another long component\\");
    expect(path.hasAttribute("aria-label")).toBe(false);
    expect(path.querySelector(".sr-only")?.textContent).toContain("目录");
    expect(path.title).toBe(mockLauncher.data.instances[0].gameDirectory);
  });
  it("announces current instance on its focusable select button", async () => {
    await render(createElement(LibraryPage));
    const card = container.querySelector<HTMLElement>(".vx-instance-card.is-selected")!;
    expect(card).not.toBeNull();
    expect(card.hasAttribute("aria-current")).toBe(false);
    const select = card.querySelector<HTMLButtonElement>(".vx-instance-card__select")!;
    expect(select.getAttribute("aria-current")).toBe("true");
    select.focus(); expect(document.activeElement).toBe(select);
  });
  it("uses local mod metadata and falls back to the filename for other jars", async () => {
    commandMock.mockImplementation(async (name) => name === "list_local_resources" ? [
      { name: "file-a.jar", fileName: "file-a.jar", path: "file-a.jar", enabled: true, size: 1,
        metadata: { loader: "fabric", modId: "fixture", name: "Visible Fixture Mod", version: "3.1.0",
          authors: ["Alice"], hasIcon: false, dependencies: [], additionalMods: 0 } },
      { name: "file-b.jar", fileName: "file-b.jar", path: "file-b.jar", enabled: true, size: 2 },
    ] : []);
    await render(createElement(InstanceContent, { versionId: "1.21.1", instanceId: instance.id }));
    const rows = [...container.querySelectorAll(".vx-resource-row")];
    expect(rows.map((row) => row.querySelector("strong")?.textContent)).toEqual(["file-b.jar", "Visible Fixture Mod"]);
    const meta = rows[1].querySelector("small")!;
    const metaItems = [...meta.querySelectorAll("span")].map((item) => item.textContent?.trim());
    expect(metaItems[0]).toBe("file-a.jar");
    expect(metaItems).toContain("3.1.0");
    expect(metaItems).toContain("Alice");
    expect(meta.textContent).not.toContain("·");
  });
  it("loads a visible mod icon once and falls back when the browser cannot decode it", async () => {
    let intersect: ((visible: boolean) => void) | undefined;
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal("IntersectionObserver", class {
      observe = observe;
      disconnect = disconnect;
      constructor(callback: IntersectionObserverCallback) {
        intersect = (visible) => callback([{ isIntersecting: visible } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      }
    });
    try {
      commandMock.mockImplementation(async (name) => name === "list_local_resources" ? [{
        name: "file-a.jar", fileName: "file-a.jar", path: "file-a.jar", enabled: true, size: 1,
        metadata: { loader: "fabric", modId: "fixture", name: "Visible Fixture Mod", version: "3.1.0",
          authors: ["Alice"], hasIcon: true, dependencies: [], additionalMods: 0 },
      }] : name === "read_local_mod_icon" ? "data:image/png;base64,broken" : []);
      await render(createElement(InstanceContent, { versionId: "1.21.1", instanceId: instance.id }));
      const row = container.querySelector(".vx-resource-row")!;
      expect(observe).toHaveBeenCalledWith(row);
      await act(async () => intersect!(false));
      expect(commandMock.mock.calls.filter(([name]) => name === "read_local_mod_icon")).toHaveLength(0);
      await act(async () => { intersect!(true); intersect!(true); });
      expect(commandMock.mock.calls.filter(([name]) => name === "read_local_mod_icon")).toEqual([
        ["read_local_mod_icon", { versionId: "1.21.1", instanceId: instance.id, fileName: "file-a.jar" }],
      ]);
      const image = row.querySelector("img")!;
      expect(image.getAttribute("src")).toBe("data:image/png;base64,broken");
      expect(image.getAttribute("alt")).toBe("");
      expect(row.querySelector('[data-testid="local-mod-icon-placeholder"]')).toBeNull();
      await act(async () => image.dispatchEvent(new Event("error")));
      expect(row.querySelector("img")).toBeNull();
      expect(row.querySelector('[data-testid="local-mod-icon-placeholder"]')).not.toBeNull();
      expect(row.textContent).toContain("Visible Fixture Mod");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows a muted package placeholder and asks for no icon when a local file has none", async () => {
    const intersect: Array<(visible: boolean) => void> = [];
    const observe = vi.fn();
    vi.stubGlobal("IntersectionObserver", class {
      observe = observe;
      disconnect = vi.fn();
      constructor(callback: IntersectionObserverCallback) {
        intersect.push((visible) => callback([{ isIntersecting: visible } as IntersectionObserverEntry], this as unknown as IntersectionObserver));
      }
    });
    try {
      commandMock.mockImplementation(async (name) => name === "list_local_resources" ? [{
        name: "file-a.jar", fileName: "file-a.jar", path: "file-a.jar", enabled: true, size: 1,
        metadata: { loader: "fabric", modId: "fixture", name: "Visible Fixture Mod", version: "3.1.0",
          authors: ["Alice"], hasIcon: false, dependencies: [], additionalMods: 0 },
      }] : name === "read_local_mod_icon" ? "data:image/png;base64,unexpected" : []);
      await render(createElement(InstanceContent, { versionId: "1.21.1", instanceId: instance.id }));
      const row = container.querySelector(".vx-resource-row")!;
      await act(async () => { for (const show of intersect) show(true); });
      expect(observe).not.toHaveBeenCalled();
      expect(commandMock.mock.calls.filter(([name]) => name === "read_local_mod_icon")).toHaveLength(0);
      expect(row.querySelector("img")).toBeNull();
      const placeholder = row.querySelector('[data-testid="local-mod-icon-placeholder"]')!;
      expect(placeholder.parentElement?.classList.contains("vx-resource-icon")).toBe(true);
      const glyph = placeholder.querySelector("svg")!;
      expect(glyph.getAttribute("width")).toBe("24");
      expect(glyph.getAttribute("stroke-width")).toBe("1.3");
      // The glyph draws in the muted text token inside the same 24 px box as an icon.
      const surfacesCss = readFileSync(join(process.cwd(), "src/design/surfaces.css"), "utf8");
      expect(surfacesCss).toMatch(/\.vx-resource-icon\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px;[^}]*color:\s*var\(--text-secondary\);/);
      expect(surfacesCss).toMatch(/\.vx-resource-icon img, \.vx-resource-icon svg\s*\{[^}]*display:\s*block;/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows a package placeholder when the icon request fails", async () => {
    let intersect: ((visible: boolean) => void) | undefined;
    vi.stubGlobal("IntersectionObserver", class {
      observe = vi.fn();
      disconnect = vi.fn();
      constructor(callback: IntersectionObserverCallback) {
        intersect = (visible) => callback([{ isIntersecting: visible } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      }
    });
    try {
      commandMock.mockImplementation(async (name) => {
        if (name === "list_local_resources") return [{
          name: "file-a.jar", fileName: "file-a.jar", path: "file-a.jar", enabled: true, size: 1,
          metadata: { loader: "fabric", modId: "fixture", name: "Visible Fixture Mod", version: "3.1.0",
            authors: ["Alice"], hasIcon: true, dependencies: [], additionalMods: 0 },
        }];
        if (name === "read_local_mod_icon") throw { code: "resource.unavailable" };
        return [];
      });
      await render(createElement(InstanceContent, { versionId: "1.21.1", instanceId: instance.id }));
      const row = container.querySelector(".vx-resource-row")!;
      await act(async () => intersect!(true));
      expect(row.querySelector("img")).toBeNull();
      expect(row.querySelector('[data-testid="local-mod-icon-placeholder"]')).not.toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not announce an empty resource folder before its first request starts", async () => {
    commandMock.mockImplementation(() => new Promise(() => {}));
    let emptyOnFirstCommit: boolean | undefined;
    function FirstCommit() {
      useLayoutEffect(() => { emptyOnFirstCommit = Boolean(container.querySelector(".vx-empty")); }, []);
      return createElement(InstanceContent, { versionId: "1.21.1", instanceId: instance.id });
    }
    await render(createElement(FirstCommit));
    expect(emptyOnFirstCommit).toBe(false);
  });

  it.each([
    ["files", "list_local_resources", "刷新", "此分类暂无资源"],
    ["updates", "check_resource_updates", "检查更新", "没有可用更新"],
    ["history", "list_resource_update_history", "更新历史", "暂无更新历史"],
  ])("keeps %s pending and failed requests distinct from a successful empty result", async (view, commandName, action, emptyTitle) => {
    let reject!: (error: Error) => void;
    let requests = 0;
    const normal = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => {
      if (name !== commandName) return normal(name, args);
      requests++;
      return requests === 1
        ? new Promise((_resolve, fail) => { reject = fail; })
        : commandName === "check_resource_updates" ? { updates: [], curseforgeSkipped: false } : [];
    });
    await render(createElement(InstanceContent, { versionId: "1.21.1", instanceId: instance.id }));
    // History has no toolbar button: its tab loads it, and choosing the tab again retries.
    const request = () => [...container.querySelectorAll<HTMLElement>('.vx-toolbar button, [role="tab"]')].find((button) => button.textContent === action)!.click();
    if (view !== "files") await act(async () => request());
    expect(container.querySelector(".vx-empty")).toBeNull();
    await act(async () => reject(new Error("Fixture request failed")));
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.querySelector(".vx-empty")).toBeNull();
    await act(async () => request());
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector(".vx-empty h2")?.textContent).toBe(emptyTitle);
  });

  it("sends each update row's source and CurseForge file id when applying it", async () => {
    const updates: ResourceUpdate[] = [
      { fileName: "curseforge.jar", name: "CF Fixture", currentVersion: "1.0", newVersion: "1.1",
        projectId: "curseforge-project", newVersionId: "curseforge-version", enabled: true, source: "curseforge", newFileId: 24680 },
      { fileName: "modrinth.jar", name: "MR Fixture", currentVersion: "2.0", newVersion: "2.1",
        projectId: "modrinth-project", newVersionId: "modrinth-version", enabled: true, source: "modrinth" },
    ];
    commandMock.mockImplementation(async (name) => {
      if (name === "check_resource_updates") return { updates, curseforgeSkipped: false };
      if (name === "list_local_resources") return [{
        name: "modrinth.jar", fileName: "modrinth.jar", path: "modrinth.jar", enabled: true, size: 1,
      }];
      return [];
    });
    await render(createElement(InstanceContent, { versionId: "1.21.1", instanceId: instance.id }));
    const find = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === label)!;
    await act(async () => find("检查更新").click());
    expect([...container.querySelectorAll(".vx-resource-row small")].map((node) => node.textContent)).toEqual([
      "CurseForge 1.0 → 1.1",
      "Modrinth 2.0 → 2.1",
    ]);
    const updateButtons = () => [...container.querySelectorAll<HTMLButtonElement>(".vx-resource-row button")];
    expect(updateButtons()).toHaveLength(2);
    await act(async () => updateButtons()[0].click());
    expect(commandMock).toHaveBeenCalledWith("update_resource", {
      versionId: "1.21.1", instanceId: instance.id, resourceType: "resourcepack",
      fileName: "curseforge.jar", newVersionId: "curseforge-version", source: "curseforge", newFileId: 24680,
    });
    expect(updateButtons()).toHaveLength(1);
    await act(async () => updateButtons()[0].click());
    expect(commandMock).toHaveBeenCalledWith("update_resource", {
      versionId: "1.21.1", instanceId: instance.id, resourceType: "resourcepack",
      fileName: "modrinth.jar", newVersionId: "modrinth-version", source: "modrinth", newFileId: null,
    });
  });

  it("drops every update row whose file the applied update removed", async () => {
    const updates: ResourceUpdate[] = [
      { fileName: "a.jar", name: "CF A", currentVersion: "1.0", newVersion: "1.1",
        projectId: "a-project", newVersionId: "a-version", enabled: true, source: "curseforge", newFileId: 11 },
      { fileName: "b.jar", name: "CF B", currentVersion: "2.0", newVersion: "2.1",
        projectId: "b-project", newVersionId: "b-version", enabled: true, source: "curseforge", newFileId: 22 },
    ];
    const fileLists: LocalResource[][] = [
      [],
      [{ name: "a-1.1.jar", fileName: "a-1.1.jar", path: "a-1.1.jar", enabled: true, size: 1 }],
    ];
    commandMock.mockImplementation(async (name) => {
      if (name === "check_resource_updates") return { updates, curseforgeSkipped: false };
      if (name === "list_local_resources") return fileLists.shift() ?? [];
      return [];
    });
    await render(createElement(InstanceContent, { versionId: "1.21.1", instanceId: instance.id }));
    const find = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === label)!;
    await act(async () => find("检查更新").click());
    const rows = () => [...container.querySelectorAll<HTMLElement>(".vx-resource-row")];
    expect(rows().map((row) => row.querySelector("strong")?.textContent)).toEqual(["CF A", "CF B"]);
    await act(async () => rows()[0].querySelector<HTMLButtonElement>("button")!.click());
    expect(rows()).toHaveLength(0);
    expect(commandMock.mock.calls.filter(([name]) => name === "list_local_resources")).toHaveLength(2);
  });

  it("keeps an update row whose file still exists after applying a different row", async () => {
    const updates: ResourceUpdate[] = [
      { fileName: "a.jar", name: "CF A", currentVersion: "1.0", newVersion: "1.1",
        projectId: "a-project", newVersionId: "a-version", enabled: true, source: "curseforge", newFileId: 11 },
      { fileName: "b.jar", name: "CF B", currentVersion: "2.0", newVersion: "2.1",
        projectId: "b-project", newVersionId: "b-version", enabled: true, source: "curseforge", newFileId: 22 },
    ];
    const fileLists: LocalResource[][] = [
      [],
      [
        { name: "a-1.1.jar", fileName: "a-1.1.jar", path: "a-1.1.jar", enabled: true, size: 1 },
        { name: "b.jar", fileName: "b.jar", path: "b.jar", enabled: true, size: 2 },
      ],
      [],
    ];
    commandMock.mockImplementation(async (name) => {
      if (name === "check_resource_updates") return { updates, curseforgeSkipped: false };
      if (name === "list_local_resources") return fileLists.shift() ?? [];
      return [];
    });
    await render(createElement(InstanceContent, { versionId: "1.21.1", instanceId: instance.id }));
    const find = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === label)!;
    const rows = () => [...container.querySelectorAll<HTMLElement>(".vx-resource-row")];
    await act(async () => find("检查更新").click());
    expect(rows()).toHaveLength(2);
    await act(async () => rows()[0].querySelector<HTMLButtonElement>("button")!.click());
    expect(rows()).toHaveLength(1);
    expect(rows()[0].querySelector("strong")?.textContent).toBe("CF B");
    await act(async () => rows()[0].querySelector<HTMLButtonElement>("button")!.click());
    expect(commandMock).toHaveBeenCalledWith("update_resource", {
      versionId: "1.21.1", instanceId: instance.id, resourceType: "resourcepack",
      fileName: "b.jar", newVersionId: "b-version", source: "curseforge", newFileId: 22,
    });
    expect(rows()).toHaveLength(0);
  });

  it("lists nothing from before an update when reading the folder again fails", async () => {
    const updates: ResourceUpdate[] = [
      { fileName: "a.jar", name: "CF A", currentVersion: "1.0", newVersion: "1.1",
        projectId: "a-project", newVersionId: "a-version", enabled: true, source: "curseforge", newFileId: 11 },
      { fileName: "b.jar", name: "CF B", currentVersion: "2.0", newVersion: "2.1",
        projectId: "b-project", newVersionId: "b-version", enabled: true, source: "curseforge", newFileId: 22 },
    ];
    let lists = 0;
    commandMock.mockImplementation(async (name) => {
      if (name === "check_resource_updates") return { updates, curseforgeSkipped: true };
      if (name === "list_local_resources") {
        lists++;
        if (lists > 1) throw new Error("Fixture folder unreadable");
        return [
          { name: "a.jar", fileName: "a.jar", path: "a.jar", enabled: true, size: 1 },
          { name: "b.jar", fileName: "b.jar", path: "b.jar", enabled: true, size: 2 },
        ];
      }
      return [];
    });
    await render(createElement(InstanceContent, { versionId: "1.21.1", instanceId: instance.id }));
    const find = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === label)!;
    const tab = (label: string) => [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find((node) => node.textContent === label)!;
    const rows = () => [...container.querySelectorAll<HTMLElement>(".vx-resource-row")];
    expect(rows()).toHaveLength(2);
    await act(async () => find("检查更新").click());
    expect(rows()).toHaveLength(2);
    await act(async () => rows()[0].querySelector<HTMLButtonElement>("button")!.click());
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(rows()).toHaveLength(0);
    expect(container.textContent).not.toContain("未设置 CurseForge API Key");
    await act(async () => tab("文件").click());
    expect(rows()).toHaveLength(0);
  });

  it.each([
    ["回滚", "rollback_resource_update", { status: "committed", canRecover: false }, { tone: "danger" }],
    ["恢复中断事务", "recover_resource_update", { status: "rollingBack", canRecover: true }, undefined],
  ])("clears the CurseForge notices when %s empties the update list", async (action, commandName, state, details) => {
    const entry = { updateId: "fixture-entry", name: "资源更新", createdAt: "2026-11-16", projects: [], ...state };
    const confirm = confirmMock.mockResolvedValueOnce(false).mockResolvedValue(true);
    commandMock.mockImplementation(async (name) => {
      if (name === "check_resource_updates") return { updates: [], curseforgeSkipped: false, curseforgeError: "fixture" };
      if (name === "list_resource_update_history") return [entry];
      if (name === commandName) return { updateId: entry.updateId, restoredFiles: 1, status: "rolledBack" };
      return [];
    });
    const find = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === label)!;
    const tab = (label: string) => [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find((node) => node.textContent === label)!;
    const failed = "未能检查 CurseForge 文件的更新，下面只有 Modrinth 的结果。";
    try {
      await render(createElement(InstanceContent, { versionId: "1.21.1", instanceId: instance.id }));
      await act(async () => find("检查更新").click());
      expect(container.textContent).toContain(failed);
      await act(async () => find("更新历史").click());
      // Cancelling the confirmation sends nothing.
      await act(async () => find(action).click());
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(confirm.mock.calls[0]?.[0]).toContain(entry.name);
      expect(confirm.mock.calls[0]?.[1]).toEqual(details);
      expect(commandMock.mock.calls.some(([name]) => name === commandName)).toBe(false);
      await act(async () => find(action).click());
      expect(confirm).toHaveBeenCalledTimes(2);
      expect(commandMock.mock.calls.some(([name]) => name === commandName)).toBe(true);
      await act(async () => tab("更新").click());
      expect(container.textContent).not.toContain(failed);
      expect(container.querySelector(".vx-empty h2")?.textContent).toBe("尚未检查更新");
    } finally {
      confirm.mockRestore();
    }
  });

  it("offers a manual download link instead of an update action for restricted CurseForge files", async () => {
    const projectUrl = "https://www.curseforge.com/minecraft/mc-mods/manual-fixture";
    const update: ResourceUpdate = {
      fileName: "manual.jar", name: "Manual Fixture", currentVersion: "1.0", newVersion: "1.1",
      projectId: "manual-project", newVersionId: "manual-version", enabled: true,
      source: "curseforge", newFileId: 13579, manualOnly: true, projectUrl,
    };
    commandMock.mockImplementation(async (name) => name === "check_resource_updates"
      ? { updates: [update], curseforgeSkipped: false }
      : []);
    await render(createElement(InstanceContent, { versionId: "1.21.1", instanceId: instance.id }));
    const find = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === label)!;
    await act(async () => find("检查更新").click());
    const row = container.querySelector<HTMLElement>(".vx-resource-row")!;
    expect(row.textContent).toContain("CurseForge");
    expect(row.textContent).toContain("作者只允许在 CurseForge 下载此文件。");
    expect(row.querySelector("button")).toBeNull();
    const link = row.querySelector<HTMLAnchorElement>("a")!;
    expect(link.textContent).toBe("手动下载");
    expect(link.getAttribute("href")).toBe(projectUrl);
    await act(async () => link.click());
    expect(commandMock.mock.calls.some(([name]) => name === "update_resource")).toBe(false);
  });

  it.each<[string, ResourceUpdate[]]>([
    ["a populated list", [{
      fileName: "curseforge.jar", name: "CF Fixture", currentVersion: "1.0", newVersion: "1.1",
      projectId: "curseforge-project", newVersionId: "curseforge-version", enabled: true, source: "curseforge", newFileId: 9876,
    }]],
    ["an empty list", []],
  ])("shows the CurseForge-skipped notice with %s", async (_label, updates) => {
    commandMock.mockImplementation(async (name) => name === "check_resource_updates"
      ? { updates, curseforgeSkipped: true }
      : []);
    await render(createElement(InstanceContent, { versionId: "1.21.1", instanceId: instance.id }));
    const find = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === label)!;
    await act(async () => find("检查更新").click());
    expect(container.textContent).toContain("未设置 CurseForge API Key，未检查 CurseForge 文件的更新。");
    expect(container.querySelectorAll(".vx-inline-notice")).toHaveLength(1);
  });

  it("shows the CurseForge failure notice while keeping the Modrinth rows", async () => {
    const updates: ResourceUpdate[] = [{
      fileName: "modrinth.jar", name: "MR Fixture", currentVersion: "2.0", newVersion: "2.1",
      projectId: "modrinth-project", newVersionId: "modrinth-version", enabled: true, source: "modrinth",
    }];
    commandMock.mockImplementation(async (name) => name === "check_resource_updates"
      ? { updates, curseforgeSkipped: false, curseforgeError: "CurseForge 服务暂时不可用" }
      : []);
    await render(createElement(InstanceContent, { versionId: "1.21.1", instanceId: instance.id }));
    const find = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === label)!;
    await act(async () => find("检查更新").click());
    expect(container.textContent).toContain("未能检查 CurseForge 文件的更新，下面只有 Modrinth 的结果。");
    expect(container.textContent).not.toContain("CurseForge 服务暂时不可用");
    expect(container.querySelectorAll(".vx-inline-notice")).toHaveLength(1);
    const rows = [...container.querySelectorAll(".vx-resource-row")];
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("MR Fixture");
    expect(rows[0].textContent).toContain("Modrinth 2.0 → 2.1");
  });

  it("clears both CurseForge notices after a failed check and a clean result", async () => {
    let checks = 0;
    let fail: (error: Error) => void = () => {};
    commandMock.mockImplementation(async (name) => {
      if (name !== "check_resource_updates") return [];
      checks++;
      if (checks === 1) return { updates: [], curseforgeSkipped: true, curseforgeError: "fixture-curseforge-diagnostic" };
      if (checks === 2) return new Promise((_resolve, reject) => { fail = reject; });
      return { updates: [], curseforgeSkipped: false };
    });
    await render(createElement(InstanceContent, { versionId: "1.21.1", instanceId: instance.id }));
    const find = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === label)!;
    const notices = () => [...container.querySelectorAll(".vx-inline-notice")].map((node) => node.textContent);
    await act(async () => find("检查更新").click());
    expect(notices()).toEqual([
      "未设置 CurseForge API Key，未检查 CurseForge 文件的更新。",
      "未能检查 CurseForge 文件的更新，下面只有 Modrinth 的结果。",
    ]);
    expect(container.textContent).not.toContain("fixture-curseforge-diagnostic");
    expect(container.querySelector(".vx-empty h2")?.textContent).toBe("没有可用更新");
    await act(async () => find("检查更新").click());
    expect(notices()).toEqual([]);
    await act(async () => fail(new Error("Fixture request failed")));
    expect(notices()).toEqual([]);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    await act(async () => find("检查更新").click());
    expect(notices()).toEqual([]);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector(".vx-empty h2")?.textContent).toBe("没有可用更新");
  });

  it("only recovers an interrupted resource transaction after confirmation", async () => {
    const args = { versionId: "1.21.1", instanceId: instance.id, resourceType: "resourcepack" };
    const pending = { updateId: "fixture-interrupted", name: "资源更新", createdAt: "2026-11-16", status: "rollingBack", canRecover: true, projects: [] };
    const confirm = confirmMock.mockResolvedValueOnce(false).mockResolvedValue(true);
    let completed = false;
    commandMock.mockImplementation(async (name) => {
      if (name === "list_resource_update_history") return [completed ? { ...pending, status: "rolledBack", canRecover: false } : pending];
      if (name === "recover_resource_update") {
        completed = true;
        return { updateId: pending.updateId, restoredFiles: 1, status: "rolledBack" };
      }
      return [];
    });
    const find = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === label);
    try {
      await render(createElement(InstanceContent, { versionId: args.versionId, instanceId: args.instanceId }));
      await act(async () => find("更新历史")!.click());
      expect(commandMock).toHaveBeenCalledWith("list_resource_update_history", args);
      expect(commandMock.mock.calls.some(([name]) => name === "recover_resource_update")).toBe(false);
      expect(find("回滚")).toBeUndefined();
      const restore = find("恢复中断事务");
      expect(restore).toBeDefined();
      await act(async () => restore!.click());
      expect(commandMock.mock.calls.some(([name]) => name === "recover_resource_update")).toBe(false);
      await act(async () => restore!.click());
      expect(commandMock).toHaveBeenCalledWith("recover_resource_update", { ...args, updateId: pending.updateId });
      expect(commandMock.mock.calls.filter(([name]) => name === "list_resource_update_history")).toHaveLength(2);
      expect(commandMock.mock.calls.filter(([name]) => name === "list_local_resources")).toHaveLength(2);
      expect(container.textContent).toContain("已恢复中断的资源事务");
      expect(container.textContent).toContain("已回滚");
      expect(find("恢复中断事务")).toBeUndefined();
    } finally {
      confirm.mockRestore();
    }
  });

  it("offers recovery instead of rollback for a legacy journal and keeps the action after an unsafe recovery is refused", async () => {
    const pending = { updateId: "fixture-legacy", name: "旧记录", createdAt: "2026-11-16", status: "committed", canRecover: true, projects: [] };
    const confirm = confirmMock.mockResolvedValue(true);
    commandMock.mockImplementation(async (name) => {
      if (name === "list_resource_update_history") return [pending];
      if (name === "recover_resource_update") throw { code: "resource.recoveryConflict", params: {} };
      return [];
    });
    const find = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === label);
    try {
      await render(createElement(InstanceContent, { versionId: "1.21.1", instanceId: instance.id }));
      await act(async () => find("更新历史")!.click());
      expect(find("回滚")).toBeUndefined();
      expect(find("恢复中断事务")).toBeDefined();
      await act(async () => find("恢复中断事务")!.click());
      expect(container.querySelector('[role="alert"]')?.textContent).toContain("请保留现有资源副本");
      expect(find("恢复中断事务")?.disabled).toBe(false);
      expect(commandMock.mock.calls.filter(([name]) => name === "list_local_resources")).toHaveLength(1);
    } finally {
      confirm.mockRestore();
    }
  });

  it("keeps valid backups visible, confirms restore, and exposes the recovery copy", async () => {
    const stable = { id: "fixture-backup", instanceId: instance.id, versionId: instance.versionId,
      createdAt: "2026-10-25T08:00:00Z", path: "C:/SyntheticFixture/backup.zip", size: 8000 };
    const retained = { ...stable, id: "fixture-before-restore", createdAt: "2026-11-16T11:00:00Z" };
    const previous = "C:\\SyntheticFixture\\before-restore";
    const confirm = confirmMock.mockResolvedValueOnce(false).mockResolvedValue(true);
    let restored = false;
    commandMock.mockImplementation(async (name) => {
      if (name === "list_instance_backups") return {
        backups: restored ? [retained, stable] : [stable], warnings: [{ fileName: "broken.zip", reason: "invalid" }],
      };
      if (name === "restore_instance_backup") {
        restored = true;
        return { instance, previousBackup: retained, previousDirectory: previous };
      }
      return [];
    });
    const clickText = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === label)!;
    try {
      await render(createElement(InstanceOverview, { instance, onChanged: vi.fn(async () => {}) }));
      expect(container.textContent).toContain("broken.zip");
      const backup = container.querySelector<HTMLButtonElement>('button[aria-label="选择要恢复的备份"]');
      expect(backup).not.toBeNull();
      giveBackupSelectBounds(backup!);
      await act(async () => backup!.click());
      const option = document.querySelector<HTMLElement>('[role="option"][data-value="fixture-backup"]');
      expect(option).not.toBeNull();
      await act(async () => option!.click());
      const restore = clickText("恢复备份");
      expect(restore).toBeDefined();
      expect(restore.disabled).toBe(false);
      await act(async () => restore.click());
      expect(confirm.mock.calls[0]?.[1]).toEqual({ tone: "danger" });
      expect(commandMock.mock.calls.some(([name]) => name === "restore_instance_backup")).toBe(false);
      await act(async () => restore.click());
      expect(commandMock).toHaveBeenCalledWith("restore_instance_backup", { instanceId: instance.id, backupId: stable.id });
      expect(container.textContent).toContain(previous);
      expect(container.textContent).toContain("恢复前备份");
      expect(commandMock.mock.calls.filter(([name]) => name === "list_instance_backups")).toHaveLength(2);
    } finally {
      confirm.mockRestore();
    }
  });

  it("shows the preserved directories from a failed restore instead of losing them in a generic toast", async () => {
    const confirm = confirmMock.mockResolvedValue(true);
    const old = "C:\\SyntheticFixture\\original-copy", restoredDirectory = "C:\\SyntheticFixture\\verified-new-copy";
    const stable = { id: "fixture-backup", instanceId: instance.id, versionId: instance.versionId,
      createdAt: "2026-10-25T08:00:00Z", path: "C:/SyntheticFixture/backup.zip", size: 8000 };
    commandMock.mockImplementation(async (name) => {
      if (name === "list_instance_backups") return { backups: [stable], warnings: [] };
      if (name === "restore_instance_backup") throw {
        code: "backup.restoreRecoveryRequired", params: { currentDirectory: instance.gameDirectory, previousDirectory: old, restoredDirectory }, detail: "sensitive synthetic diagnostics",
      };
      return [];
    });
    try {
      await render(createElement(InstanceOverview, { instance, onChanged: vi.fn(async () => {}) }));
      const backup = container.querySelector<HTMLButtonElement>('button[aria-label="选择要恢复的备份"]')!;
      giveBackupSelectBounds(backup);
      await act(async () => backup.click());
      await act(async () => document.querySelector<HTMLElement>('[role="option"][data-value="fixture-backup"]')!.click());
      const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === "恢复备份");
      await act(async () => button!.click());
      const text = container.querySelector('[role="alert"]')?.textContent;
      expect(text).toContain(old);
      expect(text).toContain(restoredDirectory);
      expect(text).not.toContain("sensitive synthetic diagnostics");
    } finally {
      confirm.mockRestore();
    }
  });


  it("recovers an interrupted instance restore explicitly without requiring a backup selection", async () => {
    const currentDirectory = instance.gameDirectory;
    const previousDirectory = "C:\\SyntheticFixture\\original-copy";
    const preservedDirectory = "C:\\SyntheticFixture\\verified-new-copy";
    const confirm = confirmMock.mockResolvedValueOnce(false).mockResolvedValue(true);
    let recovered = false;
    commandMock.mockImplementation(async (name) => {
      if (name === "list_instance_backups") return {
        backups: [], warnings: [], recovery: recovered ? null : { currentDirectory, previousDirectory },
      };
      if (name === "recover_instance_restore") {
        recovered = true;
        return { instance, preservedDirectory, previousBackup: null };
      }
      return [];
    });
    const find = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === label);
    try {
      await render(createElement(InstanceOverview, { instance, onChanged: vi.fn(async () => {}) }));
      expect(commandMock.mock.calls.some(([name]) => name === "recover_instance_restore")).toBe(false);
      expect(find("恢复备份")?.disabled).toBe(true);
      expect(container.textContent).toContain(previousDirectory);
      const recover = find("恢复中断的备份操作");
      expect(recover).toBeDefined();
      await act(async () => recover!.click());
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(commandMock.mock.calls.some(([name]) => name === "recover_instance_restore")).toBe(false);
      await act(async () => recover!.click());
      expect(commandMock).toHaveBeenCalledWith("recover_instance_restore", { instanceId: instance.id });
      expect(container.textContent).toContain(preservedDirectory);
      expect(find("恢复中断的备份操作")).toBeUndefined();
    } finally {
      confirm.mockRestore();
    }
  });

  it("shows the exact shared export inventory before opening the picker and excludes configs by default", async () => {
    const options = { includeConfigs: false, includeResourcePacks: false, includeShaderPacks: false, includeSaves: false, includeOwnedAssets: false };
    const outputPath = "C:\\SyntheticFixture\\sharing\\pack-preview.mrpack";
    commandMock.mockImplementation(async name => {
      if (name === "list_instance_backups") return { backups: [], warnings: [], recovery: null };
      if (name === "plan_modrinth_export") return {
        downloadReferences: ["mods/verified-fixture.jar"],
        bundledFiles: ["modrinth.index.json"],
        excludedFiles: [{ path: "config/not-for-sharing.toml", reason: "notSelected" }],
        fingerprint: "named-preview-fixture",
      };
      if (name === "choose_launcher_path") return [outputPath];
      if (name === "export_modrinth_modpack") return { path: outputPath, warnings: [] };
      return null;
    });
    await render(createElement(InstanceOverview, { instance, onChanged: vi.fn(async () => {}) }));
    const control = (scope: ParentNode, text: string) => [...scope.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === text)!;
    const preview = control(container, "导出 Modrinth 整合包");
    const configs = [...container.querySelectorAll<HTMLLabelElement>("label")].find(label => label.textContent?.includes("配置与脚本"))!;
    const configChoice = configs.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(configChoice.checked).toBe(false);
    await act(async () => { preview.focus(); preview.click(); });
    expect(commandMock).toHaveBeenCalledWith("plan_modrinth_export", { instanceId: instance.id, options });
    expect(commandMock.mock.calls.some(([name]) => name === "choose_launcher_path" || name === "export_modrinth_modpack")).toBe(false);
    const visible = container.querySelector<HTMLDialogElement>("dialog[open]")!;
    expect(visible.querySelector("h2")?.textContent).toBe("分享前检查文件");
    expect(visible.textContent).toContain("mods/verified-fixture.jar");
    expect(visible.textContent).toContain("modrinth.index.json");
    expect(visible.textContent).toContain("config/not-for-sharing.toml");
    expect(visible.textContent).toContain("未选择此类文件");
    expect(document.activeElement).toBe(control(visible, "取消"));
    await act(async () => visible.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container.querySelector("dialog[open]")).toBeNull();
    expect(document.activeElement).toBe(preview);
    expect(commandMock.mock.calls.some(([name]) => name === "choose_launcher_path" || name === "export_modrinth_modpack")).toBe(false);
    await act(async () => preview.click());
    const confirmed = container.querySelector<HTMLDialogElement>("dialog[open]")!;
    await act(async () => control(confirmed, "确认并选择保存位置").click());
    expect(commandMock).toHaveBeenCalledWith("choose_launcher_path", { purpose: "packWrite", suggestedName: instance.name + ".mrpack" });
    expect(commandMock).toHaveBeenCalledWith("export_modrinth_modpack", {
      instanceId: instance.id, outputPath, name: instance.name, options, confirmedFingerprint: "named-preview-fixture",
    });
    const planned = commandMock.mock.calls.findIndex(([name]) => name === "plan_modrinth_export");
    const chosen = commandMock.mock.calls.findIndex(([name]) => name === "choose_launcher_path");
    const exported = commandMock.mock.calls.findIndex(([name]) => name === "export_modrinth_modpack");
    expect(planned).toBeLessThan(chosen);
    expect(chosen).toBeLessThan(exported);
  });

  const pack = (id: string): ResourceProject => ({ project_id: id, slug: id, title: `Pack ${id}`, description: "", icon_url: null, downloads: 0, author: "Fixture", project_type: "modpack", versions: ["1.21.1"] });
  const packVersion = (id: string): ModpackVersion => ({ id, name: id, versionNumber: id, gameVersions: ["1.21.1"], loaders: ["fabric"], datePublished: "2026-01-01" });
  const packChoice = () => container.querySelector<HTMLButtonElement>('[role="combobox"][id$="-create-pack-version"]')!;
  const packInstall = () => container.querySelector<HTMLButtonElement>('.vx-dialog__footer button')!;

  it("retries a failed version manifest in its own field without showing native diagnostics", async () => {
    const manifest = mockLauncher.manifest!;
    mockLauncher.manifest = null;
    let attempts = 0;
    commandMock.mockImplementation(async (name) => {
      if (name !== "list_versions") return null;
      if (++attempts === 1) throw new Error("fixture-native-diagnostic");
      return manifest;
    });
    await render(createElement(CreateInstanceDialog, { open: true, onOpenChange: vi.fn(), onInstalled: vi.fn() }), "en-US");
    expect(container.textContent).toContain("Could not load Minecraft versions.");
    expect(container.textContent).not.toContain("fixture-native-diagnostic");
    const retry = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === "Retry")!;
    await act(async () => retry.click());
    expect(attempts).toBe(2);
    expect(container.querySelector('[role="listbox"][id$="-create-game-version"] [aria-selected="true"]')?.getAttribute("data-value")).toBe("1.21.1");
    expect(container.textContent).not.toContain("Could not load Minecraft versions.");
  });

  const versionAt = (id: string, type: string, releaseTime: string) => ({ id, type, releaseTime, url: `https://piston-meta.mojang.com/v1/packages/${id}.json` });
  const versionFixture = () => ({
    latestRelease: "1.21.11",
    latestSnapshot: "26w14a",
    versions: [
      versionAt("26w14a", "snapshot", "2026-04-01T12:13:30+00:00"),
      versionAt("1.21.11", "release", "2025-12-09T12:23:30+00:00"),
      versionAt("24w14potato", "snapshot", "2024-04-01T11:07:19+00:00"),
      versionAt("1.21.1", "release", "2024-08-08T12:24:45+00:00"),
      versionAt("24w14a", "snapshot", "2024-04-03T12:49:39+00:00"),
      // A later fix for an older line: the date order and the version order disagree.
      versionAt("1.19.4", "release", "2023-07-01T00:00:00+00:00"),
      versionAt("1.20.1", "release", "2023-06-12T13:25:51+00:00"),
      versionAt("b1.7.3", "old_beta", "2011-07-07T22:00:00+00:00"),
      versionAt("a1.0.4", "old_alpha", "2010-07-08T22:00:00+00:00"),
    ],
  });
  // The chosen version is the selected row of the always-visible version list.
  const versionBox = () => ({ textContent: container.querySelector<HTMLElement>('[role="listbox"][id$="-create-game-version"] [role="option"][aria-selected="true"]')?.dataset.value ?? "Select game version" });
  const versionCategory = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.startsWith(label))!;
  const installButton = () => container.querySelector<HTMLButtonElement>('.vx-dialog__footer button')!;
  const searchBox = () => container.querySelector<HTMLInputElement>('input[type="search"][id$="-create-version-search"]')!;
  // Each row: the version, then its date and badges as one comma-separated detail.
  const listedVersions = async () => [...container.querySelectorAll<HTMLElement>('[role="listbox"][id$="-create-game-version"] [role="option"]')]
    .map(row => [row.dataset.value, [row.querySelector("time")?.textContent ?? "",
      ...[...row.querySelectorAll(".vx-create-version-option__badge")].map(badge => badge.textContent)].filter(Boolean).join(", ")]);
  const pickVersion = async (id: string) => {
    await act(async () => container.querySelector<HTMLElement>(`[role="listbox"] [role="option"][data-value="${id}"]`)!.click());
  };
  const searchVersions = async (text: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(searchBox(), text);
      searchBox().dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const sortVersions = async (label: string) => {
    const sort = container.querySelector<HTMLButtonElement>('[role="combobox"][id$="-create-version-sort"]')!;
    giveBackupSelectBounds(sort);
    await act(async () => sort.click());
    await act(async () => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(row => row.textContent === label)!.click());
  };

  it("groups game versions into releases, snapshots, Beta & Alpha and April Fools, with sorting and dates", async () => {
    mockLauncher.manifest = versionFixture();
    // Installed means the client is there; a version directory without it is not.
    mockLauncher.data.installedVersions = [...mockLauncher.data.installedVersions, { id: "1.20.1", type: "release", installed: false, launchable: false, reason: "missing", javaMajor: 17 }];
    commandMock.mockImplementation(async (name) => name === "list_versions" ? mockLauncher.manifest : null);
    await render(createElement(CreateInstanceDialog, { open: true, onOpenChange: vi.fn(), onInstalled: vi.fn() }), "en-US");

    // Releases first, newest first, each with its date.
    expect(versionCategory("Releases").getAttribute("aria-pressed")).toBe("true");
    expect(await listedVersions()).toEqual([
      ["1.21.11", "Dec 9, 2025"], ["1.21.1", "Aug 8, 2024, Installed"], ["1.19.4", "Jul 1, 2023"], ["1.20.1", "Jun 12, 2023"],
    ]);
    // The closed control shows only the version, keeping the dialog compact.
    expect(versionBox().textContent).toBe("1.21.11");

    // Clicking the type that is already shown keeps the pick.
    await pickVersion("1.20.1");
    await act(async () => versionCategory("Releases").click());
    expect(versionBox().textContent).toBe("1.20.1");

    // The version sorts differ from the date sorts.
    await sortVersions("Version, high to low");
    expect((await listedVersions()).map(([id]) => id)).toEqual(["1.21.11", "1.21.1", "1.20.1", "1.19.4"]);
    await sortVersions("Oldest first");
    expect((await listedVersions()).map(([id]) => id)).toEqual(["1.20.1", "1.19.4", "1.21.1", "1.21.11"]);
    expect(versionBox().textContent).toBe("1.20.1");
    await sortVersions("Newest first");

    // April Fools versions are not mixed in with snapshots; a new type picks its first version.
    await act(async () => versionCategory("April Fools").click());
    expect(await listedVersions()).toEqual([["26w14a", "Apr 1, 2026"], ["24w14potato", "Apr 1, 2024"]]);
    expect(versionBox().textContent).toBe("26w14a");
    await act(async () => versionCategory("Snapshots").click());
    expect((await listedVersions()).map(([id]) => id)).toEqual(["24w14a"]);
    await act(async () => versionCategory("Beta & Alpha").click());
    expect(await listedVersions()).toEqual([["b1.7.3", "Jul 7, 2011, Beta"], ["a1.0.4", "Jul 8, 2010, Alpha"]]);
  });

  it("searches game versions, keeps the pick among those shown, and never submits on Enter", async () => {
    mockLauncher.manifest = versionFixture();
    commandMock.mockImplementation(async (name, args) => {
      if (name === "list_versions") return mockLauncher.manifest;
      if (name === "suggest_instance_name") return args?.gameVersion as string;
      if (name === "create_game_instance") return { ...instance, id: "created-instance" };
      return null;
    });
    await render(createElement(CreateInstanceDialog, { open: true, onOpenChange: vi.fn(), onInstalled: vi.fn() }), "en-US");

    // A search keeps a pick it still shows.
    await pickVersion("1.20.1");
    await searchVersions("1.2");
    expect((await listedVersions()).map(([id]) => id)).toEqual(["1.21.11", "1.21.1", "1.20.1"]);
    expect(versionBox().textContent).toBe("1.20.1");

    // Typing a whole id picks it, not a longer id listed first.
    await searchVersions("1.21.1");
    expect((await listedVersions()).map(([id]) => id)).toEqual(["1.21.11", "1.21.1"]);
    expect(versionBox().textContent).toBe("1.21.1");

    // Enter in the search box does not submit the form.
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => searchBox().dispatchEvent(enter));
    expect(enter.defaultPrevented).toBe(true);
    expect(commandMock.mock.calls.some(([name]) => name === "create_game_instance")).toBe(false);

    // No match: counts per type, a message, and nothing to install.
    await searchVersions("14");
    expect(versionCategory("Releases").textContent).toBe("Releases (0)");
    expect(versionCategory("Snapshots").textContent).toBe("Snapshots (1)");
    expect(versionCategory("April Fools").textContent).toBe("April Fools (2)");
    expect(container.textContent).toContain("No versions match the search.");
    expect(installButton().disabled).toBe(true);

    await searchVersions("1.19");
    expect(versionBox().textContent).toBe("1.19.4");
    expect(container.textContent).not.toContain("No versions match the search.");
    await act(async () => installButton().click());
    expect(commandMock).toHaveBeenCalledWith("create_game_instance", expect.objectContaining({
      gameVersion: "1.19.4", loader: "vanilla", loaderVersion: "",
    }));
  });

  it("never installs a version the type or search hides, after reopening or once the list arrives", async () => {
    const manifest = versionFixture();
    mockLauncher.manifest = null;
    let answer!: (value: typeof manifest) => void;
    commandMock.mockImplementation(async (name, args) => {
      if (name === "list_versions") return new Promise(resolve => { answer = resolve; });
      if (name === "suggest_instance_name") return args?.gameVersion as string;
      if (name === "create_game_instance") return { ...instance, id: "created-instance" };
      return null;
    });
    const props = { onOpenChange: vi.fn(), onInstalled: vi.fn() };
    await render(createElement(CreateInstanceDialog, { ...props, open: true }), "en-US");
    // The list is still loading when another type is chosen.
    await act(async () => versionCategory("Snapshots").click());
    await act(async () => answer(manifest));
    expect(versionCategory("Snapshots").getAttribute("aria-pressed")).toBe("true");
    expect(versionBox().textContent).toBe("24w14a");
    expect(installButton().disabled).toBe(false);

    // A search that hides everything, then a reopen: the search is cleared and
    // the pick is a shown version, never the hidden latest release.
    await searchVersions("zzz");
    expect(installButton().disabled).toBe(true);
    await render(createElement(CreateInstanceDialog, { ...props, open: false }), "en-US");
    await render(createElement(CreateInstanceDialog, { ...props, open: true }), "en-US");
    await act(async () => answer(manifest));
    expect(searchBox().value).toBe("");
    expect(versionCategory("Snapshots").getAttribute("aria-pressed")).toBe("true");
    expect(versionBox().textContent).toBe("24w14a");
    await act(async () => installButton().click());
    expect(commandMock).toHaveBeenCalledWith("create_game_instance", expect.objectContaining({
      gameVersion: "24w14a", loader: "vanilla", loaderVersion: "",
    }));
    expect(commandMock.mock.calls.some(([name, args]) => name === "create_game_instance" && (args as { gameVersion: string }).gameVersion === "1.21.11")).toBe(false);

    // The next list (another download source, say) no longer has the pick: it is no choice.
    await render(createElement(CreateInstanceDialog, { ...props, open: false }), "en-US");
    await render(createElement(CreateInstanceDialog, { ...props, open: true }), "en-US");
    await act(async () => answer({ ...manifest, versions: manifest.versions.filter(version => version.id !== "24w14a") }));
    expect((await listedVersions()).map(([id]) => id)).toEqual([]);
    expect(installButton().disabled).toBe(true);
    expect(versionBox().textContent).toBe("Select game version");
  });

  it("keeps loader errors local and retries without re-requesting Minecraft or an unrelated loader", async () => {
    const manifest = vi.fn(() => mockLauncher.manifest);
    let attempts = 0;
    commandMock.mockImplementation(async (name) => {
      if (name === "list_versions") return manifest();
      if (name === "list_loader_versions" && ++attempts === 1) throw new Error("fixture-loader-diagnostic");
      if (name === "list_loader_versions") return [{ id: "0.16.9", recommended: true, stable: true }];
      return null;
    });
    await render(createElement(CreateInstanceDialog, { open: true, onOpenChange: vi.fn(), onInstalled: vi.fn() }), "en-US");
    const loader = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Fabric")!;
    await act(async () => loader.click());
    const slot = container.querySelector(".vx-create-loader-slot")!;
    expect(slot.textContent).toContain("Could not load Fabric versions.");
    expect(container.textContent).not.toContain("fixture-loader-diagnostic");
    const retry = [...slot.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === "Retry")!;
    await act(async () => retry.click());
    expect(container.querySelector('[role="combobox"][id$="-create-loader-version"]')?.textContent).toContain("0.16.9");
    expect(manifest).toHaveBeenCalledTimes(1);
  });

  it("offers OptiFine only as a local JAR import with the official download page, never as an online install", async () => {
    mockLauncher.manifest = versionFixture();
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    commandMock.mockImplementation(async (name) => {
      if (name === "list_versions") return mockLauncher.manifest;
      if (name === "list_loader_versions") return [{ id: "HD_U_J3", stable: true, recommended: true }];
      if (name === "choose_launcher_path") return ["C:\\SyntheticFixture\\OptiFine_1.21.11_HD_U_J3.jar"];
      if (name === "install_optifine_installer") return { versionId: "1.21.11-OptiFine_HD_U_J3", loader: "optifine", loaderVersion: "HD_U_J3" };
      if (name === "create_instance_from_version") return { ...instance, id: "created-instance", versionId: "1.21.11-OptiFine_HD_U_J3" };
      return null;
    });
    const onInstalled = vi.fn();
    await render(createElement(CreateInstanceDialog, { open: true, onOpenChange: vi.fn(), onInstalled }), "en-US");
    const optifine = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "OptiFine")!;
    await act(async () => optifine.click());
    const slot = container.querySelector(".vx-create-loader-slot")!;
    expect(commandMock.mock.calls.some(([name]) => name === "list_loader_versions")).toBe(false);
    expect(slot.querySelector('[id$="-create-loader-version"]')).toBeNull();
    expect(installButton().disabled).toBe(true);
    expect(slot.textContent).toContain("Voxelight does not download OptiFine");
    const site = [...slot.querySelectorAll<HTMLAnchorElement>("a")].find(link => link.textContent === "OptiFine downloads (optifine.net)")!;
    await act(async () => site.click());
    expect(openUrl).toHaveBeenCalledWith("https://optifine.net/downloads");

    const importJar = [...slot.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Import OptiFine installer JAR…")!;
    await act(async () => importJar.click());
    expect(commandMock).toHaveBeenCalledWith("install_optifine_installer", {
      path: "C:\\SyntheticFixture\\OptiFine_1.21.11_HD_U_J3.jar",
      expectedGameVersion: "1.21.11",
    });
    expect(commandMock.mock.calls.some(([name]) => name === "install_loader")).toBe(false);
    expect(onInstalled).toHaveBeenCalledWith("1.21.11-OptiFine_HD_U_J3", "created-instance");
  });

  it("distinguishes an empty Modrinth release list from a failed request and retries just the pack", async () => {
    const mystery = pack("mystery");
    let attempts = 0;
    commandMock.mockImplementation(async (name) => {
      if (name === "list_modpack_versions") {
        if (++attempts === 1) throw new Error("fixture-pack-diagnostic");
        return [];
      }
      return mockLauncher.manifest;
    });
    await render(createElement(CreateInstanceDialog, { open: true, onOpenChange: vi.fn(), onInstalled: vi.fn(), project: mystery }), "en-US");
    expect(container.textContent).toContain("Could not load this modpack’s versions.");
    expect(container.textContent).not.toContain("fixture-pack-diagnostic");
    const retry = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === "Retry")!;
    await act(async () => retry.click());
    expect(container.textContent).toContain("No versions are available for this modpack.");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(packInstall().disabled).toBe(true);
    expect(commandMock.mock.calls.some(([name]) => name === "list_versions")).toBe(false);
  });

  it("localizes the diagnostic title and guidance but preserves the source log", async () => {
    const excerpt = "[JVM] java.lang.OutOfMemoryError: sample log text";
    commandMock.mockImplementation(async (name) => name === "diagnose_instance" ? {
      kind: "memory", title: "内存不足", reason: "JVM 无法分配需要的内存", suggestions: ["调整实例最大内存并关闭占用较高的程序"],
      excerpt, logPath: null,
    } : null);
    await render(createElement(InstanceLogs, { versionId: instance.versionId, instanceId: instance.id }), "en-US");
    const analyze = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === "Analyze recent errors")!;
    await act(async () => analyze.click());
    expect(container.querySelector('h2')?.textContent).toBe("Out of memory");
    expect(container.textContent).toContain("Use 64-bit Java");
    expect(container.textContent).toContain(excerpt);
    expect(container.textContent).not.toContain("内存不足");
  });

  it("disables old pack choices while a different project loads and installs only its matching version", async () => {
    const a = pack("a"), b = pack("b");
    let finishB!: (value: ModpackVersion[]) => void;
    commandMock.mockImplementation(async (name, args) => {
      if (name === "list_modpack_versions") return args?.projectId === "a" ? [packVersion("a-version")] : new Promise((resolve) => { finishB = resolve; });
      if (name === "install_modrinth_modpack") return { instance, warnings: [] };
      return mockLauncher.manifest;
    });
    const props = { onOpenChange: vi.fn(), onInstalled: vi.fn() };
    await render(createElement(CreateInstanceDialog, { ...props, open: true, project: a }));
    expect(packChoice().textContent).toContain("a-version");
    await render(createElement(CreateInstanceDialog, { ...props, open: false, project: a }));
    expect(packChoice().textContent).toContain("a-version");
    await render(createElement(CreateInstanceDialog, { ...props, open: true, project: b }));
    expect(packChoice().textContent).not.toContain("a-version");
    expect(packInstall().disabled).toBe(true);
    await act(async () => finishB([packVersion("b-version")]));
    expect(packChoice().textContent).toContain("b-version");
    expect(packInstall().disabled).toBe(false);
    await act(async () => packInstall().click());
    expect(commandMock).toHaveBeenCalledWith("install_modrinth_modpack", expect.objectContaining({ projectId: "b", modpackVersionId: "b-version" }));
  });

  it("ignores project A finishing after project B in a reused creation dialog", async () => {
    const a = pack("a"), b = pack("b");
    const requests = new Map<string, (value: ModpackVersion[]) => void>();
    commandMock.mockImplementation(async (name, args) => name === "list_modpack_versions"
      ? new Promise((resolve) => { requests.set(String(args?.projectId), resolve); }) : mockLauncher.manifest);
    const props = { onOpenChange: vi.fn(), onInstalled: vi.fn() };
    await render(createElement(CreateInstanceDialog, { ...props, open: true, project: a }));
    await render(createElement(CreateInstanceDialog, { ...props, open: false, project: a }));
    await render(createElement(CreateInstanceDialog, { ...props, open: true, project: b }));
    await act(async () => requests.get("b")!([packVersion("b-version")]));
    await act(async () => requests.get("a")!([packVersion("late-a-version")]));
    expect(packChoice().textContent).toContain("b-version");
    expect(packChoice().textContent).not.toContain("late-a-version");
  });

  it("freezes a closed pack snapshot and refreshes the same project on reopening", async () => {
    const a = pack("a");
    const requests: { resolve: (value: ModpackVersion[]) => void; reject: (error: Error) => void }[] = [];
    commandMock.mockImplementation(async (name) => name === "list_modpack_versions"
      ? new Promise((resolve, reject) => { requests.push({ resolve, reject }); }) : mockLauncher.manifest);
    const props = { onOpenChange: vi.fn(), onInstalled: vi.fn() };
    await render(createElement(CreateInstanceDialog, { ...props, open: true, project: a }));
    const beforeClose = container.querySelector("dialog")!.textContent;
    await render(createElement(CreateInstanceDialog, { ...props, open: false, project: a }));
    await act(async () => requests[0].resolve([packVersion("closed-version")]));
    expect(container.querySelector("dialog")!.textContent).toBe(beforeClose);
    await render(createElement(CreateInstanceDialog, { ...props, open: true, project: a }));
    expect(packInstall().disabled).toBe(true);
    await act(async () => requests[1].resolve([packVersion("fresh-version")]));
    expect(packChoice().textContent).toContain("fresh-version");
    await render(createElement(CreateInstanceDialog, { ...props, open: false, project: a }));
    expect(packChoice().textContent).toContain("fresh-version");
    await render(createElement(CreateInstanceDialog, { ...props, open: true, project: a }));
    expect(packInstall().disabled).toBe(true);
    await render(null);
    await act(async () => requests[2].reject(new Error("unmounted request")));
    expect(container.childElementCount).toBe(0);
  });

  it("composes the collection as a command bar and identity-driven instance sheet", async () => {
    expect(instanceTabRegistry.ids()).toEqual(["overview", "content", "worlds", "logs", "settings"]);
    await render(createElement(LibraryPage));
    const card = container.querySelector<HTMLElement>('[data-instance-id="fixture-world"]')!;
    expect(card.dataset.visualOwner).toBe("lattice");
    expect(card.querySelector("[data-launch]")!.getAttribute("data-variant")).toBe("secondary");
    expect(card.querySelectorAll(".vx-lattice-frame__dot")).toHaveLength(0);
    expect(card.querySelector(':scope > .vx-lattice-frame[data-selected="true"]')).not.toBeNull();
    expect(card.querySelector("svg[data-selected-mark]")).toBeNull();
    expect(card.querySelector(".vx-instance-card__path")?.getAttribute("title")).toBe(instance.gameDirectory);
    expect(card.querySelector(".vx-instance-card__name")?.getAttribute("title")).toBe(instance.name);
    const technical = card.querySelector(".vx-instance-card__technical")!;
    const technicalItems = [...technical.querySelectorAll(":scope > span")].map((item) => item.textContent);
    expect(technical.getAttribute("title")).toContain("1.21.1");
    expect(technicalItems).toEqual(["1.21.1", "原版"]);
    expect(technical.textContent).not.toContain("·");
    expect(card.textContent).not.toContain("可启动");
    expect(container.querySelector(".vx-library-commandbar")).not.toBeNull();
    // Ctrl+F focuses the first visible input[type="search"] in main.
    expect(container.querySelector<HTMLInputElement>(".vx-library-commandbar input")?.type).toBe("search");
    expect(container.querySelector(".vx-instance-sheet")).not.toBeNull();
    // The command bar's primary button is the one way to create once instances exist.
    expect(container.querySelector("[data-create-instance]")).toBeNull();
    // Opening a card stays inside the launcher: a chevron, never an external-link arrow.
    expect(card.querySelector(".lucide-arrow-up-right")).toBeNull();
    expect(card.querySelector(".vx-instance-card__open .lucide-chevron-right")).not.toBeNull();
    expect(container.querySelector(".vx-instance-grid")).toBeNull();
    expect(card.querySelector(".vx-lattice-frame")?.getAttribute("data-signature")).toBe("fixture-world");
    expect(card.querySelector(".vx-lattice-frame")?.getAttribute("data-state")).toBe("selected");
  });

  it("keeps only the create card and the actions in an empty game folder", async () => {
    mockLauncher.data.instances = [];
    await render(createElement(LibraryPage), "en-US");
    const tile = container.querySelector("[data-create-instance]")!;
    expect(tile).not.toBeNull();
    expect(tile.querySelector(".lucide-arrow-up-right")).toBeNull();
    // Nothing to search, sort or switch views over.
    const bar = container.querySelector(".vx-library-commandbar")!;
    expect(bar.querySelector('input[type="search"]')).toBeNull();
    expect(bar.querySelector(".vx-library-sort-select")).toBeNull();
    expect(bar.querySelector(".vx-library-view")).toBeNull();
    expect(bar.querySelector(".vx-library-more")).not.toBeNull();
    expect([...bar.querySelectorAll(".vx-library-commandbar__actions button")].map(button => button.textContent))
      .toEqual(["Import modpack", "Create instance"]);
  });

  it("opens the detail view and calls content, world, and diagnostic APIs in its context", async () => {
    await render(createElement(InstanceDetailPage, { instance, onBack: vi.fn(), onChanged: vi.fn(), onLaunch: vi.fn() }));
    expect(container.querySelector(".vx-detail-layout")).not.toBeNull();
    expect(container.querySelector(".vx-detail-context")).not.toBeNull();
    expect(container.querySelector(".vx-detail-workspace")).not.toBeNull();
    expect(container.querySelector('.vx-detail-context [role="tablist"]')).not.toBeNull();
    expect(container.querySelector(".vx-overview-ledger")).not.toBeNull();
    expect(container.querySelector(".vx-overview-operations")).not.toBeNull();
    await act(async () => container.querySelector<HTMLElement>('[role="tab"][data-tab="content"]')!.click());
    expect(commandMock).toHaveBeenCalledWith("list_local_resources", { versionId: "1.21.1", instanceId: "fixture-world", resourceType: "resourcepack" });
    await act(async () => container.querySelector<HTMLElement>('[role="tab"][data-tab="worlds"]')!.click());
    expect(commandMock).toHaveBeenCalledWith("list_worlds", { versionId: "1.21.1", instanceId: "fixture-world" });
    expect(commandMock).toHaveBeenCalledWith("list_screenshots", { versionId: "1.21.1", instanceId: "fixture-world" });
    await act(async () => container.querySelector<HTMLElement>('[role="tab"][data-tab="logs"]')!.click());
    await act(async () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("分析最近错误"))!.click());
    expect(commandMock).toHaveBeenCalledWith("diagnose_instance", { versionId: "1.21.1", instanceId: "fixture-world" });
  });

  it("lets launch repair a missing official base and blocks only unrecoverable profiles", async () => {
    for (const repairable of ["baseMissing", "clientJarMissing"]) {
      mockLauncher.data.instances = [{ ...instance, issue: repairable }];
      mockLauncher.selectedInstance = mockLauncher.data.instances[0];
      await render(createElement(LibraryPage));
      const card = container.querySelector<HTMLElement>('[data-instance-id="fixture-world"]')!;
      expect(card.querySelector<HTMLButtonElement>("[data-launch]")!.disabled, repairable).toBe(false);
      expect(card.textContent, repairable).not.toContain("无法启动");
    }
    mockLauncher.data.instances = [{ ...instance, issue: "invalidMainClass" }];
    mockLauncher.selectedInstance = mockLauncher.data.instances[0];
    await render(createElement(LibraryPage));
    const card = container.querySelector<HTMLElement>('[data-instance-id="fixture-world"]')!;
    expect(card.textContent).toContain("无法启动");
    expect(card.querySelector<HTMLButtonElement>("[data-launch]")!.disabled).toBe(true);
    expect(card.querySelector<HTMLButtonElement>("[data-launch]")!.title).toContain("主类");
  });

  it("shows a shared instance's isolation and switches it with an explicit copy-worlds choice", async () => {
    const onChanged = vi.fn(async () => {});
    const shared = { ...instance, kind: "version" as const, isolated: false, gameFolder: "C:\\SyntheticFixture", folderMissingSince: null };
    const confirm = confirmMock.mockResolvedValue(true);
    await render(createElement(InstanceDetailPage, { instance: shared, onBack: vi.fn(), onChanged, onLaunch: vi.fn() }));
    expect(container.textContent).toContain("与其他实例共享");
    expect(container.textContent).toContain("备份、恢复、导出、更换加载器和整合包更新都需要独立的游戏目录");
    await act(async () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "独立游戏目录")!.click());
    expect(confirm).not.toHaveBeenCalled();
    // One dialog, three explicit choices: copy worlds, start empty, or cancel.
    await act(async () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "隔离并复制世界")!.click());
    expect(confirm).not.toHaveBeenCalled();
    expect(commandMock).toHaveBeenCalledWith("set_instance_isolation", {
      instanceId: "fixture-world", isolated: true, copyWorlds: true,
    });
    expect(onChanged).toHaveBeenCalled();
  });

  it("cancelling the isolation dialog never isolates the instance", async () => {
    const shared = { ...instance, kind: "version" as const, isolated: false, gameFolder: "C:\\SyntheticFixture", folderMissingSince: null };
    await render(createElement(InstanceDetailPage, { instance: shared, onBack: vi.fn(), onChanged: vi.fn(), onLaunch: vi.fn() }));
    await act(async () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "独立游戏目录")!.click());
    await act(async () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "取消")!.click());
    expect(commandMock).not.toHaveBeenCalledWith("set_instance_isolation", expect.anything());
  });

  it("returns an isolated instance to the shared directory only after confirmation", async () => {
    const onChanged = vi.fn(async () => {});
    const isolatedVersion = { ...instance, kind: "version" as const, isolated: true, gameFolder: "C:\\SyntheticFixture", folderMissingSince: null };
    confirmMock.mockResolvedValueOnce(false).mockResolvedValue(true);
    await render(createElement(InstanceDetailPage, { instance: isolatedVersion, onBack: vi.fn(), onChanged, onLaunch: vi.fn() }));
    const share = () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "与其他实例共享")!;
    await act(async () => share().click());
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(confirmMock.mock.calls[0]?.[0]).toContain("共享游戏目录");
    expect(commandMock).not.toHaveBeenCalledWith("set_instance_isolation", expect.anything());
    expect(onChanged).not.toHaveBeenCalled();
    await act(async () => share().click());
    expect(commandMock).toHaveBeenCalledWith("set_instance_isolation", {
      instanceId: "fixture-world", isolated: false, copyWorlds: false,
    });
    expect(onChanged).toHaveBeenCalled();
  });

  it("deletes an instance to the recycle bin by default and lists dependants", async () => {
    const version = { ...instance, kind: "version" as const, isolated: true, gameFolder: "C:\\SyntheticFixture" };
    const dependants = vi.fn(async () => [] as string[]);
    const base = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => {
      if (name === "list_instance_dependants") return dependants();
      return base(name, args);
    });
    await render(createElement(InstanceDetailPage, { instance: version, onBack: vi.fn(), onChanged: vi.fn(async () => {}), onLaunch: vi.fn() }));
    const disclosure = container.querySelector<HTMLDetailsElement>(".vx-detail-manage")!;
    const summary = disclosure.querySelector<HTMLElement>("summary")!;
    vi.spyOn(summary, "getBoundingClientRect").mockReturnValue(new DOMRect(900, 160, 38, 38));
    await act(async () => { summary.click(); });
    await act(async () => { disclosure.open = true; disclosure.dispatchEvent(new Event("toggle")); });
    const menu = document.querySelector<HTMLElement>(".vx-detail-manage__menu");
    expect(menu, document.body.innerHTML).not.toBeNull();
    await act(async () => Array.from(menu!.querySelectorAll("button")).find((button) => button.textContent === "删除实例文件夹")!.click());
    expect(dependants).toHaveBeenCalled();
    expect(document.body.textContent).toContain("移到回收站");
    await act(async () => document.querySelector<HTMLButtonElement>("[data-delete-recycle]")!.click());
    expect(commandMock).toHaveBeenCalledWith("delete_instance", {
      instanceId: "fixture-world", confirmed: true, permanent: false,
    });

    // A dependant blocks the destructive choices and is named in the dialog.
    commandMock.mockImplementation(async (name, args) => {
      if (name === "list_instance_dependants") return ["1.21.1-Fabric"];
      return base(name, args);
    });
    await render(createElement(InstanceDetailPage, { instance: version, onBack: vi.fn(), onChanged: vi.fn(async () => {}), onLaunch: vi.fn() }));
    const secondDisclosure = container.querySelector<HTMLDetailsElement>(".vx-detail-manage")!;
    const secondSummary = secondDisclosure.querySelector<HTMLElement>("summary")!;
    vi.spyOn(secondSummary, "getBoundingClientRect").mockReturnValue(new DOMRect(900, 160, 38, 38));
    await act(async () => { secondSummary.click(); });
    await act(async () => { secondDisclosure.open = true; secondDisclosure.dispatchEvent(new Event("toggle")); });
    const secondMenu = document.querySelector<HTMLElement>(".vx-detail-manage__menu");
    await act(async () => Array.from(secondMenu!.querySelectorAll("button")).find((button) => button.textContent === "删除实例文件夹")!.click());
    expect(document.body.textContent).toContain("1.21.1-Fabric");
    expect(document.querySelector("[data-delete-recycle]")).toBeNull();
    expect(document.querySelector("[data-delete-permanent]")).toBeNull();
  });

  it("falls back to the confirmed permanent delete when no recycle bin is available", async () => {
    const version = { ...instance, kind: "version" as const, isolated: true, gameFolder: "C:\\SyntheticFixture" };
    const base = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => {
      if (name === "list_instance_dependants") return [];
      if (name === "delete_instance") {
        throw { code: "instance.recycleUnavailable", params: { reason: "pathTooLong" } };
      }
      return base(name, args);
    });
    await render(createElement(InstanceDetailPage, {
      instance: version, onBack: vi.fn(), onChanged: vi.fn(async () => {}), onLaunch: vi.fn(),
    }));
    const disclosure = container.querySelector<HTMLDetailsElement>(".vx-detail-manage")!;
    const summary = disclosure.querySelector<HTMLElement>("summary")!;
    vi.spyOn(summary, "getBoundingClientRect").mockReturnValue(new DOMRect(900, 160, 38, 38));
    await act(async () => { summary.click(); });
    await act(async () => { disclosure.open = true; disclosure.dispatchEvent(new Event("toggle")); });
    const menu = document.querySelector<HTMLElement>(".vx-detail-manage__menu");
    await act(async () => Array.from(menu!.querySelectorAll("button")).find((button) => button.textContent === "删除实例文件夹")!.click());
    await act(async () => document.querySelector<HTMLButtonElement>("[data-delete-recycle]")!.click());

    // The coded failure keeps the dialog open, shows the reason code
    // translated (never the code itself), and leaves the separately confirmed
    // permanent delete as the only choice.
    expect(document.body.textContent).toContain("此文件夹无法移到回收站：它的路径过长，回收站无法处理。");
    expect(document.body.textContent).not.toContain("pathTooLong");
    expect(document.querySelector("[data-delete-recycle]")).toBeNull();
    expect(document.querySelector("[data-delete-permanent-fallback]")).not.toBeNull();
    expect(document.body.textContent).toContain("永久删除");

    // The permanent delete asks once more; cancelling it deletes nothing.
    const permanentCalls = () => commandMock.mock.calls.filter(([name, args]) => name === "delete_instance" && args?.permanent === true);
    await act(async () => document.querySelector<HTMLButtonElement>("[data-delete-permanent-fallback]")!.click());
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(confirmMock.mock.calls[0]?.[0]).toContain("无法撤销");
    expect(confirmMock.mock.calls[0]?.[1]).toEqual({ tone: "danger" });
    expect(permanentCalls()).toHaveLength(0);
    confirmMock.mockResolvedValue(true);
    await act(async () => document.querySelector<HTMLButtonElement>("[data-delete-permanent-fallback]")!.click());
    expect(permanentCalls()).toEqual([["delete_instance", { instanceId: "fixture-world", confirmed: true, permanent: true }]]);
    commandMock.mockImplementation(base);
  });

  it("shows hidden instances in the library overflow menu and restores one", async () => {
    const hidden = { ...instance, id: "hidden-world", name: "隐藏世界", hidden: true };
    const baseHidden = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => {
      if (name === "list_hidden_instances") return [hidden];
      if (name === "restore_instance") return hidden;
      return baseHidden(name, args);
    });
    await render(createElement(LibraryPage));
    await act(async () => container.querySelector<HTMLElement>(".vx-library-more summary")!.click());
    await act(async () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "显示隐藏的实例")!.click());
    expect(document.body.textContent).toContain("隐藏世界");
    await act(async () => Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "恢复")!.click());
    expect(commandMock).toHaveBeenCalledWith("restore_instance", { instanceId: "hidden-world" });
    expect(mockLauncher.reload).toHaveBeenCalled();
  });

  it("converts a launcher-managed instance from its detail page", async () => {
    const onChanged = vi.fn(async () => {});
    confirmMock.mockResolvedValueOnce(false).mockResolvedValue(true);
    const managed = {
      ...instance,
      kind: "managed" as const,
      isolated: true,
      gameFolder: "",
      gameDirectory: "C:\\SyntheticFixture\\instances\\fixture-world",
    };
    await render(createElement(InstanceDetailPage, { instance: managed, onBack: vi.fn(), onChanged, onLaunch: vi.fn() }));
    const convert = () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "转换为标准实例文件夹")!;
    await act(async () => convert().click());
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(confirmMock.mock.calls[0]?.[0]).toContain("versions/<name>/");
    expect(commandMock).not.toHaveBeenCalledWith("convert_managed_instance", expect.anything());
    expect(onChanged).not.toHaveBeenCalled();
    await act(async () => convert().click());
    expect(commandMock).toHaveBeenCalledWith("convert_managed_instance", { instanceId: "fixture-world" });
    expect(onChanged).toHaveBeenCalled();
  });

  it("switches the active game folder from the library selector", async () => {
    const other = "D:\\OtherGame";
    mockLauncher.config = {
      ...mockLauncher.config,
      gameFolders: [
        { path: "C:\\SyntheticFixture", label: "", active: true },
        { path: other, label: "PCL", active: false },
      ],
    };
    mockLauncher.data.config = mockLauncher.config;
    await render(createElement(LibraryPage));
    const selector = container.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="游戏文件夹"]')!;
    expect(selector).not.toBeNull();
    giveBackupSelectBounds(selector);
    await act(async () => selector.click());
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((candidate) => candidate.textContent?.includes("PCL"));
    expect(option).not.toBeUndefined();
    await act(async () => option!.click());
    expect(commandMock).toHaveBeenCalledWith("set_active_game_folder", { path: other });
    expect(mockLauncher.reload).toHaveBeenCalled();
  });

  it("passes loader and instance creation arguments through the shared create flow", async () => {
    await render(createElement(CreateInstanceDialog, { open: true, onOpenChange: vi.fn(), onInstalled: vi.fn() }));
    await act(async () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Fabric")!.click());
    const name = container.querySelector<HTMLInputElement>('[id$="-create-instance-name"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(name, "Fabric 世界");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("安装并准备"))!.click());
    expect(commandMock).toHaveBeenCalledWith("create_game_instance", {
      name: "Fabric 世界",
      gameVersion: "1.21.1",
      loader: "fabric",
      loaderVersion: "0.16.9",
    });
  });

  it("retains the loader choice while collapsed and removes it from interaction", async () => {
    await render(createElement(CreateInstanceDialog, { open: true, onOpenChange: vi.fn(), onInstalled: vi.fn() }));
    const slot = container.querySelector<HTMLElement>(".vx-create-loader-slot")!;
    const choice = () => slot.querySelector<HTMLButtonElement>('[role="combobox"]');
    expect(choice()).not.toBeNull();
    expect(choice()!.disabled).toBe(true);
    expect(slot.hasAttribute("inert")).toBe(true);
    expect(slot.getAttribute("aria-hidden")).toBe("true");
    const loader = (name: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === name)!;
    await act(async () => loader("Fabric").click());
    const selected = choice()!;
    expect(selected.disabled).toBe(false);
    expect(selected.textContent).toContain("0.16.9");
    expect(slot.hasAttribute("inert")).toBe(false);
    vi.spyOn(selected, "getBoundingClientRect").mockReturnValue({ x: 50, y: 50, width: 300, height: 38, top: 50, right: 350, bottom: 88, left: 50, toJSON: () => ({}) });
    await act(async () => selected.click());
    expect(selected.getAttribute("aria-expanded")).toBe("true");
    await act(async () => loader("原版").click());
    expect(choice()).toBe(selected);
    expect(selected.textContent).toContain("0.16.9");
    expect(selected.disabled).toBe(true);
    expect(slot.hasAttribute("inert")).toBe(true);
    expect(selected.getAttribute("aria-expanded")).toBe("false");
    await act(async () => selected.click());
    expect(selected.getAttribute("aria-expanded")).toBe("false");
  });

  it("preserves the loader display while closing and closes its portalled choices", async () => {
    const props = { onOpenChange: vi.fn(), onInstalled: vi.fn() };
    await render(createElement(CreateInstanceDialog, { ...props, open: true }));
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Fabric")!.click());
    const selected = container.querySelector<HTMLButtonElement>('[id$="-create-loader-version"]')!;
    vi.spyOn(selected, "getBoundingClientRect").mockReturnValue({ x: 50, y: 50, width: 300, height: 38, top: 50, right: 350, bottom: 88, left: 50, toJSON: () => ({}) });
    await act(async () => selected.click());
    expect(selected.getAttribute("aria-expanded")).toBe("true");
    const displayed = selected.textContent;
    await render(createElement(CreateInstanceDialog, { ...props, open: false }));
    expect(container.querySelector('[id$="-create-loader-version"]')).toBe(selected);
    expect(selected.textContent).toBe(displayed);
    expect(selected.disabled).toBe(true);
    expect(selected.closest("[inert]")).not.toBeNull();
    expect(selected.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps fields and submit forms scoped to each mounted creation dialog", async () => {
    await render(createElement("div", null,
      createElement(CreateInstanceDialog, { open: false, onOpenChange: vi.fn(), onInstalled: vi.fn() }),
      createElement(CreateInstanceDialog, { open: false, onOpenChange: vi.fn(), onInstalled: vi.fn() })));
    const ids = [...container.querySelectorAll<HTMLElement>("[id]")].map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const submit of container.querySelectorAll<HTMLButtonElement>('button[form]')) {
      expect(submit.form?.closest("dialog")).toBe(submit.closest("dialog"));
    }
  });

  it("switches creation panels by keyboard without turning loader choices into tabs", async () => {
    await render(createElement(CreateInstanceDialog, { open: true, onOpenChange: vi.fn(), onInstalled: vi.fn() }));
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    tabs[0].focus();
    await act(async () => tabs[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(tabs[1]);
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(tabs[0].tabIndex).toBe(-1);
    const importPanel = container.querySelector('[role="tabpanel"]')!;
    expect(importPanel.getAttribute("aria-labelledby")).toBe(tabs[1].id);
    expect(importPanel.querySelector('input[type="password"]')).not.toBeNull();
    await act(async () => tabs[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true })));
    const fabric = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Fabric")!;
    expect(fabric.getAttribute("aria-pressed")).toBe("false");
    expect(fabric.tabIndex).toBe(0);
    fabric.focus();
    const arrow = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
    await act(async () => fabric.dispatchEvent(arrow));
    expect(arrow.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(fabric);
  });

  it("gives resource views one tab stop and replaces the old content panel", async () => {
    await render(createElement(InstanceDetailPage, { instance, onBack: vi.fn(), onChanged: vi.fn(), onLaunch: vi.fn() }));
    await act(async () => container.querySelector<HTMLElement>('[data-tab="content"]')!.click());
    const lists = [...container.querySelectorAll('[role="tablist"]')];
    const tabs = [...lists[1].querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs.filter((tab) => tab.tabIndex === 0)).toHaveLength(1);
    tabs[0].focus();
    await act(async () => tabs[0].dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(tabs[2]);
    expect(tabs[2].getAttribute("aria-selected")).toBe("true");
    expect(container.querySelectorAll('[role="tabpanel"]')).toHaveLength(2);
    const resourcePanel = document.getElementById(tabs[2].getAttribute("aria-controls")!);
    expect(resourcePanel?.getAttribute("aria-labelledby")).toBe(tabs[2].id);
  });

  it("opens an instance detail and scopes content commands to that instance", async () => {
    await render(createElement(LibraryPage));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-instance-id="fixture-world"] .vx-instance-card__select')!.click());
    expect(container.querySelector(".vx-detail-header h1")?.textContent).toContain("合成测试世界");
    expect(container.querySelector('[data-tab="settings"]')).not.toBeNull();
    await act(async () => container.querySelector<HTMLElement>('[data-tab="content"]')!.click());
    expect(commandMock).toHaveBeenCalledWith("list_local_resources", { versionId: "1.21.1", instanceId: "fixture-world", resourceType: "resourcepack" });
    await act(async () => container.querySelector<HTMLElement>('[data-tab="worlds"]')!.click());
    expect(commandMock).toHaveBeenCalledWith("list_worlds", { versionId: "1.21.1", instanceId: "fixture-world" });
    await act(async () => container.querySelector<HTMLElement>('[data-tab="logs"]')!.click());
    await act(async () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("分析最近错误"))!.click());
    expect(commandMock).toHaveBeenCalledWith("diagnose_instance", { versionId: "1.21.1", instanceId: "fixture-world" });
  });

  it("keeps the current instance visibly selected with the shared frame owned", async () => {
    await render(createElement(LibraryPage));
    const card = container.querySelector<HTMLElement>('[data-instance-id="fixture-world"]')!;
    expect(card.getAttribute("aria-current")).toBeNull();
    expect(card.querySelector(".vx-instance-card__select")?.getAttribute("aria-current")).toBe("true");
    const marker = card.querySelector(':scope > .vx-lattice-frame[data-selected="true"]');
    expect(marker).not.toBeNull();
    expect(marker?.getAttribute("aria-hidden")).toBe("true");
    expect(card.querySelector("svg[data-selected-mark]")).toBeNull();
  });

  describe("local resource files", () => {
    function localFile(name: string, options: Partial<LocalResource> = {}): LocalResource {
      const fileName = options.fileName ?? `${name.toLocaleLowerCase().replaceAll(" ", "-")}.jar`;
      return { path: `mods/${fileName}`, size: 100, enabled: true, ...options, name, fileName };
    }

    function metadata(name: string, authors: string[] = [], extra: Partial<LocalModMetadata> = {}): LocalModMetadata {
      return {
        loader: "fabric", modId: name.toLocaleLowerCase().replaceAll(" ", "_"), name, version: "1.0.0",
        description: "", authors, hasIcon: false, dependencies: [], additionalMods: 0, ...extra,
      };
    }

    const search = () => container.querySelector<HTMLInputElement>(".vx-resource-search")!;
    const typeSearch = async (value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search(), value);
      search().dispatchEvent(new Event("input", { bubbles: true }));
    });
    const rows = () => [...container.querySelectorAll<HTMLElement>(".vx-resource-file-row")];
    const rowNames = () => rows().map((row) => row.querySelector("strong")?.textContent);
    const filters = () => [...container.querySelectorAll<HTMLButtonElement>(".vx-resource-filter button")];
    const filterLabels = () => filters().map((button) => button.textContent);
    const headerCheckbox = () => container.querySelector<HTMLInputElement>(".vx-resource-list__header input")!;
    const rowCheckbox = (name: string) => container.querySelector<HTMLInputElement>(`input[type="checkbox"][aria-label="${name}"]`)!;
    const batchButton = (label: string) => [...container.querySelectorAll<HTMLButtonElement>(".vx-resource-batch button")]
      .find((button) => button.textContent === label)!;
    const selectionStatus = () => container.querySelector<HTMLElement>('.vx-resource-batch [role="status"]');

    it("searches files by display name, file name, metadata and author, and filters states with search-following counts", async () => {
      const resources = [
        localFile("Alpha Mod", { fileName: "alpha-mod.jar", metadata: metadata("Alpha Mod", ["Alice"], { modId: "alpha_core", version: "2.3.4" }) }),
        localFile("Beta Pack", { fileName: "beta-pack.jar" }),
        localFile("Gamma Tools", { fileName: "gamma-tools.jar", enabled: false, metadata: metadata("Gamma Tools", ["Carol"]) }),
      ];
      commandMock.mockImplementation(async (name) => name === "list_local_resources" ? resources : []);
      await render(createElement(InstanceContent, { versionId: "1.21.1", instanceId: instance.id }));

      expect(rowNames()).toEqual(["Alpha Mod", "Beta Pack", "Gamma Tools"]);
      expect(search().getAttribute("aria-label")).toBe("搜索文件");
      expect(filterLabels()).toEqual(["全部 (3)", "已启用 (2)", "已禁用 (1)"]);

      await typeSearch("alice");
      expect(rowNames()).toEqual(["Alpha Mod"]);
      expect(filterLabels()).toEqual(["全部 (1)", "已启用 (1)", "已禁用 (0)"]);

      await typeSearch("2.3.4");
      expect(rowNames()).toEqual(["Alpha Mod"]);
      await typeSearch("beta-pack");
      expect(rowNames()).toEqual(["Beta Pack"]);

      await typeSearch("");
      await act(async () => filters()[2].click());
      expect(filters()[2].getAttribute("aria-pressed")).toBe("true");
      expect(rowNames()).toEqual(["Gamma Tools"]);
      expect(filterLabels()).toEqual(["全部 (3)", "已启用 (2)", "已禁用 (1)"]);

      await act(async () => filters()[1].click());
      expect(rowNames()).toEqual(["Alpha Mod", "Beta Pack"]);
      await act(async () => filters()[0].click());
      expect(rowNames()).toEqual(["Alpha Mod", "Beta Pack", "Gamma Tools"]);

      await typeSearch("no such file");
      expect(rows()).toHaveLength(0);
      expect(container.querySelector(".vx-resource-no-match")?.textContent).toBe("没有匹配的文件。");
      expect(container.querySelector(".vx-empty")).toBeNull();
      expect(filterLabels()).toEqual(["全部 (0)", "已启用 (0)", "已禁用 (0)"]);
    });

    it("selects all visible rows only and keeps hidden selections through search changes", async () => {
      const resources = [
        localFile("Alpha Mod", { metadata: metadata("Alpha Mod", ["Alice"]) }),
        localFile("Beta Pack", { metadata: metadata("Beta Pack", ["Alice"]) }),
        localFile("Gamma Tools", { metadata: metadata("Gamma Tools", ["Carol"]) }),
      ];
      commandMock.mockImplementation(async (name) => name === "list_local_resources" ? resources : []);
      await render(createElement(InstanceContent, { versionId: "1.21.1", instanceId: instance.id }));

      await typeSearch("alice");
      expect(rows()).toHaveLength(2);
      await act(async () => headerCheckbox().click());
      expect(selectionStatus()?.textContent).toBe("已选择 2 个文件");
      expect(rowCheckbox("Alpha Mod").checked).toBe(true);
      expect(rowCheckbox("Beta Pack").checked).toBe(true);
      expect(rowCheckbox("Gamma Tools")).toBeNull();

      await typeSearch("");
      expect(rows()).toHaveLength(3);
      expect(selectionStatus()?.textContent).toBe("已选择 2 个文件");
      expect(headerCheckbox().indeterminate).toBe(true);
      expect(headerCheckbox().checked).toBe(false);
      expect(rowCheckbox("Gamma Tools").checked).toBe(false);

      await typeSearch("gamma");
      expect(rows()).toHaveLength(1);
      expect(selectionStatus()?.textContent).toBe("已选择 2 个文件");
      expect(headerCheckbox().checked).toBe(false);
      expect(headerCheckbox().indeterminate).toBe(false);

      await typeSearch("");
      await act(async () => headerCheckbox().click());
      expect(selectionStatus()?.textContent).toBe("已选择 3 个文件");
      expect(rows().every((row) => row.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked)).toBe(true);

      await act(async () => headerCheckbox().click());
      expect(selectionStatus()?.textContent).toBe("勾选文件以批量操作");
      expect(rows().every((row) => !row.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked)).toBe(true);
    });

    it("keeps a selected row selected when its own toggle renames the file", async () => {
      let resources = [
        localFile("Alpha Mod", { fileName: "alpha-mod.jar", enabled: true }),
        localFile("Beta Pack", { fileName: "beta-pack.jar", enabled: true }),
        localFile("Gamma Tools", { fileName: "gamma-tools.jar", enabled: true }),
      ];
      commandMock.mockImplementation(async (name, args) => {
        if (name === "list_local_resources") return resources;
        if (name === "toggle_resource") {
          const fileName = String(args?.fileName);
          resources = resources.map((file) => file.fileName === fileName
            ? { ...file, enabled: !file.enabled, fileName: file.enabled ? `${file.fileName}.disabled` : file.fileName.replace(/\.disabled$/, "") }
            : file);
          return resources.find((file) => file.fileName === fileName || file.fileName === `${fileName}.disabled`) ?? null;
        }
        return [];
      });
      await render(createElement(InstanceContent, { versionId: "1.21.1", instanceId: instance.id }));
      await act(async () => headerCheckbox().click());
      expect(selectionStatus()?.textContent).toBe("已选择 3 个文件");

      const alphaRow = () => rows().find((row) => row.querySelector("strong")?.textContent === "Alpha Mod")!;
      await act(async () => alphaRow().querySelector<HTMLButtonElement>("button")!.click());

      expect(alphaRow().querySelector<HTMLButtonElement>("button")!.textContent).toBe("已禁用");
      expect(rowCheckbox("Alpha Mod").checked).toBe(true);
      expect(selectionStatus()?.textContent).toBe("已选择 3 个文件");

      await act(async () => alphaRow().querySelector<HTMLButtonElement>("button")!.click());
      expect(alphaRow().querySelector<HTMLButtonElement>("button")!.textContent).toBe("已启用");
      expect(rowCheckbox("Alpha Mod").checked).toBe(true);
      expect(selectionStatus()?.textContent).toBe("已选择 3 个文件");
    });

    it("uses the English plural form for the selected count", async () => {
      const resources = [localFile("Alpha"), localFile("Beta")];
      commandMock.mockImplementation(async (name) => name === "list_local_resources" ? resources : []);
      await render(createElement(InstanceContent, { versionId: "1.21.1", instanceId: instance.id }), "en-US");
      await act(async () => headerCheckbox().click());
      expect(selectionStatus()?.textContent).toBe("2 files selected");
      await act(async () => rowCheckbox("Alpha").click());
      expect(selectionStatus()?.textContent).toBe("1 file selected");
    });

    it("reserves the selection bar before the first selection and keeps focus when clearing", async () => {
      const resources = [localFile("Alpha"), localFile("Beta")];
      commandMock.mockImplementation(async (name) => name === "list_local_resources" ? resources : []);
      await render(createElement(InstanceContent, { versionId: "1.21.1", instanceId: instance.id }));

      const bar = container.querySelector<HTMLElement>(".vx-resource-batch");
      expect(bar).not.toBeNull();
      expect(container.querySelector(".vx-resource-files > .vx-resource-controls")).not.toBeNull();
      expect(container.querySelector(".vx-resource-files > .vx-resource-batch")).toBe(bar);
      expect(instanceDetailCss).toMatch(/\.vx-resource-files\s*\{[^}]*display:\s*grid;[^}]*gap:\s*var\(--space-3\)/);
      expect(selectionStatus()?.textContent).toBe("勾选文件以批量操作");
      expect(batchButton("启用").disabled).toBe(true);
      expect(batchButton("禁用").disabled).toBe(true);
      expect(batchButton("清除选择").disabled).toBe(true);

      await act(async () => rowCheckbox("Alpha").click());
      expect(container.querySelector(".vx-resource-batch")).toBe(bar);
      expect(selectionStatus()?.textContent).toBe("已选择 1 个文件");
      const clear = batchButton("清除选择");
      clear.focus();
      expect(document.activeElement).toBe(clear);
      await act(async () => clear.click());
      expect(selectionStatus()?.textContent).toBe("勾选文件以批量操作");
      expect(container.querySelector(".vx-resource-batch")).toBe(bar);
      expect(document.activeElement).toBe(headerCheckbox());
      expect(clear.disabled).toBe(true);
      expect(rowCheckbox("Alpha").checked).toBe(false);
      expect(rowCheckbox("Beta").checked).toBe(false);
    });

    it("keys the selection by file name so an enabled and a disabled twin stay independent", async () => {
      const resources = [
        localFile("Twin", { fileName: "twin.jar", enabled: true }),
        localFile("Twin", { fileName: "twin.jar.disabled", enabled: false }),
      ];
      commandMock.mockImplementation(async (name) => name === "list_local_resources" ? resources : []);
      await render(createElement(InstanceContent, { versionId: "1.21.1", instanceId: instance.id }));

      const enabledCheckbox = () => rows().find((row) => row.querySelector("button")?.textContent === "已启用")!
        .querySelector<HTMLInputElement>('input[type="checkbox"]')!;
      const disabledCheckbox = () => rows().find((row) => row.querySelector("button")?.textContent === "已禁用")!
        .querySelector<HTMLInputElement>('input[type="checkbox"]')!;

      await act(async () => enabledCheckbox().click());
      expect(enabledCheckbox().checked).toBe(true);
      expect(disabledCheckbox().checked).toBe(false);
      expect(selectionStatus()?.textContent).toBe("已选择 1 个文件");

      await act(async () => filters()[2].click());
      expect(rows()).toHaveLength(1);
      expect(disabledCheckbox().checked).toBe(false);
      await act(async () => headerCheckbox().click());
      expect(disabledCheckbox().checked).toBe(true);
      expect(selectionStatus()?.textContent).toBe("已选择 2 个文件");
    });

    it("disables batch and toolbar controls while a batch is pending and ignores Retry", async () => {
      const resources = [
        localFile("Alpha Mod", { fileName: "alpha-mod.jar" }),
        localFile("Beta Pack", { fileName: "beta-pack.jar" }),
      ];
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const toggled: string[] = [];
      commandMock.mockImplementation(async (name, args) => {
        if (name === "list_local_resources") return resources;
        if (name === "toggle_resource") {
          toggled.push(String(args?.fileName));
          await gate;
          return resources.find((file) => file.fileName === args?.fileName) ?? null;
        }
        return [];
      });
      await render(createElement(InstanceContent, { versionId: "1.21.1", instanceId: instance.id }));
      await act(async () => rowCheckbox("Alpha Mod").click());
      await act(async () => batchButton("禁用").click());

      expect(toggled).toEqual(["alpha-mod.jar"]);
      expect(batchButton("启用").disabled).toBe(true);
      expect(batchButton("禁用").disabled).toBe(true);
      expect(headerCheckbox().disabled).toBe(true);
      expect(rowCheckbox("Alpha Mod").disabled).toBe(true);
      expect(rowCheckbox("Beta Pack").disabled).toBe(true);
      expect(rows()[0].querySelector<HTMLButtonElement>("button")!.disabled).toBe(true);
      const kindSelect = container.querySelector<HTMLButtonElement>('.vx-resource-kind-select [role="combobox"]')!;
      expect(kindSelect.disabled).toBe(true);
      const retry = [...container.querySelectorAll<HTMLButtonElement>(".vx-toolbar button")]
        .find((button) => button.getAttribute("aria-label") === "刷新")!;
      expect(retry.disabled).toBe(true);

      const listCalls = commandMock.mock.calls.filter(([name]) => name === "list_local_resources").length;
      await act(async () => retry.click());
      await act(async () => batchButton("启用").click());
      expect(toggled).toHaveLength(1);
      expect(commandMock.mock.calls.filter(([name]) => name === "list_local_resources")).toHaveLength(listCalls);

      await act(async () => { release(); });
      await act(async () => {});
      expect(batchButton("禁用").disabled).toBe(false);
      expect(headerCheckbox().disabled).toBe(false);
      expect(rowCheckbox("Alpha Mod").disabled).toBe(false);
      expect(kindSelect.disabled).toBe(false);
      expect(retry.disabled).toBe(false);
    });

    it("finishes a committed batch after the Content tab unmounts mid-flight", async () => {
      const resources = [
        localFile("Alpha Mod", { fileName: "alpha-mod.jar" }),
        localFile("Beta Pack", { fileName: "beta-pack.jar" }),
        localFile("Gamma Tools", { fileName: "gamma-tools.jar" }),
      ];
      const toggled: string[] = [];
      let releaseFirst!: () => void;
      const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
      commandMock.mockImplementation(async (name, args) => {
        if (name === "list_local_resources") return resources;
        if (name === "toggle_resource") {
          const fileName = String(args?.fileName);
          toggled.push(fileName);
          if (toggled.length === 1) await first;
          return resources.find((file) => file.fileName === fileName) ?? null;
        }
        return [];
      });
      await render(createElement(InstanceContent, { versionId: "1.21.1", instanceId: instance.id }));
      await act(async () => headerCheckbox().click());
      await act(async () => batchButton("禁用").click());
      expect(toggled).toEqual(["alpha-mod.jar"]);

      // Switching detail tabs unmounts InstanceContent and bumps its generation.
      await act(async () => root.render(createElement("div")));
      await act(async () => {
        releaseFirst();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(toggled).toEqual(["alpha-mod.jar", "beta-pack.jar", "gamma-tools.jar"]);
    });

    it("does not blame the search when only the state filter hides every file in English", async () => {
      const resources = [localFile("Alpha")];
      commandMock.mockImplementation(async (name) => name === "list_local_resources" ? resources : []);
      await render(createElement(InstanceContent, { versionId: "1.21.1", instanceId: instance.id }), "en-US");

      await act(async () => filters()[2].click());
      expect(rows()).toHaveLength(0);
      expect(container.querySelector(".vx-resource-no-match")?.textContent).toBe("No files match the search or filter.");
    });

    it("batch-disables only the selected enabled files in order and refreshes once, keeping the selection", async () => {
      let resources = [
        localFile("Alpha Mod", { fileName: "alpha-mod.jar", enabled: true }),
        localFile("Beta Pack", { fileName: "beta-pack.jar", enabled: true }),
        localFile("Gamma Tools", { fileName: "gamma-tools.jar", enabled: false }),
      ];
      const toggled: string[] = [];
      commandMock.mockImplementation(async (name, args) => {
        if (name === "list_local_resources") return resources;
        if (name === "toggle_resource") {
          const fileName = String(args?.fileName);
          toggled.push(fileName);
          resources = resources.map((file) => file.fileName === fileName
            ? { ...file, enabled: !file.enabled, fileName: file.enabled ? `${file.fileName}.disabled` : file.fileName.replace(/\.disabled$/, "") }
            : file);
          return resources.find((file) => file.name === fileName.replace(/\.disabled$/, "")) ?? null;
        }
        return [];
      });
      await render(createElement(InstanceContent, { versionId: "1.21.1", instanceId: instance.id }));
      await act(async () => headerCheckbox().click());
      expect(selectionStatus()?.textContent).toBe("已选择 3 个文件");
      await act(async () => batchButton("禁用").click());

      expect(toggled).toEqual(["alpha-mod.jar", "beta-pack.jar"]);
      expect(commandMock.mock.calls.filter(([name]) => name === "toggle_resource")).toEqual([
        ["toggle_resource", { versionId: "1.21.1", instanceId: instance.id, resourceType: "resourcepack", fileName: "alpha-mod.jar" }],
        ["toggle_resource", { versionId: "1.21.1", instanceId: instance.id, resourceType: "resourcepack", fileName: "beta-pack.jar" }],
      ]);
      expect(commandMock.mock.calls.filter(([name]) => name === "list_local_resources")).toHaveLength(2);
      expect(selectionStatus()?.textContent).toBe("已选择 3 个文件");
      expect(filterLabels()).toEqual(["全部 (3)", "已启用 (0)", "已禁用 (3)"]);
      expect(rows().map((row) => row.querySelector<HTMLButtonElement>("button")?.textContent)).toEqual(["已禁用", "已禁用", "已禁用"]);
      expect(rows().every((row) => row.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked)).toBe(true);
    });

    it("stops a batch at the first error, shows it, and refreshes once", async () => {
      const resources = [
        localFile("Alpha Mod", { fileName: "alpha-mod.jar" }),
        localFile("Beta Pack", { fileName: "beta-pack.jar" }),
        localFile("Gamma Tools", { fileName: "gamma-tools.jar" }),
      ];
      const attempted: string[] = [];
      commandMock.mockImplementation(async (name, args) => {
        if (name === "list_local_resources") return resources;
        if (name === "toggle_resource") {
          const fileName = String(args?.fileName);
          attempted.push(fileName);
          if (attempted.length === 2) throw { code: "resource.unavailable", params: {} };
          return resources.find((file) => file.fileName === fileName) ?? null;
        }
        return [];
      });
      await render(createElement(InstanceContent, { versionId: "1.21.1", instanceId: instance.id }));
      await act(async () => headerCheckbox().click());
      await act(async () => batchButton("禁用").click());

      expect(attempted).toEqual(["alpha-mod.jar", "beta-pack.jar"]);
      expect(commandMock.mock.calls.filter(([name]) => name === "list_local_resources")).toHaveLength(2);
      expect(container.querySelector('[role="alert"]')?.textContent).toContain("无法读取资源目录");
      expect(selectionStatus()?.textContent).toBe("已选择 3 个文件");
      expect(batchButton("禁用").disabled).toBe(false);
    });

    it("clears the search and selection when the resource kind changes", async () => {
      const packs = [localFile("Alpha Pack"), localFile("Beta Pack")];
      const mods = [localFile("Delta Mod")];
      commandMock.mockImplementation(async (name, args) => {
        if (name === "list_local_resources") return args?.resourceType === "mod" ? mods : packs;
        return [];
      });
      await render(createElement(InstanceContent, { versionId: "1.21.1", instanceId: instance.id }));
      await typeSearch("alpha");
      await act(async () => headerCheckbox().click());
      expect(selectionStatus()?.textContent).toBe("已选择 1 个文件");

      const kindSelect = container.querySelector<HTMLButtonElement>('.vx-resource-kind-select [role="combobox"]')!;
      giveBackupSelectBounds(kindSelect);
      await act(async () => kindSelect.click());
      await act(async () => document.querySelector<HTMLElement>('[role="option"][data-value="mod"]')!.click());

      expect(commandMock).toHaveBeenCalledWith("list_local_resources", { versionId: "1.21.1", instanceId: instance.id, resourceType: "mod" });
      expect(rowNames()).toEqual(["Delta Mod"]);
      expect(search().value).toBe("");
      expect(selectionStatus()?.textContent).toBe("勾选文件以批量操作");
      expect(batchButton("启用").disabled).toBe(true);
      expect(rowCheckbox("Delta Mod").checked).toBe(false);
      expect(filterLabels()).toEqual(["全部 (1)", "已启用 (1)", "已禁用 (0)"]);
    });

    it("enables batch delete only with a selection and cancels without deleting", async () => {
      const resources = [localFile("Alpha"), localFile("Beta")];
      commandMock.mockImplementation(async (name) => name === "list_local_resources" ? resources : []);
      const confirm = confirmMock.mockResolvedValue(false);
      await render(createElement(InstanceContent, { versionId: "1.21.1", instanceId: instance.id }));

      expect(batchButton("删除").disabled).toBe(true);
      await act(async () => rowCheckbox("Alpha").click());
      expect(batchButton("删除").disabled).toBe(false);

      await act(async () => batchButton("删除").click());
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(String(confirm.mock.calls[0][0])).toContain("1");
      expect(String(confirm.mock.calls[0][0])).toContain("永久");
      expect(commandMock.mock.calls.filter(([name]) => name === "delete_local_resources")).toHaveLength(0);
      expect(commandMock.mock.calls.filter(([name]) => name === "list_local_resources")).toHaveLength(1);
      expect(selectionStatus()?.textContent).toBe("已选择 1 个文件");
    });

    it("deletes the selected files in one batch, refreshes, and clears stale updates", async () => {
      let resources = [localFile("Alpha"), localFile("Beta"), localFile("Gamma")];
      const updates: ResourceUpdate[] = [{
        fileName: "alpha.jar", name: "Alpha", currentVersion: "1.0", newVersion: "1.1",
        projectId: "alpha-project", newVersionId: "alpha-version", enabled: true, source: "modrinth",
      }];
      const confirm = confirmMock.mockResolvedValue(true);
      commandMock.mockImplementation(async (name, args) => {
        if (name === "list_local_resources") return resources;
        if (name === "check_resource_updates") return { updates, curseforgeSkipped: false };
        if (name === "delete_local_resources") {
          const fileNames = args?.fileNames as string[];
          resources = resources.filter((file) => !fileNames.includes(file.fileName));
          return { deleted: fileNames };
        }
        return [];
      });
      await render(createElement(InstanceContent, { versionId: "1.21.1", instanceId: instance.id }));
      await act(async () => rowCheckbox("Alpha").click());
      await act(async () => rowCheckbox("Beta").click());
      const find = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === label)!;
      const tab = (label: string) => [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find((node) => node.textContent === label)!;
      await act(async () => find("检查更新").click());
      expect(container.querySelectorAll(".vx-resource-row")).toHaveLength(1);
      await act(async () => tab("文件").click());

      const remove = batchButton("删除");
      remove.focus();
      await act(async () => remove.click());
      expect(String(confirm.mock.calls[0][0])).toContain("2");
      expect(commandMock).toHaveBeenCalledWith("delete_local_resources", {
        versionId: "1.21.1", instanceId: instance.id, resourceType: "resourcepack",
        fileNames: ["alpha.jar", "beta.jar"],
      });
      expect(commandMock.mock.calls.filter(([name]) => name === "list_local_resources")).toHaveLength(2);
      expect(selectionStatus()?.textContent).toBe("勾选文件以批量操作");
      expect(rowNames()).toEqual(["Gamma"]);
      expect(container.querySelector(".vx-inline-notice")?.textContent).toBe("已从磁盘永久删除 2 个资源。");
      expect(document.activeElement).toBe(headerCheckbox());

      await act(async () => tab("更新").click());
      expect(container.querySelector(".vx-empty h2")?.textContent).toBe("尚未检查更新");
    });

    it("shows a batch delete error and still refreshes the file list", async () => {
      const resources = [localFile("Alpha"), localFile("Beta")];
      confirmMock.mockResolvedValue(true);
      commandMock.mockImplementation(async (name) => {
        if (name === "list_local_resources") return resources;
        if (name === "delete_local_resources") throw { code: "resource.unavailable", params: {} };
        return [];
      });
      await render(createElement(InstanceContent, { versionId: "1.21.1", instanceId: instance.id }));
      await act(async () => headerCheckbox().click());
      expect(selectionStatus()?.textContent).toBe("已选择 2 个文件");

      await act(async () => batchButton("删除").click());
      expect(container.querySelector('[role="alert"]')?.textContent).toContain("无法读取资源目录");
      expect(commandMock.mock.calls.filter(([name]) => name === "list_local_resources")).toHaveLength(2);
      expect(rowNames()).toEqual(["Alpha", "Beta"]);
      expect(selectionStatus()?.textContent).toBe("已选择 2 个文件");
    });
  });
});
