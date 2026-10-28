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
    createElement(GlassProvider, { effects: "lite", reducedMotion: true }, createElement(DiscoverPage)))));
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mockLauncher = fixture();
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
    const source = container.querySelectorAll<HTMLSelectElement>("select")[1]!;
    await act(async () => {
      source.value = "curseforge";
      source.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(commandMock).toHaveBeenCalledWith("search_curseforge", { query: "", resourceType: "mod", gameVersion: "1.21.1", loader: "vanilla" });
    const target = container.querySelectorAll("select")[0];
    expect(target.value).toBe("fixture-world");
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
