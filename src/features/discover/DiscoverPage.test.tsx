// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { GlassProvider } from "../../visual/glass/GlassSystem";
import { createLauncherI18n } from "../../i18n";
import { command, defaults, searchResources, type Bootstrap, type ResourceProject } from "../../lib/launcher";
import type { LauncherContextValue } from "../../app/controller/types";
import { DiscoverPage } from "./DiscoverPage";
import { ToastProvider } from "../../components/ui/ToastProvider";
import { openUrl } from "@tauri-apps/plugin-opener";
import { MOTION } from "../../design/motion";
import type { ResourceProjectDetails } from "./types";

const commandMock = vi.mocked(command);
const searchMock = vi.mocked(searchResources);
let mockLauncher: LauncherContextValue;
let root: Root;
let container: HTMLDivElement;
let resourcePlan: ReturnType<typeof plan>;
const fabricVersion = "fabric-loader-0.16.9-1.21.1";
function plan(compatible = true) {
  return { projectId: "sodium", title: "Sodium", projectType: "mod", targets: [{ kind: "instance", instanceId: "fixture-world", versionId: "1.21.1", name: "合成测试世界", gameVersion: "1.21.1", loader: null as string | null, compatible, reason: compatible ? undefined : "vanilla" }], suggestion: { loader: "fabric", gameVersion: "1.21.1", name: "Sodium", matrix: [{ loader: "fabric", gameVersions: ["1.21.1", "1.20.1"] }, { loader: "neoforge", gameVersions: ["1.21.1"] }] }, unsupportedReason: undefined as string | undefined };
}
async function installCard() {
  await act(async () => container.querySelector<HTMLButtonElement>('[data-project-id="sodium"] button[aria-label*="安装"]')!.click());
}
function dialogButton(text: string) {
  return [...container.querySelectorAll<HTMLButtonElement>(".vx-install-target button")].find(button => button.textContent === text)!;
}

vi.mock("../../lib/launcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/launcher")>()),
  command: vi.fn(),
  searchResources: vi.fn(),
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
    progress: null,
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
  project.project_type = "mod";
  commandMock.mockReset();
  commandMock.mockImplementation(async (name) => {
    if (name === "get_modrinth_project_details" || name === "get_curseforge_project_details") return details;
    if (name === "get_resource_context") return { gameVersion: "1.21.1", loader: mockLauncher.selectedInstance?.loader === "fabric" ? "fabric" : null };
    if (name === "resolve_resource_targets") return resourcePlan;
    if (name === "list_loader_versions") return [{ id: "0.16.9", stable: true, recommended: true }];
    if (name === "list_download_tasks") return [];
    if (name === "create_instance_for_resource") return { instance: { ...mockLauncher.data.instances[0], id: "new", versionId: fabricVersion, name: "Sodium" }, install: {} };
    if (name === "search_curseforge") return { hits: [project] };
    if (name === "install_resource" || name === "install_curseforge_resource") return { name: "Sodium", fileName: "sodium.jar", path: "fixture/sodium.jar" };
    if (name === "list_modpack_versions") return [];
    return null;
  });
  searchMock.mockReset();
  searchMock.mockResolvedValue([project]);
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
    expect(searchMock).toHaveBeenLastCalledWith("sodium", "mod", "1.21.1", undefined);
    expect(container.querySelector('[data-project-id="sodium"]')).not.toBeNull();

    let rejectSearch!: (cause: Error) => void;
    searchMock.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSearch = reject; }));
    await submitSearch("iris");
    expect(searchMock).toHaveBeenLastCalledWith("iris", "mod", "1.21.1", undefined);
    expect(container.querySelector('.vx-project-grid')?.hasAttribute("inert")).toBe(true);
    await act(async () => rejectSearch(new Error("offline")));
    expect(container.querySelectorAll('.vx-project-grid [data-project-id]')).toHaveLength(0);
    expect(container.querySelector('.vx-project-grid')?.getAttribute("aria-busy")).toBe("false");
    expect(container.querySelector('.vx-project-grid')?.hasAttribute("inert")).toBe(false);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();

    let resolveRetry!: (items: ResourceProject[]) => void;
    searchMock.mockImplementationOnce(() => new Promise((resolve) => { resolveRetry = resolve; }));
    await submitSearch("iris");
    expect(searchMock).toHaveBeenCalledTimes(4);
    expect(searchMock).toHaveBeenNthCalledWith(4, "iris", "mod", "1.21.1", undefined);
    expect(container.querySelector('.vx-project-grid')?.getAttribute("aria-busy")).toBe("true");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => resolveRetry([{ ...project, project_id: "iris", title: "Iris" }]));
    const freshCard = container.querySelector('[data-project-id="iris"]')!;
    expect(freshCard).not.toBeNull();
    expect(container.querySelector('.vx-project-grid')?.hasAttribute("inert")).toBe(false);
    expect(container.querySelector('.vx-project-grid')?.getAttribute("aria-busy")).toBe("false");
    const install = freshCard.querySelector<HTMLButtonElement>('button[aria-label*="安装"]')!;
    expect(install.disabled).toBe(false);
    await act(async () => install.click());
    expect(commandMock).toHaveBeenCalledWith("install_resource", { projectId: "iris", versionId: "1.21.1", instanceId: "fixture-world", resourceType: "mod" });
  });

  it("keeps same-source results visible but inert until the new type finishes loading", async () => {
    await render();
    let resolveSearch!: (items: ResourceProject[]) => void;
    searchMock.mockImplementationOnce(() => new Promise((resolve) => { resolveSearch = resolve; }));
    const previousCard = container.querySelector('[data-project-id="sodium"]')!;
    const install = previousCard.querySelector<HTMLButtonElement>('button[aria-label*="安装"]')!;
    await act(async () => container.querySelector<HTMLButtonElement>('#discover-type-resourcepack')!.click());
    expect(previousCard.isConnected).toBe(true);
    expect(container.querySelector('.vx-project-grid')?.hasAttribute("inert")).toBe(true);
    expect(container.querySelector('.vx-project-grid')?.getAttribute("aria-busy")).toBe("true");
    await act(async () => install.click());
    expect(commandMock).not.toHaveBeenCalledWith("install_resource", expect.anything());
    await act(async () => resolveSearch([{ ...project, project_id: "fresh-pack", title: "Fresh pack", project_type: "resourcepack" }]));
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
    expect(container.textContent).not.toContain("必需");
  });

  it("switches source without losing the selected instance", async () => {
    await render();
    const source = container.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="来源"]')!;
    await act(async () => source.click());
    await act(async () => document.querySelector<HTMLElement>('[role="option"][data-value="curseforge"]')!.click());
    expect(commandMock).toHaveBeenCalledWith("search_curseforge", { query: "", resourceType: "mod", gameVersion: "1.21.1", loader: undefined });
    const target = container.querySelector('[role="combobox"][aria-label="安装到"]');
    expect(target?.textContent).toContain("合成测试世界");
  });

  it("installs the selected project into the selected instance", async () => {
    await render();
    const projectCard = container.querySelector('[data-project-id="sodium"]')!;
    expect(projectCard.querySelector('button[aria-label*="合成测试世界"]')).not.toBeNull();
    await act(async () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("安装"))!.click());
    expect(commandMock).toHaveBeenCalledWith("install_resource", { projectId: "sodium", versionId: "1.21.1", instanceId: "fixture-world", resourceType: "mod" });
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
    searchMock.mockResolvedValue([project]);
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
});


describe("resource target installation", () => {
  it.each([
    ["en-US", "resource-download", "Downloading content", "5 / 8 files"],
    ["en-US", "loader-libraries", "Verifying loader libraries", "5 / 8 files"],
    ["zh-CN", "resource-download", "下载资源", "5 / 8 个文件"],
    ["zh-CN", "loader-libraries", "校验加载器依赖", "5 / 8 个文件"],
  ])("localizes %s creation progress from %s and preserves actual counts", async (language, stage, label, count) => {
    resourcePlan = plan(false);
    mockLauncher.progress = { operation: stage.startsWith("resource-") ? "resource" : "install", stage,
      completed: 5, total: 8, bytesCompleted: 0, bytesTotal: 0, message: "后端中文诊断，不应直接显示", versionId: fabricVersion };
    const dispatch = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => name === "create_instance_for_resource" ? await new Promise(() => {}) : dispatch(name, args));
    await render(true, language);
    const install = container.querySelector<HTMLButtonElement>(`[data-project-id="sodium"] button[aria-label^="${language === "en-US" ? "Install" : "安装"} ·"]`)!;
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
    mockLauncher.progress = { operation: "resource", stage, completed: 0, total: 0, bytesCompleted: 0, bytesTotal: 0,
      message: "检查资源及必需前置", versionId: fabricVersion };
    const dispatch = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => name === "create_instance_for_resource" ? await new Promise(() => {}) : dispatch(name, args));
    await render(true, "en-US");
    await act(async () => container.querySelector<HTMLButtonElement>('[data-project-id="sodium"] button[aria-label^="Install ·"]')!.click());
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
    mockLauncher.progress = { operation: "resource", stage: "resource-download", completed, total: 8,
      bytesCompleted: 0, bytesTotal: 0, message: "资源下载诊断", versionId: fabricVersion };
    const dispatch = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => name === "create_instance_for_resource" ? await new Promise(() => {}) : dispatch(name, args));
    await render(true, "en-US");
    await act(async () => container.querySelector<HTMLButtonElement>('[data-project-id="sodium"] button[aria-label^="Install ·"]')!.click());
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
    expect(commandMock).toHaveBeenCalledWith("create_instance_for_resource", { source: "modrinth", projectId: "sodium", resourceType: "mod", loader: "fabric", gameVersion: "1.21.1", loaderVersion: "0.16.9", name: "Sodium" });
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
    await act(async () => dialogButton("安装到 Fabric 世界")?.click());
    expect(commandMock).toHaveBeenCalledWith("install_resource", { projectId: "sodium", versionId: fabricVersion, instanceId: "fabric", resourceType: "mod" });
  });
  it("keeps compatible selected targets as one-click installation", async () => {
    await render(); await installCard();
    expect(commandMock).toHaveBeenCalledWith("install_resource", expect.objectContaining({ instanceId: "fixture-world" }));
    expect(container.querySelector<HTMLDialogElement>('.vx-install-target')?.open).not.toBe(true);
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
    expect(searchMock).toHaveBeenLastCalledWith("", "mod", "1.21.1", "fabric");
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
  it("cancels only the matching resource task including when paused", async () => {
    resourcePlan = plan(false);
    const dispatch = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => {
      if (name === "create_instance_for_resource") return await new Promise(() => {});
      if (name === "list_download_tasks") return [{ id: "unrelated", kind: "install", target: "1.21.1", status: "running" }, { id: "matched", kind: "resource", target: "sodium", status: "paused" }];
      return dispatch(name, args);
    });
    await render(); await installCard();
    await act(async () => dialogButton("创建并安装")?.click());
    await act(async () => dialogButton("取消安装")?.click());
    expect(commandMock).toHaveBeenCalledWith("cancel_download_task", { taskId: "matched" });
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
});
