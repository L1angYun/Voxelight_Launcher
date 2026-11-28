// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { GlassProvider } from "../../visual/glass/GlassSystem";
import { createLauncherI18n } from "../../i18n";
import { command, defaults, type Bootstrap, type ResourceProject } from "../../lib/launcher";
import type { LauncherContextValue } from "../../app/controller/types";
import { DiscoverPage } from "./DiscoverPage";
import { ToastProvider } from "../../components/ui/ToastProvider";
import { openUrl } from "@tauri-apps/plugin-opener";
import { MOTION } from "../../design/motion";
import type { ResourceContext, ResourceProjectDetails, ResourceTargetPlan } from "./types";

const commandMock = vi.mocked(command);
interface SearchPage { hits: ResourceProject[]; totalHits?: number; nextOffset?: number }
const searchMock = vi.fn<(name: string, args: Record<string, unknown>) => Promise<SearchPage>>();
function searchPage(hits: ResourceProject[], totalHits?: number, nextOffset?: number): SearchPage { return { hits, totalHits, nextOffset }; }
let mockLauncher: LauncherContextValue;
let root: Root;
let container: HTMLDivElement;
let resourcePlan: ResourceTargetPlan;
const fabricVersion = "fabric-loader-0.16.9-1.21.1";
const forgeVersion = "1.20.1-forge-47.2.0";
const neoforgeVersion = "neoforge-21.1.77";
const quiltVersion = "quilt-loader-0.27.0-1.21.1";
let instanceContexts: Record<string, { versionId: string; context: ResourceContext }>;
const profileContexts: Record<string, ResourceContext> = {
  "1.21.1": { gameVersion: "1.21.1", loader: null },
  [fabricVersion]: { gameVersion: "1.21.1", loader: "fabric" },
  [forgeVersion]: { gameVersion: "1.20.1", loader: "forge" },
  [neoforgeVersion]: { gameVersion: "1.21.1", loader: "neoforge" },
  [quiltVersion]: { gameVersion: "1.21.1", loader: "quilt" },
};
function plan(compatible = true): ResourceTargetPlan {
  return { projectId: "sodium", title: "Sodium", projectType: "mod", manifestUnavailable: false, targets: [{ kind: "instance", instanceId: "fixture-world", versionId: "1.21.1", name: "合成测试世界", gameVersion: "1.21.1", loader: null, compatible, reason: compatible ? undefined : "vanilla" }], suggestion: { loader: "fabric", gameVersion: "1.21.1", name: "Sodium", matrix: [{ loader: "fabric", gameVersions: ["1.21.1", "1.20.1"] }, { loader: "neoforge", gameVersions: ["1.21.1"] }] }, unsupportedReason: undefined };
}
async function installCard() {
  await act(async () => container.querySelector<HTMLButtonElement>('[data-project-id="sodium"] button[aria-label*="安装"]')!.click());
}
function dialogButton(text: string) {
  return [...container.querySelectorAll<HTMLButtonElement>(".vx-install-target button")].find(button => button.textContent === text)!;
}
const manualDownload = { reason: "distributionForbidden" as const, url: "https://www.curseforge.com/minecraft/mc-mods/sodium/files/8675309",
  displayName: "Sodium 0.6.0", fileName: "sodium-fabric-0.6.0.jar" };
async function chooseCurseForge() {
  await act(async () => container.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="来源"]')!.click());
  await act(async () => document.querySelector<HTMLElement>('[role="option"][data-value="curseforge"]')!.click());
}

vi.mock("../../lib/launcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/launcher")>()),
  command: vi.fn(),
}));
vi.mock("../../app/controller/LauncherProvider", () => ({
  useLauncher: () => mockLauncher,
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));
vi.mock("../../app/AppearanceProvider", () => ({
  useAppearance: () => ({ effects: "lite", reducedMotion: true, reducedTransparency: false, highContrast: false }),
}));
vi.mock("../../visual/overture/OvertureProvider", () => ({
  useOverture: () => ({ current: null, playing: false, reducedMotion: false, soundEnabled: false, play: vi.fn(), dismiss: vi.fn() }),
}));

const project: ResourceProject = {
  project_id: "sodium",
  slug: "sodium",
  title: "Sodium",
  description: "Rendering optimization",
  icon_url: null,
  downloads: 1200,
  author: "Author",
  project_type: "mod",
  versions: ["1.21.1"],
  external_url: undefined,
};
const details: ResourceProjectDetails = {
  project,
  versions: [{ id: "v1", name: "1.0", versionNumber: "1.0", datePublished: "2026-01-01", gameVersions: ["1.21.1"], loaders: ["fabric"], compatible: true }],
  dependencies: [{ projectId: "dep", kind: "unknown", name: null }],
};

function fixture(): LauncherContextValue {
  const data: Bootstrap = {
    config: { ...defaults },
    accounts: [],
    instances: [{
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
    }],
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
    selectedInstance: data.instances[0],
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

async function render(showDiscover = true, language = "zh-CN") {
  const i18n = createLauncherI18n(language, language);
  await i18n.initPromise;
  await act(async () => root.render(createElement(I18nextProvider, { i18n },
    createElement(GlassProvider, { effects: "lite", reducedMotion: true }, createElement(ToastProvider, null, showDiscover ? createElement(DiscoverPage) : createElement("div"))))));
}

async function submitSearch(query: string) {
  const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, query);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => container.querySelector<HTMLFormElement>('form[role="search"]')!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.getAttribute("role") === "combobox" ? new DOMRect(24, 200, 260, 44) : new DOMRect();
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mockLauncher = fixture();
  resourcePlan = plan();
  instanceContexts = {};
  project.project_type = "mod";
  commandMock.mockReset();
  commandMock.mockImplementation(async (name, args) => {
    if (name === "search_modrinth" || name === "search_curseforge") {
      return searchMock(name, (args ?? {}) as Record<string, unknown>);
    }
    if (name === "get_modrinth_project_details" || name === "get_curseforge_project_details") return details;
    if (name === "get_resource_context") {
      const versionId = typeof args?.versionId === "string" ? args.versionId : "";
      const instanceId = typeof args?.instanceId === "string" ? args.instanceId : "";
      const entry = instanceContexts[instanceId];
      if (entry && entry.versionId === versionId) return entry.context;
      const resolved = profileContexts[versionId];
      if (resolved) return resolved;
      throw { code: "resource.versionMissing" };
    }
    if (name === "resolve_resource_targets") return resourcePlan;
    if (name === "list_loader_versions") return [{ id: "0.16.9", stable: true, recommended: true }];
    if (name === "list_download_tasks") return { revision: 0, tasks: [] };
    if (name === "reserve_resource_task") return "resource-task";
    if (name === "create_instance_for_resource") return { instance: { ...mockLauncher.data.instances[0], id: "new", versionId: fabricVersion, name: "Sodium" }, install: {} };
    if (name === "search_curseforge") return { hits: [project] };
    if (name === "install_resource" || name === "install_curseforge_resource") return { name: "Sodium", fileName: "sodium.jar", path: "fixture/sodium.jar" };
    if (name === "list_modpack_versions") return [];
    return null;
  });
  searchMock.mockReset();
  searchMock.mockResolvedValue(searchPage([project], 1));
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

describe("DiscoverPage", () => {

  it.each(["modrinth", "curseforge"] as const)("pins the selected historical %s file in both IPC calls", async (source) => {
    const dispatched = commandMock.getMockImplementation()!;
    const historical = source === "modrinth" ? "older-release" : "8675309";
    const pinned = source === "modrinth" ? { resourceVersionId: historical } : { fileId: Number(historical) };
    const chosen = { ...details.versions[0], id: historical, name: "Historical version" };
    const incompatible = { ...chosen, id: source === "modrinth" ? "incompatible" : "8675310", name: "Incompatible version", compatible: false };
    commandMock.mockImplementation(async (name, args) => {
      if (name === "get_modrinth_project_details" || name === "get_curseforge_project_details") {
        return { ...details, versions: [chosen, incompatible] };
      }
      return dispatched(name, args);
    });

    await render();
    if (source === "curseforge") {
      await act(async () => container.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="来源"]')!.click());
      await act(async () => document.querySelector<HTMLElement>('[role="option"][data-value="curseforge"]')!.click());
    }
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent?.includes("查看详情"))!.click());
    const rows = [...container.querySelectorAll<HTMLElement>(".vx-project-details .vx-resource-row")];
    const rejected = rows.find(row => row.textContent?.includes("Incompatible version"))?.querySelector("button");
    const accepted = rows.find(row => row.textContent?.includes("Historical version"))?.querySelector("button");
    expect(rejected?.disabled).toBe(true);
    expect(accepted?.disabled).toBe(false);
    await act(async () => accepted!.click());

    expect(commandMock).toHaveBeenCalledWith("reserve_resource_task", { request: {
      source, projectId: "sodium", resourceType: "mod",
      target: { mode: "existing", versionId: "1.21.1", instanceId: "fixture-world", ...pinned },
    } });
    expect(commandMock).toHaveBeenCalledWith(source === "modrinth" ? "install_resource" : "install_curseforge_resource", {
      projectId: "sodium", versionId: "1.21.1", instanceId: "fixture-world", resourceType: "mod", taskId: "resource-task", ...pinned,
    });
    if (source === "modrinth") {
      expect(commandMock).toHaveBeenCalledWith("resolve_resource_targets", {
        source, projectId: "sodium", resourceType: "mod", ...pinned,
      });
    }
  });



  it("uses the selected CurseForge file when creating a compatible new instance", async () => {
    mockLauncher.selectedVersionId = "";
    mockLauncher.selectedInstance = undefined;
    const cf = { ...project, project_id: "90210" };
    const dispatch = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => {
      if (name === "search_curseforge") return { hits: [cf] };
      if (name === "get_curseforge_project_details") return { ...details, project: cf,
        versions: [{ ...details.versions[0], id: "8675309", compatible: false, loaders: ["quilt"], gameVersions: ["1.20.1"] }] };
      if (name === "resolve_resource_targets" && args?.fileId === 8675309) return { ...plan(false), projectId: "90210",
        suggestion: { loader: "quilt", gameVersion: "1.20.1", name: "Sodium", matrix: [{ loader: "quilt", gameVersions: ["1.20.1"] }] } };
      if (name === "list_loader_versions") return [{ id: "0.26.0", stable: true, recommended: true }];
      return dispatch(name, args);
    });
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="来源"]')!.click());
    await act(async () => document.querySelector<HTMLElement>('[role="option"][data-value="curseforge"]')!.click());
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent?.includes("查看详情"))!.click());
    await act(async () => container.querySelector<HTMLButtonElement>(".vx-project-details .vx-resource-row button")!.click());
    expect(commandMock).toHaveBeenCalledWith("resolve_resource_targets", { source: "curseforge", projectId: "90210", resourceType: "mod", fileId: 8675309 });
    const dialog = container.querySelector<HTMLDialogElement>(".vx-install-target")!;
    expect(dialog.querySelector('[aria-label="加载器"]')?.textContent).toBe("Quilt");
    expect(dialog.querySelector('[aria-label="游戏版本"]')?.textContent).toContain("1.20.1");
    await act(async () => dialogButton("创建并安装").click());
    const exact = { gameVersion: "1.20.1", loader: "quilt", loaderVersion: "0.26.0", name: "Sodium", fileId: 8675309 };
    expect(commandMock).toHaveBeenCalledWith("reserve_resource_task", { request: {
      source: "curseforge", projectId: "90210", resourceType: "mod", target: { mode: "create", ...exact },
    } });
    expect(commandMock).toHaveBeenCalledWith("create_instance_for_resource", {
      source: "curseforge", projectId: "90210", resourceType: "mod", taskId: "resource-task", ...exact,
    });
    expect(commandMock.mock.calls.some(([name]) => name === "install_curseforge_resource")).toBe(false);
  });

  it("retains a historical file through new-instance planning, reserve, and install", async () => {
    mockLauncher.selectedVersionId = "";
    mockLauncher.selectedInstance = undefined;
    const pinnedSuggestion = { loader: "quilt" as const, gameVersion: "1.20.1", name: "Sodium",
      matrix: [{ loader: "quilt" as const, gameVersions: ["1.20.1"] }] };
    const dispatch = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => {
      if (name === "get_modrinth_project_details") return {
        ...details, versions: [{ ...details.versions[0], id: "older", compatible: false,
          loaders: ["quilt"], gameVersions: ["1.20.1"] }],
      };
      if (name === "list_loader_versions") return [{ id: "0.26.0", stable: true, recommended: true }];
      if (name === "resolve_resource_targets" && args?.resourceVersionId === "older") {
        return { ...plan(false), suggestion: pinnedSuggestion };
      }
      return dispatch(name, args);
    });
    await render();
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent?.includes("查看详情"))!.click());
    await act(async () => container.querySelector<HTMLButtonElement>(".vx-project-details .vx-resource-row button")!.click());

    const dialog = container.querySelector<HTMLDialogElement>(".vx-install-target")!;
    expect(dialog.open).toBe(true);
    expect(dialog.querySelector('[aria-label="加载器"]')?.textContent).toBe("Quilt");
    expect(dialog.querySelector('[aria-label="游戏版本"]')?.textContent).toContain("1.20.1");
    expect(commandMock).toHaveBeenCalledWith("resolve_resource_targets", {
      source: "modrinth", projectId: "sodium", resourceType: "mod", resourceVersionId: "older",
    });

    await act(async () => dialogButton("创建并安装").click());
    expect(commandMock).toHaveBeenCalledWith("reserve_resource_task", { request: {
      source: "modrinth", projectId: "sodium", resourceType: "mod",
      target: expect.objectContaining({ mode: "create", loader: "quilt", loaderVersion: "0.26.0", gameVersion: "1.20.1", resourceVersionId: "older" }),
    } });
    expect(commandMock).toHaveBeenCalledWith("create_instance_for_resource", expect.objectContaining({
      source: "modrinth", projectId: "sodium", resourceType: "mod", taskId: "resource-task",
      loader: "quilt", loaderVersion: "0.26.0", gameVersion: "1.20.1", resourceVersionId: "older",
    }));
  });

  it("opens a Modrinth target picker for the historical version without a selected instance or game version", async () => {
    mockLauncher.selectedVersionId = "";
    mockLauncher.selectedInstance = undefined;
    const dispatched = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => {
      if (name === "get_modrinth_project_details") {
        return { ...details, versions: [{ ...details.versions[0], id: "older", compatible: false }] };
      }
      return dispatched(name, args);
    });
    await render();
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent?.includes("查看详情"))!.click());
    const install = container.querySelector<HTMLButtonElement>(".vx-project-details .vx-resource-row button");
    expect(install?.disabled).toBe(false);
    await act(async () => install!.click());
    expect(commandMock).toHaveBeenCalledWith("resolve_resource_targets", {
      source: "modrinth", projectId: "sodium", resourceType: "mod", resourceVersionId: "older",
    });
    expect(commandMock).not.toHaveBeenCalledWith("reserve_resource_task", expect.anything());
    expect(container.querySelector<HTMLDialogElement>(".vx-install-target")?.open).toBe(true);
  });


  const curseforgePackRelease = { id: "123456", name: "Example release", versionNumber: "1.0", gameVersions: ["1.21.1"], loaders: ["fabric"], datePublished: "2026-01-01" };
  async function openCurseforgeModpackDialog(pack: ResourceProject) {
    const dispatch = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => {
      if (name === "search_curseforge") return { hits: [pack] };
      return dispatch(name, args);
    });
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="来源"]')!.click());
    await act(async () => document.querySelector<HTMLElement>('[role="option"][data-value="curseforge"]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('#discover-type-modpack')!.click());
    const card = container.querySelector(`[data-project-id="${pack.project_id}"]`)!;
    await act(async () => (card.querySelector('.vx-project-card__actions button:first-child') as HTMLButtonElement).click());
    return container.querySelector<HTMLDialogElement>('.vx-create-dialog[open]')!;
  }

  it.each(["card", "details"] as const)("installs a CurseForge modpack online from %s", async (entry) => {
    const pack = { ...project, project_type: "modpack", project_id: "90210", title: "Example CurseForge pack" };
    const dispatch = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => {
      if (name === "search_curseforge") return { hits: [pack] };
      if (name === "get_curseforge_project_details") return { ...details, project: pack, versions: [curseforgePackRelease], dependencies: [] };
      if (name === "list_curseforge_modpack_versions") return [curseforgePackRelease];
      if (name === "install_curseforge_modpack") return { instance: mockLauncher.data.instances[0], warnings: [] };
      return dispatch(name, args);
    });
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="来源"]')!.click());
    await act(async () => document.querySelector<HTMLElement>('[role="option"][data-value="curseforge"]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('#discover-type-modpack')!.click());
    const card = container.querySelector('[data-project-id="90210"]')!;
    if (entry === "details") {
      await act(async () => (card.querySelector('.vx-project-card__actions button:last-child') as HTMLButtonElement).click());
      const drawer = container.querySelector('.vx-project-details')!;
      const action = [...drawer.querySelectorAll<HTMLButtonElement>('.vx-dialog__footer button')].find(button => button.textContent === "安装最新兼容版")!;
      await act(async () => action.click());
    } else {
      await act(async () => (card.querySelector('.vx-project-card__actions button:first-child') as HTMLButtonElement).click());
    }
    expect(commandMock).toHaveBeenCalledWith("list_curseforge_modpack_versions", { projectId: "90210" });
    const dialog = container.querySelector<HTMLDialogElement>('.vx-create-dialog[open]')!;
    expect(dialog.textContent).toContain("只列出正式版。整合包里有作者不允许其他应用下载的文件时，安装会停止并列出这些文件。");
    const install = [...dialog.querySelectorAll<HTMLButtonElement>('.vx-dialog__footer button')].find(button => button.textContent === "安装整合包")!;
    await act(async () => install.click());
    expect(commandMock).toHaveBeenCalledWith("install_curseforge_modpack", {
      projectId: "90210",
      fileId: 123456,
      name: "Example CurseForge pack",
      includeOptional: false,
    });
    expect(commandMock.mock.calls.some(([name]) => name === "list_modpack_versions" || name === "install_modrinth_modpack")).toBe(false);
  });

  it("keeps the CurseForge local ZIP import on a secondary button", async () => {
    const pack = { ...project, project_type: "modpack", project_id: "90210", title: "Example CurseForge pack" };
    const localPath = "C:\\SyntheticFixture\\CurseForgePack.zip";
    const dispatch = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => {
      if (name === "list_curseforge_modpack_versions") return [curseforgePackRelease];
      if (name === "choose_launcher_path") return [localPath];
      if (name === "import_modpack") return { instance: mockLauncher.data.instances[0], warnings: [] };
      return dispatch(name, args);
    });
    const dialog = await openCurseforgeModpackDialog(pack);
    const importZip = [...dialog.querySelectorAll<HTMLButtonElement>('.vx-dialog__footer button')].find(button => button.textContent === "改为导入 CurseForge ZIP")!;
    expect(importZip).toBeDefined();
    expect(importZip.classList.contains("vx-button--secondary")).toBe(true);
    // The visible optional-files choice applies to the ZIP import too, unticked and ticked.
    const imports = () => commandMock.mock.calls.filter(([name]) => name === "import_modpack").map(([, args]) => args as Record<string, unknown>);
    await act(async () => importZip.click());
    expect(commandMock).toHaveBeenCalledWith("choose_launcher_path", expect.objectContaining({ purpose: "packRead" }));
    expect(imports()[0]).toEqual(expect.objectContaining({ path: localPath, includeOptional: false }));
    const again = await openCurseforgeModpackDialog(pack);
    await act(async () => again.querySelector<HTMLInputElement>('.vx-check-row input[type="checkbox"]')!.click());
    const importAgain = [...again.querySelectorAll<HTMLButtonElement>('.vx-dialog__footer button')].find(button => button.textContent === "改为导入 CurseForge ZIP")!;
    await act(async () => importAgain.click());
    expect(imports()[1]).toEqual(expect.objectContaining({ path: localPath, includeOptional: true }));
    expect(commandMock.mock.calls.some(([name]) => name === "install_curseforge_modpack" || name === "install_modrinth_modpack")).toBe(false);
  });

  it("never sends a key typed for a Library-style import from the modpack dialog", async () => {
    // Discover keeps one dialog: "create instance" opens it without a project
    // (with the key field), a modpack opens it with one (without the field).
    const { CreateInstanceDialog } = await import("../library/CreateInstanceDialog");
    const pack = { ...project, project_type: "modpack", project_id: "90213", title: "Key pack" };
    const localPath = "C:\\SyntheticFixture\\KeyPack.zip";
    const dispatch = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => {
      if (name === "list_curseforge_modpack_versions") return [curseforgePackRelease];
      if (name === "choose_launcher_path") return [localPath];
      if (name === "import_modpack") return { instance: mockLauncher.data.instances[0], warnings: [] };
      return dispatch(name, args);
    });
    const i18n = createLauncherI18n("zh-CN", "zh-CN");
    await i18n.initPromise;
    const show = (props: Record<string, unknown>) => act(async () => root.render(createElement(I18nextProvider, { i18n },
      createElement(GlassProvider, { effects: "lite", reducedMotion: true }, createElement(ToastProvider, null,
        createElement(CreateInstanceDialog, { open: true, onOpenChange: () => {}, onInstalled: () => {}, ...props }))))));
    await show({ initialMode: "import" });
    const key = document.querySelector<HTMLInputElement>('.vx-create-dialog[open] input[type="password"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(key, "typed-key-fixture");
      key.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const footer = () => [...document.querySelectorAll<HTMLButtonElement>('.vx-create-dialog[open] .vx-dialog__footer button')];
    await act(async () => footer().find(button => button.textContent === "导入整合包")!.click());
    const imports = () => commandMock.mock.calls.filter(([name]) => name === "import_modpack").map(([, args]) => args as Record<string, unknown>);
    expect(imports()[0].curseforgeApiKey).toBe("typed-key-fixture");
    await show({ project: pack, source: "curseforge" });
    await act(async () => footer().find(button => button.textContent === "改为导入 CurseForge ZIP")!.click());
    expect(imports()).toHaveLength(2);
    expect(imports()[1].curseforgeApiKey).toBeUndefined();
  });

  it.each(["pack-latest", "0", "01", "4294967296"])("refuses an invalid CurseForge file id %s", async (id) => {
    const pack = { ...project, project_type: "modpack", project_id: "90212", title: "Invalid version pack" };
    const dispatch = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => {
      if (name === "list_curseforge_modpack_versions") return [{ ...curseforgePackRelease, id }];
      return dispatch(name, args);
    });
    const dialog = await openCurseforgeModpackDialog(pack);
    const version = dialog.querySelector<HTMLButtonElement>('[role="combobox"][id$="-create-pack-version"]')!;
    expect(version.disabled).toBe(false);
    expect(version.textContent).toContain("Example release");
    const install = [...dialog.querySelectorAll<HTMLButtonElement>('.vx-dialog__footer button')].find(button => button.textContent === "安装整合包")!;
    expect(install.disabled).toBe(true);
    await act(async () => {
      install.click();
      dialog.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(commandMock.mock.calls.some(([name]) => name === "install_curseforge_modpack")).toBe(false);
  });

  it.each([[null, false], [["C:\SyntheticFixture\WrongPack.mrpack"], true]] as const)("keeps the CurseForge ZIP dialogue open for %s", async (response, wrongExtension) => {
    const pack = { ...project, project_type: "modpack", project_id: "90211", title: "Example local pack" };
    const dispatch = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => {
      if (name === "list_curseforge_modpack_versions") return [curseforgePackRelease];
      if (name === "choose_launcher_path") return response;
      return dispatch(name, args);
    });
    const dialog = await openCurseforgeModpackDialog(pack);
    const importZip = [...dialog.querySelectorAll<HTMLButtonElement>('.vx-dialog__footer button')].find(button => button.textContent === "改为导入 CurseForge ZIP")!;
    await act(async () => importZip.click());
    expect(container.querySelector('.vx-create-dialog[open]')).not.toBeNull();
    expect(commandMock.mock.calls.some(([name]) => name === "list_modpack_versions" || name === "import_modpack" || name === "install_modrinth_modpack")).toBe(false);
    if (wrongExtension) expect(container.querySelector('.vx-create-dialog [role="alert"]')?.textContent).toContain('请选择 CurseForge 整合包 ZIP 文件');
    else expect(container.querySelector('.vx-create-dialog [role="alert"]')).toBeNull();
  });

  it("keeps the Modrinth search-to-online-install command scoped to Modrinth packs", async () => {
    const pack = { ...project, project_type: "modpack", project_id: "pack-fixture", title: "Example Modrinth pack" };
    searchMock.mockResolvedValue(searchPage([pack], 1));
    const dispatch = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => {
      if (name === "list_modpack_versions") return [{ id: "online-v1", name: "Version 1", versionNumber: "1.0", gameVersions: ["1.21.1"], loaders: ["fabric"], datePublished: "2026-01-01" }];
      if (name === "install_modrinth_modpack") return { instance: mockLauncher.data.instances[0], warnings: [] };
      if (name === "list_versions") return mockLauncher.manifest;
      return dispatch(name, args);
    });
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('#discover-type-modpack')!.click());
    const card = container.querySelector('[data-project-id="pack-fixture"]')!;
    await act(async () => (card.querySelector('.vx-project-card__actions button:first-child') as HTMLButtonElement).click());
    expect(searchMock).toHaveBeenLastCalledWith("search_modrinth", expect.objectContaining({ query: "", offset: 0, sort: "relevance" }));
    expect(commandMock).toHaveBeenCalledWith("list_modpack_versions", { projectId: "pack-fixture" });
    await act(async () => container.querySelector<HTMLButtonElement>('.vx-create-dialog .vx-dialog__footer button')!.click());
    expect(commandMock).toHaveBeenCalledWith("install_modrinth_modpack", expect.objectContaining({ projectId: "pack-fixture", modpackVersionId: "online-v1" }));
    expect(commandMock.mock.calls.some(([name]) => name === "import_modpack")).toBe(false);
  });

  it("introduces discovery with its localized page description and matching flat destination/source controls", async () => {
    await render();
    expect(container.querySelector(".vx-page-header__text p")?.textContent).toBe("查找与当前实例兼容的内容。");
    for (const selector of [".vx-discover-target", ".vx-discover-source"]) {
      expect(container.querySelector(`${selector} .vx-select`)?.classList.contains("vx-select--flat")).toBe(true);
      expect(container.querySelector(`${selector} .vx-select__surface`)).not.toBeNull();
      expect(container.querySelector(`${selector} .vx-select--embedded`)).toBeNull();
    }
  });
  it("clears cards after a new search fails and lets the same query retry restore usable results", async () => {
    await render();
    await submitSearch("sodium");
    expect(searchMock).toHaveBeenLastCalledWith("search_modrinth", expect.objectContaining({ query: "sodium", offset: 0 }));
    expect(container.querySelector('[data-project-id="sodium"]')).not.toBeNull();

    let rejectSearch!: (cause: Error) => void;
    searchMock.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSearch = reject; }));
    await submitSearch("iris");
    expect(searchMock).toHaveBeenLastCalledWith("search_modrinth", expect.objectContaining({ query: "iris", offset: 0 }));
    expect(container.querySelector('.vx-project-grid')?.hasAttribute("inert")).toBe(true);
    await act(async () => rejectSearch(new Error("offline")));
    expect(container.querySelectorAll('.vx-project-grid [data-project-id]')).toHaveLength(0);
    expect(container.querySelector('.vx-project-grid')?.getAttribute("aria-busy")).toBe("false");
    expect(container.querySelector('.vx-project-grid')?.hasAttribute("inert")).toBe(false);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();

    let resolveRetry!: (value: SearchPage) => void;
    searchMock.mockImplementationOnce(() => new Promise((resolve) => { resolveRetry = resolve; }));
    await submitSearch("iris");
    expect(searchMock).toHaveBeenCalledTimes(4);
    expect(searchMock).toHaveBeenNthCalledWith(4, "search_modrinth", expect.objectContaining({ query: "iris", offset: 0 }));
    expect(container.querySelector('.vx-project-grid')?.getAttribute("aria-busy")).toBe("true");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => resolveRetry(searchPage([{ ...project, project_id: "iris", title: "Iris" }])));
    const freshCard = container.querySelector('[data-project-id="iris"]')!;
    expect(freshCard).not.toBeNull();
    expect(container.querySelector('.vx-project-grid')?.hasAttribute("inert")).toBe(false);
    expect(container.querySelector('.vx-project-grid')?.getAttribute("aria-busy")).toBe("false");
    const install = freshCard.querySelector<HTMLButtonElement>('button[aria-label*="安装"]')!;
    expect(install.disabled).toBe(false);
    await act(async () => install.click());
    expect(commandMock).toHaveBeenCalledWith("install_resource", { projectId: "iris", versionId: "1.21.1", instanceId: "fixture-world", resourceType: "mod", taskId: "resource-task" });
  });

  it("keeps same-source results visible but inert until the new type finishes loading", async () => {
    await render();
    let resolveSearch!: (value: SearchPage) => void;
    searchMock.mockImplementationOnce(() => new Promise((resolve) => { resolveSearch = resolve; }));
    const previousCard = container.querySelector('[data-project-id="sodium"]')!;
    const install = previousCard.querySelector<HTMLButtonElement>('button[aria-label*="安装"]')!;
    await act(async () => container.querySelector<HTMLButtonElement>('#discover-type-resourcepack')!.click());
    expect(previousCard.isConnected).toBe(true);
    expect(container.querySelector('.vx-project-grid')?.hasAttribute("inert")).toBe(true);
    expect(container.querySelector('.vx-project-grid')?.getAttribute("aria-busy")).toBe("true");
    await act(async () => install.click());
    expect(commandMock).not.toHaveBeenCalledWith("install_resource", expect.anything());
    await act(async () => resolveSearch(searchPage([{ ...project, project_id: "fresh-pack", title: "Fresh pack", project_type: "resourcepack" }])));
    expect(container.querySelector('[data-project-id="fresh-pack"]')).not.toBeNull();
    expect(container.querySelector('.vx-project-grid')?.hasAttribute("inert")).toBe(false);
  });

  it("hides old results immediately when a different source is requested", async () => {
    await render();
    commandMock.mockImplementation(async (name) => name === "search_curseforge" ? await new Promise(() => {}) : null);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="来源"]')!.click());
    await act(async () => document.querySelector<HTMLElement>('[role="option"][data-value="curseforge"]')!.click());
    expect(container.querySelector('[data-project-id="sodium"]')).toBeNull();
    expect(container.querySelector('.vx-project-grid')?.getAttribute("aria-busy")).toBe("true");
  });

  it("keeps the complete drawer content mounted through its native close transition", async () => {
    await render();
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("查看详情"))!.click());
    const drawer = container.querySelector<HTMLDialogElement>(".vx-project-details")!;
    expect(drawer.open).toBe(true);
    expect(drawer.textContent).toContain("1.0");
    expect(drawer.textContent).toContain("未知关系");
    await act(async () => drawer.querySelector<HTMLButtonElement>("[data-dialog-close]")!.click());
    expect(drawer.isConnected).toBe(true);
    expect(drawer.open).toBe(false);
    expect(drawer.textContent).toContain("Sodium");
    expect(drawer.textContent).toContain("1.0");
    expect(drawer.textContent).toContain("未知关系");
  });

  it("loads real compatible versions and keeps unknown dependency types distinct", async () => {
    await render();
    await act(async () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("查看详情"))!.click());
    expect(commandMock).toHaveBeenCalledWith("get_modrinth_project_details", { projectId: "sodium", versionId: "1.21.1", instanceId: "fixture-world", resourceType: "mod" });
    expect(container.textContent).toContain("1.0");
    expect(container.textContent).toContain("未知关系");
    expect([...container.querySelectorAll(".vx-dependency-kind")].map(node => node.textContent)).toEqual(["未知关系"]);
  });

  it("switches source without losing the selected instance", async () => {
    await render();
    const source = container.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="来源"]')!;
    await act(async () => source.click());
    await act(async () => document.querySelector<HTMLElement>('[role="option"][data-value="curseforge"]')!.click());
    expect(commandMock).toHaveBeenCalledWith("search_curseforge", { query: "", resourceType: "mod", gameVersion: "1.21.1", loader: undefined, offset: 0, limit: 24, sort: "downloads" });
    const target = container.querySelector('[role="combobox"][aria-label="安装到"]');
    expect(target?.textContent).toContain("合成测试世界");
  });

  it("installs the selected project into the selected instance", async () => {
    await render();
    const projectCard = container.querySelector('[data-project-id="sodium"]')!;
    expect(projectCard.querySelector('button[aria-label*="合成测试世界"]')).not.toBeNull();
    await act(async () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("安装"))!.click());
    expect(commandMock).toHaveBeenCalledWith("install_resource", { projectId: "sodium", versionId: "1.21.1", instanceId: "fixture-world", resourceType: "mod", taskId: "resource-task" });
    expect(container.textContent).toContain("资源已安装");
  });

  it("offers target selection without a selected version", async () => {
    mockLauncher.selectedVersionId = "";
    mockLauncher.selectedInstance = undefined;
    await render();
    await act(async () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("安装"))!.click());
    expect(commandMock).not.toHaveBeenCalledWith("install_resource", expect.anything());
    expect(container.querySelector<HTMLDialogElement>(".vx-install-target")?.open).toBe(true);
  });

  it("routes modpacks through the shared create flow instead of resource install", async () => {
    project.project_type = "modpack";
    searchMock.mockResolvedValue(searchPage([project], 1));
    await render();
    await act(async () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "整合包")!.click());
    await act(async () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("安装"))!.click());
    expect(commandMock).not.toHaveBeenCalledWith("install_resource", expect.anything());
    expect(container.querySelector("dialog")!.open).toBe(true);
  });

  it("shows an error instead of fabricated results when search fails", async () => {
    searchMock.mockRejectedValue(new Error("offline"));
    await render();
    expect(container.textContent).toContain("发生未预期错误");
    expect(container.textContent).not.toContain("没有找到相关资源");
  });

  it("shows how many results are visible, the source total, and the active filters", async () => {
    mockLauncher.selectedVersionId = fabricVersion;
    mockLauncher.selectedInstance!.loader = "fabric";
    searchMock.mockResolvedValue(searchPage([project, { ...project, project_id: "iris", title: "Iris" }], 57));
    await render(true, "en-US");
    const summary = container.querySelector(".vx-discover-results-summary")!;
    expect(summary.textContent).toContain("Showing 2 of 57");
    expect(summary.textContent).toContain("Type: Mod");
    expect(summary.textContent).toContain("Version: 1.21.1");
    expect(summary.textContent).toContain("Loader: Fabric");
    expect(summary.textContent).toContain("Sort: Relevance");
  });

  it("renders only the target compatibility badge instead of the full version snapshot", async () => {
    instanceContexts["fixture-world"] = { versionId: "1.21.1", context: { gameVersion: "1.21.1", loader: "fabric" } };
    searchMock.mockResolvedValue(searchPage([{ ...project, versions: ["1.21.1", "1.20.1", "1.19.4", "1.18.2"] }]));
    await render(true, "en-US");
    const card = container.querySelector('[data-project-id="sodium"]')!;
    const badge = card.querySelector('.vx-project-card__compatibility')!;
    expect(badge.textContent).toContain("Works with 1.21.1");
    expect(badge.getAttribute("data-compatible")).toBe("true");
    expect(badge.querySelector(".lucide-circle-check")).not.toBeNull();
    expect(card.textContent).not.toContain("1.20.1");
    expect(card.querySelector(".vx-project-card__versions")).toBeNull();
    expect(card.querySelector(".lucide-arrow-down-to-line")).not.toBeNull();
    expect(card.querySelector(".vx-project-card__details .lucide-panel-right")).not.toBeNull();
  });

  it("names the missing target version when a project has no compatible files", async () => {
    instanceContexts["fixture-world"] = { versionId: "1.21.1", context: { gameVersion: "1.21.1", loader: "fabric" } };
    searchMock.mockResolvedValue(searchPage([{ ...project, versions: ["1.20.1", "1.19.4"] }]));
    await render(true, "en-US");
    const badge = container.querySelector('[data-project-id="sodium"] .vx-project-card__compatibility')!;
    expect(badge.textContent).toContain("No 1.21.1 version");
    expect(badge.getAttribute("data-compatible")).toBe("false");
    expect(badge.querySelector("svg")).toBeNull();
  });

  it("does not show the success check on mods when the target is vanilla", async () => {
    // The default fixture world is vanilla 1.21.1, which the install dialog lists as incompatible for mods.
    searchMock.mockResolvedValue(searchPage([{ ...project, versions: ["1.21.1"] }]));
    await render(true, "en-US");
    const badge = container.querySelector('[data-project-id="sodium"] .vx-project-card__compatibility')!;
    expect(badge.textContent).toBe("Vanilla cannot load mods");
    expect(badge.getAttribute("data-compatible")).toBe("false");
    expect(badge.querySelector(".lucide-circle-check")).toBeNull();
  });

  it("says only what is shown when the source gives no total", async () => {
    searchMock.mockResolvedValue(searchPage([project]));
    await render(true, "en-US");
    const summary = container.querySelector(".vx-discover-results-summary")!;
    expect(summary.textContent).toContain("Showing 1");
    expect(summary.textContent).not.toContain(" of ");
  });

  it("appends the next page, focuses the first new card, and then hides load more", async () => {
    const iris = { ...project, project_id: "iris", title: "Iris" };
    searchMock.mockResolvedValueOnce(searchPage([project], 2, 1)).mockResolvedValueOnce(searchPage([iris], 2, 2));
    await render(true, "en-US");
    const loadMore = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Load more")!;
    expect(loadMore).toBeDefined();
    expect(loadMore.disabled).toBe(false);
    await act(async () => loadMore.click());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelectorAll(".vx-project-card")).toHaveLength(2);
    const focused = document.activeElement as HTMLElement;
    expect(focused).toBe(container.querySelector('[data-project-id="iris"]'));
    const title = focused.querySelector("h3")!;
    expect(focused.getAttribute("aria-labelledby")).toBe(title.id);
    expect(title.textContent).toBe("Iris");
    expect(container.querySelector(".vx-discover-count")?.textContent).toContain("Showing 2 of 2");
    expect(container.querySelector(".vx-discover-load-more button")).toBeNull();
    expect(searchMock).toHaveBeenLastCalledWith("search_modrinth", expect.objectContaining({ offset: 1, limit: 24 }));
  });

  it("drops a repeated project from the next page and focuses the first card that was really added", async () => {
    const iris = { ...project, project_id: "iris", title: "Iris" };
    searchMock.mockResolvedValueOnce(searchPage([project], 3, 1)).mockResolvedValueOnce(searchPage([project, iris], 3, 2));
    await render(true, "en-US");
    await act(async () => container.querySelector<HTMLButtonElement>(".vx-discover-load-more button")!.click());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const cards = [...container.querySelectorAll<HTMLElement>(".vx-project-card")];
    expect(cards.map(card => card.dataset.projectId)).toEqual(["sodium", "iris"]);
    expect(document.activeElement).toBe(cards[1]);
    expect(searchMock).toHaveBeenLastCalledWith("search_modrinth", expect.objectContaining({ offset: 1, limit: 24 }));
  });

  it("hides load more at the 10000 result window", async () => {
    const iris = { ...project, project_id: "iris", title: "Iris" };
    searchMock.mockResolvedValueOnce(searchPage([project], 20_000, 9_984)).mockResolvedValueOnce(searchPage([iris], 20_000, 10_000));
    await render(true, "en-US");
    expect(container.querySelector(".vx-discover-count")?.textContent).toContain("Showing 1 of 10,000");
    await act(async () => container.querySelector<HTMLButtonElement>(".vx-discover-load-more button")!.click());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(searchMock).toHaveBeenLastCalledWith("search_modrinth", expect.objectContaining({ offset: 9_984, limit: 16 }));
    expect(container.querySelector(".vx-discover-load-more button")).toBeNull();
  });

  it("disables load more while its page is loading", async () => {
    let resolveMore!: (value: SearchPage) => void;
    searchMock.mockResolvedValueOnce(searchPage([project], 3))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveMore = resolve; }));
    await render(true, "en-US");
    await act(async () => container.querySelector<HTMLButtonElement>(".vx-discover-load-more button")!.click());
    const pending = container.querySelector<HTMLButtonElement>(".vx-discover-load-more button")!;
    expect(pending.disabled).toBe(true);
    expect(pending.textContent).toBe("Loading…");
    await act(async () => resolveMore(searchPage([{ ...project, project_id: "iris" }], 3)));
  });

  it("changes sort, resets paging, and offers only the source's sort options", async () => {
    searchMock.mockResolvedValueOnce(searchPage([project], 8)).mockResolvedValueOnce(searchPage([{ ...project, project_id: "iris" }], 1));
    await render(true, "en-US");
    const sort = container.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Sort by"]')!;
    await act(async () => sort.click());
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')].map(option => option.textContent);
    expect(options).toEqual(["Relevance", "Downloads", "Followers", "Newest", "Recently updated"]);
    await act(async () => document.querySelector<HTMLElement>('[role="option"][data-value="downloads"]')!.click());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(searchMock).toHaveBeenLastCalledWith("search_modrinth", expect.objectContaining({ offset: 0, sort: "downloads" }));
    expect(container.querySelector('[data-project-id="iris"]')).not.toBeNull();
  });

  it("offers CurseForge only its own sort options", async () => {
    await render(true, "en-US");
    await act(async () => container.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Source"]')!.click());
    await act(async () => document.querySelector<HTMLElement>('[role="option"][data-value="curseforge"]')!.click());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const sort = container.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Sort by"]')!;
    expect(sort.textContent).toContain("Downloads");
    await act(async () => sort.click());
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')].map(option => option.textContent);
    expect(options).toEqual(["Downloads", "Recently updated", "Featured", "Popularity", "Name"]);
  });
});

describe("project version fitting", () => {
  function addInstance(
    id: string,
    name: string,
    versionId: string,
    gameVersion: string,
    loader: string | null,
    storedLoader: string = loader ?? "vanilla",
  ) {
    const base = mockLauncher.data.instances[0];
    mockLauncher.data.instances = [...mockLauncher.data.instances, { ...base, id, name, versionId, loader: storedLoader }];
    instanceContexts[id] = { versionId, context: { gameVersion, loader } };
  }

  function useVersionDetails(versions: ResourceProjectDetails["versions"]) {
    const dispatched = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => name === "get_modrinth_project_details"
      ? { ...details, versions }
      : dispatched(name, args));
  }

  function versionRows(drawer: HTMLElement) {
    const sections = drawer.querySelectorAll<HTMLElement>(".vx-project-details__section");
    return [...sections[0].querySelectorAll<HTMLElement>(".vx-resource-row")];
  }

  async function flush() {
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  }

  async function openDrawer() {
    await render(true, "en-US");
    await act(async () => container.querySelector<HTMLButtonElement>(".vx-project-card__actions button:last-child")!.click());
    await flush();
    return container.querySelector<HTMLDialogElement>(".vx-project-details")!;
  }

  it("counts loader-profile instances by resolved context and lists their names in the tooltip", async () => {
    addInstance("fabric-a", "Fabric Alpha", fabricVersion, "1.21.1", "fabric");
    addInstance("fabric-b", "Fabric Beta", fabricVersion, "1.21.1", "fabric");
    addInstance("fabric-c", "Fabric Gamma", fabricVersion, "1.21.1", "fabric");
    addInstance("fabric-d", "Fabric Delta", fabricVersion, "1.21.1", "fabric");
    addInstance("fabric-e", "Fabric Epsilon", fabricVersion, "1.21.1", "fabric");
    // The stored loader is stale; the resolved context must win.
    addInstance("fabric-f", "Fabric Zeta", fabricVersion, "1.21.1", "fabric", "");
    addInstance("quilt-world", "Quilt World", quiltVersion, "1.21.1", "quilt");
    addInstance("neo-world", "Neo World", neoforgeVersion, "1.21.1", "neoforge");
    addInstance("old-world", "Old World", forgeVersion, "1.20.1", "forge");
    const fitting = { ...details.versions[0], name: "Fitting version" };
    const single = { ...details.versions[0], id: "single", name: "Single version", loaders: ["quilt"] };
    const forge = { ...details.versions[0], id: "forge", name: "Forge version", gameVersions: ["1.20.1"], loaders: ["forge"] };
    const loose = { ...details.versions[0], id: "loose", name: "Loose version", gameVersions: ["1.19.4"] };
    useVersionDetails([fitting, single, forge, loose]);

    const drawer = await openDrawer();
    const rows = versionRows(drawer);
    const fittingRow = rows.find(row => row.textContent?.includes("Fitting version"))!;
    const singleRow = rows.find(row => row.textContent?.includes("Single version"))!;
    const forgeRow = rows.find(row => row.textContent?.includes("Forge version"))!;
    const looseRow = rows.find(row => row.textContent?.includes("Loose version"))!;
    const fittingText = fittingRow.querySelector<HTMLElement>(".vx-project-details__fits")!;

    expect(fittingRow.textContent).toContain("Fits 6 instances");
    expect(singleRow.textContent).toContain("Fits 1 instance");
    expect(forgeRow.textContent).toContain("Fits 1 instance");
    expect(fittingText.title).toContain("Fabric Alpha");
    expect(fittingText.title).toContain("Fabric Epsilon");
    expect(fittingText.title).toContain("and 1 more");
    expect(fittingText.title).not.toContain("Fabric Zeta");
    expect(fittingText.title).not.toContain("Quilt World");
    expect(looseRow.textContent).toContain("Fits no instance");
    expect(looseRow.querySelector(".vx-project-details__fits")?.hasAttribute("title")).toBe(false);
    // The names tooltip belongs to the fits text only; an Install button must
    // not inherit it from the whole row.
    expect(fittingRow.hasAttribute("title")).toBe(false);
    expect(commandMock).toHaveBeenCalledWith("get_resource_context", { versionId: fabricVersion, instanceId: "fabric-a" });
    expect(commandMock).toHaveBeenCalledWith("get_resource_context", { versionId: forgeVersion, instanceId: "old-world" });
  });

  it("hides versions that fit none of my instances when the toggle is on", async () => {
    addInstance("fabric-home", "Fabric Home", fabricVersion, "1.21.1", "fabric");
    const fitting = { ...details.versions[0], name: "Fitting version" };
    const loose = { ...details.versions[0], id: "loose", name: "Loose version", gameVersions: ["1.19.4"] };
    useVersionDetails([fitting, loose]);

    const drawer = await openDrawer();
    const toggle = drawer.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(toggle.checked).toBe(false);
    expect(drawer.textContent).toContain("Only versions for my instances");
    expect(versionRows(drawer)).toHaveLength(2);

    await act(async () => toggle.click());

    expect(toggle.checked).toBe(true);
    expect(versionRows(drawer).map(row => row.textContent).some(text => text?.includes("Fitting version"))).toBe(true);
    expect(versionRows(drawer).map(row => row.textContent).some(text => text?.includes("Loose version"))).toBe(false);
    expect(drawer.textContent).not.toContain("No versions fit your instances.");
  });

  it("explains when the filter hides every version", async () => {
    const loose = { ...details.versions[0], name: "Loose version", gameVersions: ["1.18.2"] };
    useVersionDetails([loose]);
    const drawer = await openDrawer();
    const toggle = drawer.querySelector<HTMLInputElement>('input[type="checkbox"]')!;

    await act(async () => toggle.click());

    expect(versionRows(drawer)).toHaveLength(0);
    expect(drawer.textContent).toContain("No versions fit your instances.");
  });

  it("keeps the version install button working while the filter is on", async () => {
    addInstance("fabric-home", "Fabric Home", fabricVersion, "1.21.1", "fabric");
    const drawer = await openDrawer();
    const toggle = drawer.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => toggle.click());

    const row = versionRows(drawer)[0];
    const install = row.querySelector<HTMLButtonElement>("button")!;
    await act(async () => install.click());

    expect(commandMock).toHaveBeenCalledWith("install_resource", expect.objectContaining({
      projectId: "sodium", instanceId: "fixture-world", resourceType: "mod",
    }));
  });

  it("resets the filter when the parent closes and reopens the drawer", async () => {
    addInstance("fabric-home", "Fabric Home", fabricVersion, "1.21.1", "fabric");
    mockLauncher.selectInstance = vi.fn((id?: string) => {
      const found = id ? mockLauncher.data.instances.find(instance => instance.id === id) : undefined;
      mockLauncher.selectedInstance = found;
      mockLauncher.selectedVersionId = found?.versionId ?? "";
    });
    const fitting = { ...details.versions[0], name: "Fitting version" };
    useVersionDetails([fitting]);
    resourcePlan = { ...plan(false), targets: [{
      kind: "instance", instanceId: "fabric-home", versionId: fabricVersion,
      name: "Fabric Home", gameVersion: "1.21.1", loader: "fabric", compatible: true,
    }] };

    const drawer = await openDrawer();
    const toggle = drawer.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => toggle.click());
    expect(toggle.checked).toBe(true);

    const install = versionRows(drawer)[0].querySelector<HTMLButtonElement>("button")!;
    await act(async () => install.click());
    await act(async () => dialogButton("Install into Fabric Home").click());
    await flush();

    expect(mockLauncher.selectInstance).toHaveBeenCalledWith("fabric-home");
    expect(drawer.open).toBe(false);

    await act(async () => container.querySelector<HTMLButtonElement>(".vx-project-card__actions button:last-child")!.click());
    await flush();
    expect(drawer.open).toBe(true);
    const reopened = drawer.querySelector<HTMLInputElement>(".vx-project-details__version-filter input")!;
    expect(reopened.checked).toBe(false);
    expect(versionRows(drawer)).toHaveLength(1);
  });

  it("shows no fit text and no filter for modpacks", async () => {
    addInstance("fabric-a", "Fabric Alpha", fabricVersion, "1.21.1", "fabric");
    const pack = { ...project, project_type: "modpack", title: "Example pack" };
    const packVersion = { ...details.versions[0], id: "pack-v1", name: "Pack version" };
    searchMock.mockResolvedValue(searchPage([pack], 1));
    const dispatched = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => name === "get_modrinth_project_details"
      ? { ...details, project: pack, versions: [packVersion], dependencies: [] }
      : dispatched(name, args));

    await render(true, "en-US");
    await act(async () => container.querySelector<HTMLButtonElement>(".vx-project-card__actions button:last-child")!.click());
    await flush();
    const drawer = container.querySelector<HTMLDialogElement>(".vx-project-details")!;

    expect(versionRows(drawer)).toHaveLength(1);
    expect(drawer.querySelector(".vx-project-details__fits")).toBeNull();
    expect(drawer.querySelector(".vx-project-details__version-filter")).toBeNull();
    expect(drawer.textContent).not.toContain("Fits");
  });

  it("appends older versions at the end and keeps their fit text and install action", async () => {
    addInstance("fabric-home", "Fabric Home", fabricVersion, "1.21.1", "fabric");
    const first = { ...details.versions[0], id: "v1", name: "1.0" };
    const older = { ...details.versions[0], id: "v0", name: "0.9", versionNumber: "0.9" };
    const dispatched = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => {
      if (name === "get_modrinth_project_details") return { ...details, versions: [first], hasMoreVersions: true };
      if (name === "get_modrinth_project_versions") return { versions: [older], hasMore: false };
      return dispatched(name, args);
    });

    const drawer = await openDrawer();
    expect(versionRows(drawer)).toHaveLength(1);
    const more = drawer.querySelector<HTMLButtonElement>(".vx-project-details__more button")!;
    expect(more.textContent).toBe("Load more versions");
    await act(async () => more.click());
    await flush();

    expect(versionRows(drawer)).toHaveLength(2);
    expect(versionRows(drawer)[1].textContent).toContain("0.9");
    expect(versionRows(drawer)[1].textContent).toContain("Fits 1 instance");
    expect(commandMock).toHaveBeenCalledWith("get_modrinth_project_versions", {
      projectId: "sodium", versionId: "1.21.1", instanceId: "fixture-world", resourceType: "mod", offset: 1,
    });
    expect(drawer.querySelector(".vx-project-details__more button")).toBeNull();
    const install = versionRows(drawer)[1].querySelector<HTMLButtonElement>("button")!;
    expect(install.disabled).toBe(false);
    await act(async () => install.click());
    await flush();
    expect(commandMock).toHaveBeenCalledWith("install_resource", expect.objectContaining({
      projectId: "sodium", resourceVersionId: "v0",
    }));
  });
});


describe("resource target installation", () => {
  it.each([
    ["en-US", "resource-download", "Downloading content", "5 / 8 files"],
    ["en-US", "loader-libraries", "Verifying loader libraries", "5 / 8 files"],
    ["zh-CN", "resource-download", "下载资源", "5 / 8 个文件"],
    ["zh-CN", "loader-libraries", "校验加载器依赖", "5 / 8 个文件"],
  ])("localizes %s creation progress from %s and preserves actual counts", async (language, stage, label, count) => {
    resourcePlan = plan(false);
    mockLauncher.resourceProgress = { taskId: "resource-task", operation: stage.startsWith("resource-") ? "resource" : "install", stage,
      completed: 5, total: 8, bytesCompleted: 0, bytesTotal: 0, message: "后端中文诊断，不应直接显示", versionId: fabricVersion };
    const dispatch = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => name === "create_instance_for_resource" ? await new Promise(() => {}) : dispatch(name, args));
    await render(true, language);
    const install = container.querySelector<HTMLButtonElement>(`[data-project-id="sodium"] button[aria-label^="${language === "en-US" ? "Install into" : "安装到"}"]`)!;
    await act(async () => install.click());
    await act(async () => dialogButton(language === "en-US" ? "Create and install" : "创建并安装").click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, MOTION.delay.loadingMs + 10)); });
    const status = container.querySelector('.vx-install-target .vx-loading-status:not(.sr-only)')?.textContent;
    expect(status).toContain(label);
    expect(status).toContain(count);
    expect(status).not.toContain("后端中文诊断");
    expect(status).not.toContain("Unknown stage");
  });

  it.each([
    ["resource-preflight", "Checking required dependencies"],
    ["future-resource-stage", "Creating the instance and installing the resource…"],
  ])("uses localized zero-total progress for %s without leaking diagnostic messages", async (stage, label) => {
    resourcePlan = plan(false);
    mockLauncher.resourceProgress = { taskId: "resource-task", operation: "resource", stage, completed: 0, total: 0, bytesCompleted: 0, bytesTotal: 0,
      message: "检查资源及必需前置", versionId: fabricVersion };
    const dispatch = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => name === "create_instance_for_resource" ? await new Promise(() => {}) : dispatch(name, args));
    await render(true, "en-US");
    await act(async () => container.querySelector<HTMLButtonElement>('[data-project-id="sodium"] button[aria-label^="Install into"]')!.click());
    await act(async () => dialogButton("Create and install").click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, MOTION.delay.loadingMs + 10)); });
    const status = container.querySelector('.vx-install-target .vx-loading-status:not(.sr-only)')?.textContent;
    expect(status).toContain(label);
    expect(status).not.toContain("检查资源及必需前置");
    expect(status).not.toContain("0 / 0");
    expect(status).not.toContain("Unknown stage");
  });

  it.each([
    { completed: 12, expected: "8 / 8 files" },
    { completed: -3, expected: "0 / 8 files" },
    { completed: Number.NaN, expected: "0 / 8 files" },
  ])("clamps invalid creation progress $completed to $expected", async ({ completed, expected }) => {
    resourcePlan = plan(false);
    mockLauncher.resourceProgress = { taskId: "resource-task", operation: "resource", stage: "resource-download", completed, total: 8,
      bytesCompleted: 0, bytesTotal: 0, message: "资源下载诊断", versionId: fabricVersion };
    const dispatch = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => name === "create_instance_for_resource" ? await new Promise(() => {}) : dispatch(name, args));
    await render(true, "en-US");
    await act(async () => container.querySelector<HTMLButtonElement>('[data-project-id="sodium"] button[aria-label^="Install into"]')!.click());
    await act(async () => dialogButton("Create and install").click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, MOTION.delay.loadingMs + 10)); });
    const status = container.querySelector('.vx-install-target .vx-loading-status:not(.sr-only)')?.textContent;
    expect(status).toContain(expected);
    expect(status).not.toMatch(/NaN|资源下载诊断/);
  });

  it("offers a prefilled Fabric instance instead of attempting installation into vanilla", async () => {
    resourcePlan = plan(false);
    await render(); await installCard();
    expect(commandMock).toHaveBeenCalledWith("resolve_resource_targets", { source: "modrinth", projectId: "sodium", resourceType: "mod" });
    expect(commandMock).not.toHaveBeenCalledWith("install_resource", expect.anything());
    const dialog = container.querySelector<HTMLDialogElement>(".vx-install-target")!;
    expect(dialog?.open).toBe(true);
    expect(dialog?.textContent).toContain("新建实例");
    expect(dialog?.querySelector('[aria-label="加载器"] [aria-pressed="true"]')?.textContent).toBe("Fabric");
    expect(dialog?.querySelector('[aria-label="游戏版本"]')?.textContent).toContain("1.21.1");
    expect(dialog?.querySelector<HTMLInputElement>('input[name="resource-instance-name"]')?.value).toBe("Sodium");
  });
  it("creates and installs with the selected supported pair, then selects the new instance", async () => {
    resourcePlan = plan(false);
    await render(); await installCard();
    await act(async () => dialogButton("创建并安装")?.click());
    expect(commandMock).toHaveBeenCalledWith("create_instance_for_resource", { source: "modrinth", projectId: "sodium", resourceType: "mod", loader: "fabric", gameVersion: "1.21.1", loaderVersion: "0.16.9", name: "Sodium", taskId: "resource-task" });
    expect(mockLauncher.reload).toHaveBeenCalled();
    expect(mockLauncher.selectInstance).toHaveBeenCalledWith("new");
    expect(vi.mocked(mockLauncher.reload)).toHaveBeenCalledBefore(vi.mocked(mockLauncher.selectInstance));
    expect(container.textContent).toContain("资源已安装到新实例");
  });
  it("offers a compatible existing Fabric instance with disabled reasons folded away", async () => {
    resourcePlan = plan(false);
    resourcePlan.targets.push({ ...resourcePlan.targets[0], instanceId: "fabric", versionId: fabricVersion, name: "Fabric 世界", loader: "fabric", compatible: true, reason: undefined });
    await render(); await installCard();
    expect(container.querySelector('.vx-install-target [role="radio"][aria-checked="true"]')?.textContent).toContain("Fabric 世界");
    expect(container.querySelector('.vx-install-target details')?.textContent).toContain("原版，无法加载模组");
    await act(async () => dialogButton("安装到Fabric 世界")?.click());
    expect(commandMock).toHaveBeenCalledWith("install_resource", { projectId: "sodium", versionId: fabricVersion, instanceId: "fabric", resourceType: "mod", taskId: "resource-task" });
  });
  it("keeps compatible selected targets as one-click installation", async () => {
    await render(); await installCard();
    expect(commandMock).toHaveBeenCalledWith("install_resource", expect.objectContaining({ instanceId: "fixture-world" }));
    expect(container.querySelector<HTMLDialogElement>('.vx-install-target')?.open).not.toBe(true);
  });
  it("puts New instance inside the target radiogroup and marks the selected row with a lattice frame", async () => {
    resourcePlan = plan(false);
    resourcePlan.targets.push(
      { ...resourcePlan.targets[0], instanceId: "fabric", versionId: fabricVersion, name: "Fabric 世界", loader: "fabric", compatible: true, reason: undefined },
      { ...resourcePlan.targets[0], instanceId: "fabric-two", versionId: fabricVersion, name: "Fabric 二号", loader: "fabric", compatible: true, reason: undefined },
    );
    await render(); await installCard();
    const dialog = container.querySelector<HTMLDialogElement>(".vx-install-target")!;
    const radios = [...dialog.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    expect(radios).toHaveLength(3);
    expect(radios[2].textContent).toContain("新建实例");
    expect(radios[0].getAttribute("aria-checked")).toBe("true");
    expect(radios[0].querySelector(".vx-lattice-frame")?.getAttribute("data-selected")).toBe("true");
    expect(radios[2].querySelector(".vx-lattice-frame")?.getAttribute("data-selected")).toBe("false");
    expect(dialog.querySelector('input[name="resource-instance-name"]')).toBeNull();

    await act(async () => radios[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
    expect(radios[2].getAttribute("aria-checked")).toBe("true");
    expect(radios[2].querySelector(".vx-lattice-frame")?.getAttribute("data-selected")).toBe("true");
    expect(dialog.querySelector<HTMLInputElement>('input[name="resource-instance-name"]')?.value).toBe("Sodium");
    expect([...dialog.querySelectorAll<HTMLButtonElement>(".vx-dialog__footer button")].map(button => button.textContent)).toContain("创建并安装");
  });
  it("gives New instance the same version-then-loader meta as the instance rows and follows the chosen loader", async () => {
    resourcePlan = plan(false);
    resourcePlan.targets.push({ ...resourcePlan.targets[0], instanceId: "fabric", versionId: fabricVersion, name: "Fabric 世界", loader: "fabric", compatible: true, reason: undefined });
    await render(); await installCard();
    const dialog = container.querySelector<HTMLDialogElement>(".vx-install-target")!;
    const radios = [...dialog.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    const meta = (radio: Element) => [...radio.querySelectorAll(".vx-install-target__meta > span")].map(span => span.textContent);
    expect(meta(radios[0])).toEqual(["1.21.1", "Fabric"]);
    expect(meta(radios[1])).toEqual(["1.21.1", "Fabric"]);
    // A neutral check (not an accent border or fill) sits in every option; CSS shows the checked one.
    expect(radios.every(radio => radio.querySelector("svg.vx-install-target__check"))).toBe(true);
    expect(dialog.querySelector(".vx-install-target details > summary svg.lucide-chevron-right")).not.toBeNull();

    await act(async () => radios[1].click());
    const neoforge = [...dialog.querySelectorAll<HTMLButtonElement>(".vx-install-target__create button")].find(button => button.textContent === "NeoForge")!;
    await act(async () => neoforge.click());
    expect(meta(radios[1])).toEqual(["1.21.1", "NeoForge"]);
  });
  it("heads the details drawer with its icon, author and downloads, and caps each version row at three game versions", async () => {
    const sixVersions = { ...details.versions[0], gameVersions: ["1.21.1", "1.21", "1.20.6", "1.20.4", "1.20.1", "1.19.4"] };
    const dispatch = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => name === "get_modrinth_project_details"
      ? { ...details, versions: [sixVersions] } : dispatch(name, args));
    searchMock.mockResolvedValue(searchPage([{ ...project, icon_url: "https://cdn.example/sodium.png" }], 1));
    await render(true, "en-US");
    await act(async () => container.querySelector<HTMLButtonElement>(".vx-project-card__actions button:last-child")!.click());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const drawer = container.querySelector<HTMLDialogElement>(".vx-project-details")!;
    const art = drawer.querySelector<HTMLElement>(".vx-project-details__art")!;
    expect(art.querySelector("svg.lucide-package")).not.toBeNull();
    // The glyph stays while the icon loads and is marked for hiding once it has loaded.
    expect(art.hasAttribute("data-loaded")).toBe(false);
    await act(async () => art.querySelector("img")!.dispatchEvent(new Event("load")));
    expect(art.dataset.loaded).toBe("true");
    expect(drawer.querySelector(".vx-project-details__author")?.textContent).toBe("Author");
    expect(drawer.querySelector(".vx-project-details__downloads")?.textContent).toContain("1.2K");
    const row = drawer.querySelector(".vx-resource-row")!;
    const gameVersions = row.querySelector(".vx-project-details__game-versions")!;
    expect(gameVersions.textContent).toBe("1.21.1, 1.21, 1.20.6 +3");
    expect(gameVersions.getAttribute("title")).toBe("1.21.1, 1.21, 1.20.6, 1.20.4, 1.20.1, 1.19.4");
    // Game versions and loader names share one meta line; loaders use their product names.
    expect(gameVersions.parentElement?.classList.contains("vx-project-details__version-meta")).toBe(true);
    expect(row.querySelector(".vx-project-details__loaders")?.textContent).toBe("Fabric");
    expect(drawer.querySelector(".vx-project-details__target svg.lucide-download")).not.toBeNull();
    expect(drawer.querySelector(".vx-project-details__target svg.lucide-arrow-down-to-line")).toBeNull();
    const action = drawer.querySelector<HTMLButtonElement>('.vx-dialog__footer button[data-variant="primary"]')!;
    expect(action.textContent).toBe("Install latest compatible");
    // The accessible name starts with the visible label (WCAG 2.5.3) and still names the target.
    expect(action.getAttribute("aria-label")).toBe("Install latest compatible into 合成测试世界");
  });
  it("explains a manual-only CurseForge file instead of installing it into the selected compatible instance", async () => {
    resourcePlan = { ...plan(), manualOnly: true, manualDownload };
    const dispatch = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => name === "get_curseforge_project_details"
      ? { ...details, versions: [{ ...details.versions[0], id: "8675309", name: "Sodium 0.6.0" }] } : dispatch(name, args));
    await render();
    await chooseCurseForge();
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent?.includes("查看详情"))!.click());
    await act(async () => container.querySelector<HTMLButtonElement>(".vx-project-details .vx-resource-row button")!.click());
    expect(commandMock).toHaveBeenCalledWith("resolve_resource_targets", { source: "curseforge", projectId: "sodium", resourceType: "mod", fileId: 8675309 });
    const called = commandMock.mock.calls.map(([name]) => name);
    expect(called).not.toContain("reserve_resource_task");
    expect(called).not.toContain("install_curseforge_resource");
    expect(called).not.toContain("list_loader_versions");
    const dialog = container.querySelector<HTMLDialogElement>(".vx-install-target")!;
    expect(dialog.open).toBe(true);
    const note = dialog.querySelector('[role="note"]')!;
    expect(note.textContent).toContain("需要手动下载");
    expect(note.textContent).toContain("作者不允许其他应用下载此文件。");
    expect(note.textContent).toContain("文件：Sodium 0.6.0（sodium-fabric-0.6.0.jar）");
    expect(note.textContent).toContain("然后放入「合成测试世界」的 mods 文件夹。");
    // Only the manual section: no target picker, creation form or install action.
    expect(dialog.querySelector('[role="radiogroup"]')).toBeNull();
    expect(dialog.querySelector('input[name="resource-instance-name"]')).toBeNull();
    expect(dialogButton("新建实例")).toBeUndefined();
    expect(dialogButton("安装到合成测试世界")).toBeUndefined();
    const open = dialogButton("在 CurseForge 打开文件页面");
    // Enter right after opening must not run a body action: the dialog starts
    // on its close button, and the manual link is the next Tab stop.
    expect(document.activeElement).toBe(dialog.querySelector("[data-dialog-close]"));
    await act(async () => dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(open);
    await act(async () => open.click());
    expect(openUrl).toHaveBeenCalledWith(manualDownload.url);
  });
  it("shows the manual section when a CurseForge install without a chosen file finds one to download by hand", async () => {
    const dispatch = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => {
      if (name === "install_curseforge_resource") throw { code: "resource.manualDownload", params: { fileId: "8675309" } };
      if (name === "resolve_resource_targets") return { ...plan(), manualOnly: true, manualDownload: { ...manualDownload, reason: "noDownloadUrl" } };
      return dispatch(name, args);
    });
    await render();
    await chooseCurseForge();
    await installCard();
    expect(commandMock).toHaveBeenCalledWith("resolve_resource_targets", { source: "curseforge", projectId: "sodium", resourceType: "mod", fileId: 8675309 });
    expect(commandMock.mock.calls.filter(([name]) => name === "install_curseforge_resource")).toHaveLength(1);
    const dialog = container.querySelector<HTMLDialogElement>(".vx-install-target")!;
    expect(dialog.open).toBe(true);
    expect(dialog.querySelector('[role="note"]')?.textContent).toContain("CurseForge 未向其他应用提供此文件的下载。");
    expect(dialogButton("在 CurseForge 打开文件页面")).toBeDefined();
    expect(container.textContent).not.toContain("发生未预期错误");
  });
  it.each([
    { type: "resourcepack", folder: "resourcepacks", reason: "untrustedUrl", text: "CurseForge 给出的此文件下载地址不在其官方下载服务器上，启动器不会使用。", shader: false },
    { type: "shader", folder: "shaderpacks", reason: "noDownloadUrl", text: "CurseForge 未向其他应用提供此文件的下载。", shader: true },
  ] as const)("names the $folder folder and the $reason reason without a single target", async ({ type, folder, reason, text, shader }) => {
    // No compatible target, a creation suggestion and an unsupported reason:
    // none of them may show next to the manual note.
    resourcePlan = { ...plan(false), unsupportedReason: "noVersions", manualOnly: true,
      manualDownload: { ...manualDownload, reason, displayName: "", fileName: "fixture-pack.zip" } };
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>(`#discover-type-${type}`)!.click());
    await installCard();
    const dialog = container.querySelector<HTMLDialogElement>(".vx-install-target")!;
    expect(dialog.open).toBe(true);
    const note = dialog.querySelector('[role="note"]')!.textContent;
    expect(note).toContain(text);
    expect(note).toContain("文件：fixture-pack.zip");
    expect(note).toContain(`然后放入要使用它的实例的 ${folder} 文件夹。`);
    expect(dialog.textContent).not.toContain("mods 文件夹");
    expect(dialog.textContent).not.toContain("该实例");
    expect(dialog.textContent).not.toContain("此 CurseForge 文件需要额外前置资源");
    expect(dialog.querySelector('input[name="resource-instance-name"]')).toBeNull();
    expect(dialogButton("新建实例")).toBeUndefined();
    expect(dialogButton("创建并安装")).toBeUndefined();
    expect(commandMock.mock.calls.map(([name]) => name)).not.toContain("list_loader_versions");
    expect(dialog.textContent?.includes("光影需要兼容的渲染加载器")).toBe(shader);
    expect(document.activeElement).toBe(dialog.querySelector("[data-dialog-close]"));
    await act(async () => dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(dialogButton("在 CurseForge 打开文件页面"));
  });
  it("still installs into a compatible selected target when only the Mojang manifest is unavailable", async () => {
    resourcePlan = { ...plan(), suggestion: null, manifestUnavailable: true };
    await render(); await installCard();
    expect(commandMock).toHaveBeenCalledWith("install_resource", expect.objectContaining({ instanceId: "fixture-world" }));
    expect(commandMock).not.toHaveBeenCalledWith("create_instance_for_resource", expect.anything());
    expect(container.querySelector<HTMLDialogElement>('.vx-install-target')?.open).not.toBe(true);
  });
  it.each([
    { reason: "noReleaseVersions" as const, manifestUnavailable: false, text: "该项目没有可安装的正式版游戏版本。" },
    { reason: "manifestUnavailable" as const, manifestUnavailable: true, text: "暂时无法获取游戏版本清单，无法建议新实例。" },
    { reason: undefined, manifestUnavailable: false, text: "该项目没有可安装的正式版游戏版本。" },
  ])("explains an empty target plan and offers the project page ($reason)", async ({ reason, manifestUnavailable, text }) => {
    resourcePlan = { ...plan(false), targets: [], suggestion: null, unsupportedReason: reason, manifestUnavailable };
    await render(); await installCard();
    const dialog = container.querySelector<HTMLDialogElement>('.vx-install-target')!;
    expect(dialog.open).toBe(true);
    expect(dialog.textContent).toContain(text);
    expect(dialogButton("创建并安装")).toBeUndefined();
    const external = dialogButton("打开项目页面");
    expect(external).toBeDefined();
    await act(async () => external.click());
    expect(openUrl).toHaveBeenCalledWith("https://modrinth.com/mod/sodium");
    expect(commandMock).not.toHaveBeenCalledWith("install_resource", expect.anything());
  });
  it("retains a created instance after resource failure and offers an error toast retry even when run swallows errors", async () => {
    resourcePlan = plan(false);
    const dispatch = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => {
      if (name === "create_instance_for_resource") throw { code: "resource.installAfterCreate", params: { instanceId: "new", instanceName: "Sodium", versionId: fabricVersion } };
      return dispatch(name, args);
    });
    mockLauncher.run = vi.fn(async (_key, action) => { try { return await action(); } catch { return undefined; } });
    await render(); await installCard();
    await act(async () => dialogButton("创建并安装")?.click());
    expect(mockLauncher.selectInstance).toHaveBeenCalledWith("new");
    const toast = container.querySelector('.vx-toast[role="alert"]')!;
    expect(toast?.textContent).toContain("实例已创建");
    const retry = [...toast.querySelectorAll('button')].find(button => button.textContent === "重试")!;
    await act(async () => retry.click());
    expect(commandMock).toHaveBeenCalledWith("install_resource", expect.objectContaining({ instanceId: "new", versionId: fabricVersion }));
  });
  it("shows unsupported datapacks with an external page and no create action", async () => {
    resourcePlan = { ...plan(false), unsupportedReason: "datapack" };
    await render(); await installCard();
    expect(container.querySelector('.vx-install-target')?.textContent).toContain("数据包需安装到存档 datapacks 目录，暂不支持");
    expect(dialogButton("创建并安装")).toBeUndefined();
    expect(dialogButton("打开项目页面")).toBeDefined();
    await act(async () => dialogButton("打开项目页面").click());
    expect(openUrl).toHaveBeenCalledWith("https://modrinth.com/datapack/sodium");
  });
  it("reports a partial creation failure with Retry after navigating away from Discover", async () => {
    resourcePlan = plan(false);
    let reject!: (cause: unknown) => void;
    const dispatch = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => name === "create_instance_for_resource" ? await new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }) : dispatch(name, args));
    await render(); await installCard();
    await act(async () => dialogButton("创建并安装")?.click());
    await render(false);
    await act(async () => reject({ code: "resource.installAfterCreate", params: { instanceId: "new", instanceName: "Sodium", versionId: fabricVersion } }));
    expect(mockLauncher.selectInstance).toHaveBeenCalledWith("new");
    expect(document.querySelector('.vx-toast[role="alert"]')?.textContent).toContain("重试");
  });
  it("opens modpack creation without a selected version", async () => {
    mockLauncher.selectedVersionId = ""; mockLauncher.selectedInstance = undefined; mockLauncher.data.instances = [];
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('#discover-type-modpack')!.click());
    await installCard();
    expect(container.querySelector<HTMLDialogElement>('.vx-create-instance')?.open ?? [...container.querySelectorAll('dialog')].some(dialog => dialog.open)).toBe(true);
    expect(commandMock).not.toHaveBeenCalledWith("resolve_resource_targets", expect.anything());
  });
  it("uses resolved game version and loader for searches instead of the selected profile id", async () => {
    mockLauncher.selectedVersionId = fabricVersion; mockLauncher.selectedInstance!.loader = "fabric";
    await render();
    expect(searchMock).toHaveBeenLastCalledWith("search_modrinth", expect.objectContaining({ query: "", gameVersion: "1.21.1", loader: "fabric" }));
  });
  it("invalidates pending target plans when the resource type changes", async () => {
    let finish!: (value: ReturnType<typeof plan>) => void;
    const dispatch = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => name === "resolve_resource_targets" ? await new Promise(resolve => { finish = resolve; }) : dispatch(name, args));
    await render(); await installCard();
    await act(async () => container.querySelector<HTMLButtonElement>('#discover-type-resourcepack')!.click());
    await act(async () => finish(plan(false)));
    expect(container.querySelector<HTMLDialogElement>('.vx-install-target')?.open).not.toBe(true);
    expect(commandMock).not.toHaveBeenCalledWith("install_resource", expect.anything());
  });
  it("cancels its queued creation without cancelling another installation of the same project", async () => {
    resourcePlan = plan(false);
    const dispatch = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => {
      if (name === "reserve_resource_task") return "owned-next-install";
      if (name === "create_instance_for_resource") return await new Promise(() => {});
      if (name === "list_download_tasks") return { revision: 2, tasks: [
        { id: "other-current-install", kind: "resource", target: "sodium", status: "paused" },
        { id: "owned-next-install", kind: "resource", target: "sodium", status: "queued" },
      ] };
      return dispatch(name, args);
    });
    await render(); await installCard();
    await act(async () => dialogButton("创建并安装")?.click());
    await act(async () => dialogButton("取消安装")?.click());
    expect(commandMock.mock.calls.filter(([name]) => name === "cancel_download_task")).toEqual([
      ["cancel_download_task", { taskId: "owned-next-install" }],
    ]);
    expect(commandMock).not.toHaveBeenCalledWith("list_download_tasks", expect.anything());
    expect(commandMock).toHaveBeenCalledWith("create_instance_for_resource", expect.objectContaining({ taskId: "owned-next-install" }));
  });
  it("cancels a pending reservation before dispatching the existing-target installation", async () => {
    resourcePlan = plan(false);
    resourcePlan.targets.push({ ...resourcePlan.targets[0], instanceId: "fabric", versionId: fabricVersion,
      name: "Fabric 世界", loader: "fabric", compatible: true, reason: undefined });
    const dispatch = commandMock.getMockImplementation()!;
    let release!: (id: string) => void;
    commandMock.mockImplementation(async (name, args) => {
      if (name === "reserve_resource_task") return await new Promise<string>(resolve => { release = resolve; });
      if (name === "install_resource") return await new Promise(() => {});
      if (name === "list_download_tasks") return { revision: 1, tasks: [
        { id: "other-active-install", kind: "resource", target: "sodium", status: "running" },
      ] };
      return dispatch(name, args);
    });
    await render(); await installCard();
    await act(async () => dialogButton("安装到Fabric 世界")?.click());
    await act(async () => dialogButton("取消安装")?.click());
    expect(commandMock.mock.calls.some(([name]) => name === "install_resource" || name === "cancel_download_task")).toBe(false);
    await act(async () => release("cancel-before-dispatch"));
    expect(commandMock.mock.calls.filter(([name]) => name === "cancel_download_task")).toEqual([
      ["cancel_download_task", { taskId: "cancel-before-dispatch" }],
    ]);
    expect(commandMock).not.toHaveBeenCalledWith("install_resource", expect.anything());
  });
  it("loads details without requiring an installed target", async () => {
    mockLauncher.selectedVersionId = ""; mockLauncher.selectedInstance = undefined;
    await render();
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === "查看详情")!.click());
    expect(commandMock).toHaveBeenCalledWith("get_modrinth_project_details", expect.objectContaining({ versionId: undefined }));
  });
  it("keeps a compatibility race from reopening a chooser for a superseded resource type", async () => {
    let reject!: (cause: unknown) => void;
    const dispatch = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => name === "install_resource" ? await new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }) : dispatch(name, args));
    await render(); await installCard();
    await act(async () => container.querySelector<HTMLButtonElement>('#discover-type-resourcepack')!.click());
    await act(async () => reject({ code: "resource.noCompatibleVersion" }));
    expect(commandMock.mock.calls.filter(([name]) => name === "resolve_resource_targets")).toHaveLength(1);
    expect(container.querySelector<HTMLDialogElement>('.vx-install-target')?.open).not.toBe(true);
  });
  it("resolves a retained instance before Retry when an older backend omits its profile id", async () => {
    resourcePlan = plan(false);
    const dispatch = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => {
      if (name === "create_instance_for_resource") throw { code: "resource.installAfterCreate", params: { instanceId: "new" } };
      return dispatch(name, args);
    });
    await render(); await installCard();
    await act(async () => dialogButton("创建并安装")?.click());
    resourcePlan.targets.push({ ...resourcePlan.targets[0], instanceId: "new", versionId: fabricVersion, name: "Sodium", loader: "fabric", compatible: true, reason: undefined });
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('.vx-toast button')].find(button => button.textContent === "重试")!.click());
    expect(commandMock).toHaveBeenCalledWith("install_resource", expect.objectContaining({ instanceId: "new", versionId: fabricVersion }));
  });
  it("ignores a failed fallback plan after its resource context was superseded", async () => {
    let rejectPlan!: (cause: unknown) => void;
    let plans = 0;
    const dispatch = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => {
      if (name === "install_resource") throw { code: "resource.loaderRequired" };
      if (name === "resolve_resource_targets" && ++plans > 1) return await new Promise((_resolve, rejectPromise) => { rejectPlan = rejectPromise; });
      return dispatch(name, args);
    });
    await render(); await installCard();
    await act(async () => container.querySelector<HTMLButtonElement>('#discover-type-resourcepack')!.click());
    await act(async () => rejectPlan(new Error("late metadata failure")));
    expect(container.querySelector<HTMLDialogElement>('.vx-install-target')?.open).not.toBe(true);
  });
  it("gives CurseForge a clear loader error and create entry without calling Modrinth planning", async () => {
    const dispatch = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => {
      if (name === "install_curseforge_resource") throw { code: "resource.loaderRequired", params: { versionId: "1.21.1" } };
      return dispatch(name, args);
    });
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="来源"]')!.click());
    await act(async () => document.querySelector<HTMLElement>('[role="option"][data-value="curseforge"]')!.click());
    await installCard();
    expect(commandMock).not.toHaveBeenCalledWith("resolve_resource_targets", expect.anything());
    expect(container.querySelector('.vx-install-target')?.textContent).toContain("需要模组加载器");
    expect(dialogButton("新建实例")).toBeDefined();
  });

  it.each(["modrinth", "curseforge"] as const)("shows the dependency summary notice for %s installs when required dependencies were resolved", async (source) => {
    const dispatch = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => {
      if (name === "install_resource" || name === "install_curseforge_resource") {
        return { name: "Sodium", fileName: "sodium.jar", path: "fixture/sodium.jar", dependencyCount: 2, changedCount: 3 };
      }
      return dispatch(name, args);
    });
    await render(true, "en-US");
    if (source === "curseforge") {
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Source"]')!.click());
      await act(async () => document.querySelector<HTMLElement>('[role="option"][data-value="curseforge"]')!.click());
    }
    await act(async () => container.querySelector<HTMLButtonElement>('[data-project-id="sodium"] button[aria-label^="Install into"]')!.click());
    const toast = container.querySelector('.vx-toast[role="status"]')?.textContent ?? "";
    expect(toast).toContain("2 required dependencies verified");
    expect(toast).toContain("3 added or updated");
  });

  it("shows the already-installed notice and dependency notice on new-instance creation", async () => {
    const dispatch = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => {
      if (name === "install_curseforge_resource") {
        return { name: "Sodium", fileName: "sodium.jar", path: "fixture/sodium.jar", alreadyInstalled: true };
      }
      return dispatch(name, args);
    });
    await render(true, "en-US");
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Source"]')!.click());
    await act(async () => document.querySelector<HTMLElement>('[role="option"][data-value="curseforge"]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[data-project-id="sodium"] button[aria-label^="Install into"]')!.click());
    expect(container.querySelector('.vx-toast[role="status"]')?.textContent).toContain("already at the selected version");

    resourcePlan = plan(false);
    commandMock.mockImplementation(async (name, args) => {
      if (name === "create_instance_for_resource") {
        return {
          instance: { ...mockLauncher.data.instances[0], id: "new", versionId: fabricVersion, name: "Sodium" },
          install: { name: "Sodium", fileName: "sodium.jar", path: "fixture/sodium.jar", dependencyCount: 1, changedCount: 2 },
        };
      }
      return dispatch(name, args);
    });
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Source"]')!.click());
    await act(async () => document.querySelector<HTMLElement>('[role="option"][data-value="modrinth"]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[data-project-id="sodium"] button[aria-label^="Install into"]')!.click());
    await act(async () => dialogButton("Create and install").click());
    const createdToast = container.querySelector('.vx-toast[role="status"]')?.textContent ?? "";
    expect(createdToast).toContain("1 required dependency verified");
    expect(createdToast).toContain("2 added or updated");
  });

  it("interpolates backend error params for CurseForge dependency refusals in Discover feedback toasts", async () => {
    const cases = [
      {
        error: {
          code: "resource.dependencyManualDownload",
          params: {
            name: "Restricted Dep",
            file: "restricted-1.0.zip",
            url: "https://www.curseforge.com/minecraft/texture-packs/restricted",
            folder: "resourcepacks",
          },
        },
        expected: ["Restricted Dep", "restricted-1.0.zip", "https://www.curseforge.com/minecraft/texture-packs/restricted", "resourcepacks"],
      },
      {
        error: {
          code: "resource.dependencyInstallFirst",
          params: { name: "Entity Model Features", folder: "mods" },
        },
        expected: ["Entity Model Features"],
      },
      {
        error: {
          code: "resource.dependencyIncompatible",
          params: { project: "OptiFine (optifine.jar)" },
        },
        expected: ["OptiFine (optifine.jar)"],
      },
      {
        error: {
          code: "resource.dependencyUnavailable",
          params: { name: "Forge Only Library" },
        },
        expected: ["Forge Only Library"],
      },
    ];
    for (const item of cases) {
      const dispatch = commandMock.getMockImplementation()!;
      commandMock.mockImplementation(async (name, args) => {
        if (name === "install_curseforge_resource") throw item.error;
        return dispatch(name, args);
      });
      await render(true, "en-US");
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Source"]')!.click());
      await act(async () => document.querySelector<HTMLElement>('[role="option"][data-value="curseforge"]')!.click());
      await act(async () => container.querySelector<HTMLButtonElement>('[data-project-id="sodium"] button[aria-label^="Install into"]')!.click());
      const toast = container.querySelector('.vx-toast[role="alert"]')?.textContent ?? "";
      for (const fragment of item.expected) expect(toast).toContain(fragment);
      expect(toast).not.toMatch(/\{\{.+?\}\}/);
    }
  });
});
