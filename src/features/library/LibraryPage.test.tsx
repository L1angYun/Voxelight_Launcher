// @vitest-environment jsdom
import { act, createElement, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { createLauncherI18n } from "../../i18n";
import { command, defaults, type Bootstrap, type Instance, type ResourceProject } from "../../lib/launcher";
import type { ModpackVersion } from "./types";
import type { LauncherContextValue } from "../../app/controller/types";
import { instanceTabRegistry } from "../../app/registry";
import { LibraryPage } from "./LibraryPage";
import { InstanceDetailPage } from "./InstanceDetailPage";
import { InstanceOverview } from "./InstanceOverview";
import { InstanceContent } from "./InstanceContent";
import { CreateInstanceDialog } from "./CreateInstanceDialog";

function giveBackupSelectBounds(button: HTMLElement) {
  vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
    x: 100, y: 100, width: 240, height: 40, top: 100, bottom: 140, left: 100, right: 340,
    toJSON: () => ({}),
  });
}

const commandMock = vi.mocked(command);
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
    saveConfig: vi.fn(async () => true),
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

async function render(node: React.ReactNode) {
  const i18n = createLauncherI18n("zh-CN", "zh-CN");
  await i18n.initPromise;
  await act(async () => root.render(createElement(I18nextProvider, { i18n }, node)));
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.documentElement.dataset.effects = "full";
  document.documentElement.dataset.reducedMotion = "false";
  mockLauncher = fixture();
  commandMock.mockReset();
  commandMock.mockImplementation(async (name, args) => {
    if (name === "list_instance_backups") return { backups: [], warnings: [], recovery: null };
    if (name === "list_local_resources" || name === "list_worlds" || name === "list_screenshots") return [];
    if (name === "list_loader_versions") return [{ id: "0.16.9", stable: true, recommended: true }];
    if (name === "install_loader") return { versionId: "fabric-loader-0.16.9-1.21.1", loader: "fabric", loaderVersion: "0.16.9" };
    if (name === "create_instance") return { ...instance, id: "created-instance", name: args?.name as string };
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
    ["files", "list_local_resources", "重试", "此分类暂无资源"],
    ["updates", "check_resource_updates", "检查更新", "没有可用更新"],
    ["history", "list_resource_update_history", "更新历史", "暂无更新历史"],
  ])("keeps %s pending and failed requests distinct from a successful empty result", async (view, commandName, action, emptyTitle) => {
    let reject!: (error: Error) => void;
    let requests = 0;
    const normal = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => {
      if (name !== commandName) return normal(name, args);
      requests++;
      return requests === 1 ? new Promise((_resolve, fail) => { reject = fail; }) : [];
    });
    await render(createElement(InstanceContent, { versionId: "1.21.1", instanceId: instance.id }));
    const request = () => [...container.querySelectorAll<HTMLButtonElement>(".vx-toolbar button")].find((button) => button.textContent === action)!.click();
    if (view !== "files") await act(async () => request());
    expect(container.querySelector(".vx-empty")).toBeNull();
    await act(async () => reject(new Error("Fixture request failed")));
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.querySelector(".vx-empty")).toBeNull();
    await act(async () => request());
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector(".vx-empty h2")?.textContent).toBe(emptyTitle);
  });

  it("only recovers an interrupted resource transaction after confirmation", async () => {
    const args = { versionId: "1.21.1", instanceId: instance.id, resourceType: "resourcepack" };
    const pending = { updateId: "fixture-interrupted", name: "资源更新", createdAt: "2026-11-16", status: "rollingBack", canRecover: true, projects: [] };
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValue(true);
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
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
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
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValue(true);
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
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
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
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
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
    expect(card.querySelector(".vx-instance-card__technical")?.getAttribute("title")).toContain("1.21.1");
    expect(card.querySelector(".vx-instance-card__technical")?.textContent).toContain("原版");
    expect(card.textContent).not.toContain("可启动");
    expect(container.querySelector(".vx-library-commandbar")).not.toBeNull();
    expect(container.querySelector(".vx-instance-sheet")).not.toBeNull();
    expect(container.querySelector("[data-create-instance]")).not.toBeNull();
    expect(container.querySelector(".vx-instance-grid")).toBeNull();
    expect(card.querySelector(".vx-lattice-frame")?.getAttribute("data-signature")).toBe("fixture-world");
    expect(card.querySelector(".vx-lattice-frame")?.getAttribute("data-state")).toBe("selected");
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
    expect(commandMock).toHaveBeenCalledWith("install_loader", { loader: "fabric", gameVersion: "1.21.1", loaderVersion: "0.16.9" });
    expect(commandMock).toHaveBeenCalledWith("create_instance", { name: "Fabric 世界", versionId: "fabric-loader-0.16.9-1.21.1" });
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

  it("opens an installed version directory without turning it into an instance", async () => {
    await render(createElement(LibraryPage));
    await act(async () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "版本目录")!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[data-version-id="1.21.1"]')!.click());
    expect(container.textContent).toContain("Minecraft 1.21.1");
    expect(container.querySelector('[data-tab="settings"]')).toBeNull();
    await act(async () => container.querySelector<HTMLElement>('[data-tab="content"]')!.click());
    expect(commandMock).toHaveBeenCalledWith("list_local_resources", { versionId: "1.21.1", instanceId: undefined, resourceType: "resourcepack" });
    await act(async () => container.querySelector<HTMLElement>('[data-tab="worlds"]')!.click());
    expect(commandMock).toHaveBeenCalledWith("list_worlds", { versionId: "1.21.1", instanceId: undefined });
    await act(async () => container.querySelector<HTMLElement>('[data-tab="logs"]')!.click());
    await act(async () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("分析最近错误"))!.click());
    expect(commandMock).toHaveBeenCalledWith("diagnose_instance", { versionId: "1.21.1", instanceId: undefined });
  });

  it("keeps the current version directory visibly selected when its shared frame is owned", async () => {
    mockLauncher.selectedInstance = undefined;
    await render(createElement(LibraryPage));
    await act(async () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "版本目录")!.click());
    const card = container.querySelector<HTMLElement>('[data-version-directory="1.21.1"]')!;
    expect(card.getAttribute("aria-current")).toBeNull();
    expect(card.querySelector(".vx-instance-card__select")?.getAttribute("aria-current")).toBe("true");
    const marker = card.querySelector(':scope > .vx-lattice-frame[data-selected="true"]');
    expect(marker).not.toBeNull();
    expect(marker?.getAttribute("aria-hidden")).toBe("true");
    expect(card.querySelector("svg[data-selected-mark]")).toBeNull();
  });
});
