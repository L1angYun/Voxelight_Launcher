// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { createLauncherI18n } from "../../i18n";
import { command, defaults, type Bootstrap, type Instance } from "../../lib/launcher";
import type { LauncherContextValue } from "../../app/controller/types";
import { instanceTabRegistry } from "../../app/registry";
import { LibraryPage } from "./LibraryPage";
import { InstanceDetailPage } from "./InstanceDetailPage";
import { CreateInstanceDialog } from "./CreateInstanceDialog";

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
    if (name === "list_local_resources" || name === "list_worlds" || name === "list_screenshots" || name === "list_instance_backups") return [];
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
  it("composes the collection as a command bar and identity-driven instance sheet", async () => {
    expect(instanceTabRegistry.ids()).toEqual(["overview", "content", "worlds", "logs", "settings"]);
    await render(createElement(LibraryPage));
    const card = container.querySelector<HTMLElement>('[data-instance-id="fixture-world"]')!;
    expect(card.dataset.visualOwner).toBe("lattice");
    expect(card.querySelector("[data-launch]")!.getAttribute("data-variant")).toBe("secondary");
    expect(card.querySelectorAll(".vx-lattice-frame__dot")).toHaveLength(64);
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
    const name = container.querySelector<HTMLInputElement>("#create-instance-name")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(name, "Fabric 世界");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("安装并准备"))!.click());
    expect(commandMock).toHaveBeenCalledWith("install_loader", { loader: "fabric", gameVersion: "1.21.1", loaderVersion: "0.16.9" });
    expect(commandMock).toHaveBeenCalledWith("create_instance", { name: "Fabric 世界", versionId: "fabric-loader-0.16.9-1.21.1" });
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
});
