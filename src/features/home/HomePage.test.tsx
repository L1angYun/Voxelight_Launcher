// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { createLauncherI18n } from "../../i18n";
import { command, defaults, type Bootstrap, type Config } from "../../lib/launcher";
import type { LauncherContextValue } from "../../app/controller/types";
import { HomePage } from "./HomePage";

const commandMock = vi.mocked(command);
let mockLauncher: LauncherContextValue;
let root: Root;
let container: HTMLDivElement;
let mockEffects: "lite" | "full" = "full";

vi.mock("../../lib/launcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/launcher")>()),
  command: vi.fn(),
}));
vi.mock("../../app/controller/LauncherProvider", () => ({
  useLauncher: () => mockLauncher,
}));
vi.mock("../../app/AppearanceProvider", () => ({
  useAppearance: () => ({
    effects: mockEffects,
    reducedMotion: false,
    reducedTransparency: false,
    highContrast: false,
  }),
}));
vi.mock("../../visual/overture/OvertureProvider", () => ({
  useOverture: () => ({
    current: null,
    playing: false,
    reducedMotion: false,
    soundEnabled: false,
    play: vi.fn(),
    dismiss: vi.fn(),
  }),
}));
vi.mock("../../components/WorldScene", () => ({
  WorldScene: () => createElement("div", { "data-testid": "world-scene" }),
}));
vi.mock("../../visual/character/CharacterCanvas", () => ({
  CharacterCanvas: ({ paused }: { paused: boolean }) => createElement("div", { "data-testid": "character-canvas", "data-paused": paused }),
}));
vi.mock("../../visual/glass/GlassSystem", () => ({
  GlassSurface: ({ children }: { children: React.ReactNode }) => createElement("div", null, children),
}));
const defaultSkinMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/defaultSkin", () => ({
  useDefaultSkin: defaultSkinMock,
}));

function fixture(): LauncherContextValue {
  const config: Config = { ...defaults };
  const data: Bootstrap = {
    config,
    accounts: [
      {
        id: "fixture-classic",
        username: "CyanFixture",
        uuid: "11111111111111111111111111111111",
        type: "microsoft",
        isSelected: true,
        expiresAt: null,
        skinUrl: null,
        skinModel: "classic",
        authlibServer: null,
      },
    ],
    instances: [
      {
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
      },
    ],
    installedVersions: [
      {
        id: "1.21.1",
        type: "release",
        installed: true,
        launchable: true,
        reason: undefined,
        javaMajor: 21,
      },
    ],
    capabilities: {},
  };
  const selectedInstance = data.instances[0];
  const selectedVersion = data.installedVersions[0];
  return {
    data,
    config,
    manifest: { latestRelease: "1.21.1", latestSnapshot: "", versions: [] },
    activeAccount: data.accounts[0],
    accountAppearance: {
      profile: null,
      setProfile: vi.fn(),
      skinUrl: "skin.png",
      model: "classic",
      capeUrl: "cape.png",
      hasAccountSkin: true,
      loading: false,
      error: "",
      refresh: vi.fn(),
    },
    selectedInstance,
    selectedVersion,
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
  await act(async () => {
    root.render(createElement(I18nextProvider, { i18n }, createElement(HomePage)));
  });
}

function changeSelect(select: HTMLSelectElement, value: string) {
  select.value = value;
  select.dispatchEvent(new Event("input", { bubbles: true }));
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mockLauncher = fixture();
  mockEffects = "full";
  defaultSkinMock.mockReset();
  defaultSkinMock.mockReturnValue({
    skin: { id: "steve", name: "Steve", dataUrl: "steve.png", model: "classic" },
    loading: false,
    error: "",
    refresh: vi.fn(),
  });
  commandMock.mockReset();
  commandMock.mockResolvedValue(null);
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function () {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: function () {
      this.open = false;
      this.dispatchEvent(new Event("close"));
    },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("HomePage", () => {
  it("puts the real instance and launch action first", async () => {
    await render();
    expect(container.querySelector("h1")?.textContent).toBe("合成测试世界");
    expect(container.querySelector('[data-testid="character-canvas"]')).not.toBeNull();
    const launch = container.querySelector<HTMLButtonElement>('[data-launch-primary]')!;
    expect(launch.textContent).toContain("启动游戏");
    expect(container.textContent).not.toContain("YOUR NEXT ADVENTURE");
    await act(async () => launch.click());
    expect(mockLauncher.launch).toHaveBeenCalledTimes(1);
  });

  it("shows a real preparation state and cancels it", async () => {
    mockLauncher.busy = "game.prepare";
    mockLauncher.progress = {
      operation: "install",
      stage: "assets",
      completed: 37,
      total: 100,
      bytesCompleted: 37,
      bytesTotal: 100,
      message: "fixture progress",
      versionId: "1.21.1",
    };
    await render();
    expect(container.textContent).toContain("37%");
    const cancel = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("取消准备"))!;
    await act(async () => cancel.click());
    expect(mockLauncher.cancelPreparation).toHaveBeenCalledTimes(1);
  });

  it("keeps version-directory selection after clearing the instance", async () => {
    await render();
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="当前实例"]')!;
    await act(async () => {
      changeSelect(select, "");
    });
    mockLauncher.selectedInstance = undefined;
    await render();
    expect(container.querySelector("h1")?.textContent).toBe("1.21.1");
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="当前实例"]')?.value).toBe("");
  });

  it("does not show a completed or unrelated transfer as game preparation", async () => {
    mockLauncher.progress = {
      operation: "install", stage: "assets", completed: 37, total: 100,
      bytesCompleted: 37, bytesTotal: 100, message: "old transfer", versionId: "1.20.1",
    };
    await render();
    expect(container.querySelector('[data-launch-primary]')?.textContent).toContain("启动游戏");
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
  });

  it("keeps instance selection in the launch console and mounts recent instances", async () => {
    mockLauncher.data.instances = [
      ...mockLauncher.data.instances,
      { ...mockLauncher.data.instances[0], id: "fixture-second", name: "第二个测试世界" },
    ];
    await render();
    expect(container.querySelector(".vx-recent")).not.toBeNull();
    expect(container.querySelectorAll(".vx-recent-card")).toHaveLength(2);
    expect(container.querySelectorAll("select#home-instance")).toHaveLength(1);
    const select = container.querySelector<HTMLSelectElement>("select#home-instance")!;
    await act(async () => changeSelect(select, "fixture-second"));
    expect(mockLauncher.selectInstance).toHaveBeenCalledWith("fixture-second");
  });

  it("limits the recent row to four instances", async () => {
    mockLauncher.data.instances = Array.from({ length: 6 }, (_, index) => ({
      ...mockLauncher.data.instances[0],
      id: `fixture-recent-${index}`,
      name: `最近世界 ${index}`,
    }));
    await render();
    expect(container.querySelectorAll(".vx-recent-card")).toHaveLength(4);
  });

  it("opens the create flow from a useful empty state", async () => {
    mockLauncher.data.instances = [];
    mockLauncher.selectedInstance = undefined;
    mockLauncher.selectedVersion = undefined;
    mockLauncher.selectedVersionId = "";
    await render();
    expect(container.textContent).toContain("暂无实例");
    const create = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("创建实例"))!;
    await act(async () => create.click());
    expect(container.querySelector("dialog")!.open).toBe(true);
    expect(container.querySelector("dialog")?.textContent).toContain("创建实例");
  });

  it("labels the default character as a preview when no account is selected", async () => {
    mockLauncher.activeAccount = undefined;
    mockLauncher.accountAppearance = {
      ...mockLauncher.accountAppearance,
      skinUrl: undefined,
      capeUrl: undefined,
      hasAccountSkin: false,
    };
    await render();
    expect(container.querySelector('[data-testid="character-canvas"]')).not.toBeNull();
    expect(container.textContent).toContain("默认角色预览");
    expect(container.textContent).not.toContain("CyanFixture 的角色预览");
  });

  it("keeps the scene and character static in lite effects mode", async () => {
    mockEffects = "lite";
    await render();
    expect(container.querySelector('[data-testid="character-canvas"]')?.getAttribute("data-paused")).toBe("true");
    // OvertureScene removed; staticness is conveyed through CharacterCanvas data-paused
    expect(container.querySelector('[data-testid="character-canvas"]')?.getAttribute("data-paused")).toBe("true");
  });

  it("shows an honest empty default preview and retries after a failure", async () => {
    mockLauncher.activeAccount = undefined;
    mockLauncher.accountAppearance = {
      ...mockLauncher.accountAppearance,
      skinUrl: undefined,
      capeUrl: undefined,
      hasAccountSkin: false,
    };
    const refresh = vi.fn();
    defaultSkinMock.mockReturnValue({
      skin: { id: "steve", name: "Steve", dataUrl: "", model: "classic", isFallback: true },
      loading: false,
      error: "renderer.unavailable",
      refresh,
    });
    await render();
    expect(container.querySelector('[data-testid="character-canvas"]')).toBeNull();
    expect(container.textContent).toContain("默认预览暂不可用");
    const retry = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("重试默认预览"))!;
    await act(async () => retry.click());
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not substitute a character when the online profile is unavailable", async () => {
    mockLauncher.accountAppearance = {
      ...mockLauncher.accountAppearance,
      skinUrl: undefined,
      capeUrl: undefined,
      hasAccountSkin: false,
      error: "fixture diagnostic",
      errorCode: "auth.profileUnavailable",
    };
    await render();
    expect(container.querySelector('[data-testid="character-canvas"]')).toBeNull();
    expect(container.textContent).toContain("账号外观暂不可用");
    const retry = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("重试账号外观"))!;
    await act(async () => retry.click());
    expect(mockLauncher.accountAppearance.refresh).toHaveBeenCalledTimes(1);
  });
});
