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
import type { ResourceProjectDetails } from "./types";

const commandMock = vi.mocked(command);
const searchMock = vi.mocked(searchResources);
let mockLauncher: LauncherContextValue;
let root: Root;
let container: HTMLDivElement;

vi.mock("../../lib/launcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/launcher")>()),
  command: vi.fn(),
  searchResources: vi.fn(),
}));
vi.mock("../../app/controller/LauncherProvider", () => ({
  useLauncher: () => mockLauncher,
}));
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

async function render() {
  const i18n = createLauncherI18n("zh-CN", "zh-CN");
  await i18n.initPromise;
  await act(async () => root.render(createElement(I18nextProvider, { i18n },
    createElement(GlassProvider, { effects: "lite", reducedMotion: true }, createElement(ToastProvider, null, createElement(DiscoverPage))))));
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
  project.project_type = "mod";
  commandMock.mockReset();
  commandMock.mockImplementation(async (name) => {
    if (name === "get_modrinth_project_details" || name === "get_curseforge_project_details") return details;
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
    }
  });
  it("clears cards after a new search fails and lets the same query retry restore usable results", async () => {
    await render();
    await submitSearch("sodium");
    expect(searchMock).toHaveBeenLastCalledWith("sodium", "mod", "1.21.1");
    expect(container.querySelector('[data-project-id="sodium"]')).not.toBeNull();

    let rejectSearch!: (cause: Error) => void;
    searchMock.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSearch = reject; }));
    await submitSearch("iris");
    expect(searchMock).toHaveBeenLastCalledWith("iris", "mod", "1.21.1");
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
    expect(searchMock).toHaveBeenNthCalledWith(4, "iris", "mod", "1.21.1");
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
    expect(commandMock).toHaveBeenCalledWith("search_curseforge", { query: "", resourceType: "mod", gameVersion: "1.21.1", loader: "vanilla" });
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

  it("requires a target before installing", async () => {
    mockLauncher.selectedVersionId = "";
    mockLauncher.selectedInstance = undefined;
    await render();
    await act(async () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("安装"))!.click());
    expect(commandMock).not.toHaveBeenCalledWith("install_resource", expect.anything());
    expect(container.textContent).toContain("需要先选择实例");
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
