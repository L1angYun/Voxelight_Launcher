// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { createLauncherI18n } from "../../i18n";
import { command, defaults, type Bootstrap, type Config } from "../../lib/launcher";
import type { LauncherContextValue } from "../../app/controller/types";
import { HomePage } from "./HomePage";
import { readFileSync } from "node:fs";

const homeStyles = readFileSync("src/features/home/home.css", "utf8");

const commandMock = vi.mocked(command);
let mockLauncher: LauncherContextValue;
let root: Root;
let container: HTMLDivElement;
let mockEffects: "lite" | "full" = "full";
let mockReducedMotion = false;
let mockHighContrast = false;
let mockReducedTransparency = false;
let mockCharacterState = "loading";
const overturePlay = vi.hoisted(() => vi.fn());
const resizeObservers: { callback: ResizeObserverCallback; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = [];
let style: HTMLStyleElement;

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
    reducedMotion: mockReducedMotion,
    reducedTransparency: mockReducedTransparency,
    highContrast: mockHighContrast,
  }),
}));
vi.mock("../../visual/overture/OvertureProvider", () => ({
  useOverture: () => ({
    current: null,
    playing: false,
    reducedMotion: false,
    soundEnabled: false,
    play: overturePlay,
    dismiss: vi.fn(),
  }),
}));
vi.mock("../../components/WorldScene", () => ({
  WorldScene: () => createElement("div", { "data-testid": "world-scene" }),
}));
vi.mock("../../visual/character/CharacterCanvas", () => ({
  CharacterCanvas: ({ paused, deferMs, animation }: { paused: boolean; deferMs?: number; animation?: string }) => createElement("div", {
    "data-testid": "character-canvas", className: "vx-character-canvas", "data-paused": paused,
    "data-defer-ms": deferMs, "data-character-state": mockCharacterState, "data-animation": animation,
  }),
}));
vi.mock("../../visual/glass/GlassSystem", () => ({
  GlassSurface: ({ children, className }: { children: React.ReactNode; className?: string }) => createElement("div", { className }, children),
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
    bootstrapped: true,
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

async function render(props: { returning?: boolean } = {}) {
  const i18n = createLauncherI18n("zh-CN", "zh-CN");
  await i18n.initPromise;
  await act(async () => {
    root.render(createElement(I18nextProvider, { i18n }, createElement(HomePage, props)));
  });
}

async function chooseHomeInstance(id?: string) {
  const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="当前实例"]');
  expect(trigger).not.toBeNull();
  await act(async () => trigger!.click());
  const option = document.querySelector<HTMLElement>(id
    ? `[role="option"][data-instance-id="${id}"]`
    : '[role="option"][data-version-directory]');
  expect(option).not.toBeNull();
  await act(async () => option!.click());
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mockLauncher = fixture();
  mockEffects = "full";
  mockReducedMotion = false;
  mockHighContrast = false;
  mockReducedTransparency = false;
  mockCharacterState = "loading";
  resizeObservers.length = 0;
  vi.stubGlobal("ResizeObserver", class {
    observe = vi.fn();
    disconnect = vi.fn();
    constructor(public callback: ResizeObserverCallback) { resizeObservers.push(this); }
  });
  defaultSkinMock.mockReset();
  defaultSkinMock.mockReturnValue({
    skin: { id: "steve", name: "Steve", dataUrl: "steve.png", model: "classic" },
    loading: false,
    error: "",
    refresh: vi.fn(),
  });
  commandMock.mockReset();
  commandMock.mockResolvedValue(null);
  // jsdom cannot create a GPU/2D canvas. Keep the real progress fallback path.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.getAttribute("role") === "combobox" ? new DOMRect(24, 600, 208, 48) : new DOMRect();
  });
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
  style = document.createElement("style");
  style.textContent = homeStyles;
  document.head.append(style);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  style.remove();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("HomePage", () => {
  it("skips character creation delay and reveal on the first home mount", async () => {
    await render();
    expect(container.querySelector('[data-testid="character-canvas"]')?.getAttribute("data-defer-ms")).toBe("0");
    expect(Number(getComputedStyle(container.querySelector(".vx-home__character-panel")!).opacity || 1)).toBe(1);
  });

  it("defers a returning character and reveals only its non-glass panel after ready", async () => {
    await render({ returning: true });
    const panel = container.querySelector<HTMLElement>(".vx-home__character-panel")!;
    const column = container.querySelector<HTMLElement>(".vx-home__char-col")!;
    expect(container.querySelector('[data-testid="character-canvas"]')?.getAttribute("data-defer-ms")).toBe("280");
    expect(Number(getComputedStyle(panel).opacity || 1)).toBe(0);
    expect(Number(getComputedStyle(column).opacity || 1)).toBe(1);
    mockCharacterState = "ready";
    await render({ returning: true });
    expect(Number(getComputedStyle(panel).opacity || 1)).toBe(1);
    expect(Number(getComputedStyle(container.querySelector(".vx-home__stage")!).opacity || 1)).toBe(1);
  });

  it("keeps transparent-mode character motion independent from the UI fade tier", async () => {
    mockReducedTransparency = true;
    await render({ returning: true });
    expect(container.querySelector('.vx-home')?.getAttribute("data-motion-tier")).toBe("fade");
    expect(container.querySelector('[data-testid="character-canvas"]')?.getAttribute("data-paused")).toBe("false");
    expect(container.querySelector('[data-testid="character-canvas"]')?.getAttribute("data-defer-ms")).toBe("280");
  });

  it.each(["reduced motion", "high contrast"])("uses no character wait or reveal when %s takes priority on a return", async (preference) => {
    mockReducedMotion = preference === "reduced motion";
    mockHighContrast = preference === "high contrast";
    await render({ returning: true });
    expect(Number(getComputedStyle(container.querySelector(".vx-home__character-panel")!).opacity || 1)).toBe(1);
    expect(container.querySelector('[data-testid="character-canvas"]')?.getAttribute("data-paused")).toBe("true");
    expect(container.querySelector('[data-testid="character-canvas"]')?.getAttribute("data-defer-ms")).toBe("0");
  });

  it("publishes the mounted world anchor and republishes after home layout resizing", async () => {
    const anchors: Element[] = [];
    const listener = () => { const anchor = document.querySelector("[data-world-anchor]"); if (anchor) anchors.push(anchor); };
    window.addEventListener("vx:world-anchor", listener);
    try {
      await render();
      expect(anchors).toHaveLength(1);
      expect(anchors[0]).toBe(container.querySelector(".vx-home__feet"));
      const layout = container.querySelector(".vx-home__layout")!;
      const observer = resizeObservers.find((item) => item.observe.mock.calls.some(([target]) => target === layout));
      expect(observer).toBeDefined();
      await act(async () => observer!.callback([{ target: layout } as ResizeObserverEntry], {} as ResizeObserver));
      expect(anchors).toHaveLength(2);
      await act(async () => root.render(null));
      expect(observer!.disconnect).toHaveBeenCalledOnce();
      observer!.callback([{ target: layout } as ResizeObserverEntry], {} as ResizeObserver);
      expect(anchors).toHaveLength(2);
    } finally { window.removeEventListener("vx:world-anchor", listener); }
  });

  it("puts the instance heading before the character and reserves its own animation controls", async () => {
    await render();
    const heading = container.querySelector("h1");
    const character = container.querySelector(".vx-home__char-col")!;
    expect(heading?.textContent).toBe("合成测试世界");
    expect(Boolean(heading!.compareDocumentPosition(character) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(container.querySelector('.vx-home__animation-controls[role="group"]')).not.toBeNull();
    expect(container.querySelector('[role="combobox"][aria-label="动画模式"]')).not.toBeNull();
    expect(container.querySelector(".vx-home__greeting-line")).toBeNull();
  });
  it("republishes the feet anchor when recent instances change the character row", async () => {
    const anchors: Element[] = [];
    const listener = () => { const anchor = document.querySelector("[data-world-anchor]"); if (anchor) anchors.push(anchor); };
    window.addEventListener("vx:world-anchor", listener);
    try {
      await render();
      mockLauncher.data.instances.push({ ...mockLauncher.data.instances[0], id: "second", name: "Second" });
      await render();
      expect(anchors).toHaveLength(2);
      expect(anchors[1]).toBe(container.querySelector(".vx-home__feet"));
    } finally { window.removeEventListener("vx:world-anchor", listener); }
  });
  it("offers one shared animation selector with three real pose choices", async () => {
    await render();
    const selector = container.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="动画模式"]')!;
    expect(selector).not.toBeNull();
    await act(async () => selector.click());
    const list = document.querySelector('[role="listbox"][aria-label="动画模式"]')!;
    expect([...list.querySelectorAll('[role="option"]')].map(option => option.getAttribute("data-value"))).toEqual(["idle", "walk", "run"]);
    await act(async () => list.querySelector<HTMLElement>('[data-value="run"]')!.click());
    expect(selector.textContent).toContain("奔跑");
    mockLauncher.busy = "game.prepare"; await render();
    expect(selector.disabled).toBe(true); expect(selector.textContent).toContain("行走");
  });

  it("honors system reduced motion even when full effects are selected", async () => {
    mockReducedMotion = true;
    await render();
    expect(container.querySelector('.vx-home')?.getAttribute('data-motion')).toBe('reduced');
    expect(container.querySelector('[data-testid="character-canvas"]')?.getAttribute('data-paused')).toBe('true');
  });

  it("keeps the character static when high contrast takes priority over full effects", async () => {
    mockHighContrast = true;
    await render();
    expect(container.querySelector('.vx-home')?.getAttribute('data-motion')).toBe('reduced');
    expect(container.querySelector('[data-testid="character-canvas"]')?.getAttribute('data-paused')).toBe('true');
  });

  it("puts the real instance and launch action first", async () => {
    await render();
    expect(container.querySelector(".vx-home__console-name")?.textContent).toBe("合成测试世界");
    expect(container.querySelector('[data-testid="character-canvas"]')).not.toBeNull();
    const launch = container.querySelector<HTMLButtonElement>('[data-launch-primary]')!;
    expect(launch.textContent).toContain("启动游戏");
    expect(container.textContent).not.toContain("YOUR NEXT ADVENTURE");
    await act(async () => launch.click());
    expect(mockLauncher.launch).toHaveBeenCalledTimes(1);
  });

  it("shows a real preparation state and cancels it", async () => {
    vi.useFakeTimers();
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
    expect(cancel.disabled).toBe(true);
    await act(async () => cancel.click());
    expect(mockLauncher.cancelPreparation).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(249));
    expect(cancel.disabled).toBe(true);
    await act(async () => cancel.click());
    expect(mockLauncher.cancelPreparation).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(1));
    expect(cancel.disabled).toBe(false);
    await act(async () => cancel.click());
    expect(mockLauncher.cancelPreparation).toHaveBeenCalledTimes(1);
  });

  it("rearms cancellation availability when another preparation starts before the old guard expires", async () => {
    vi.useFakeTimers();
    mockLauncher.busy = "game.prepare";
    await render();
    await act(async () => vi.advanceTimersByTime(100));
    mockLauncher.busy = ""; await render();
    await act(async () => vi.advanceTimersByTime(50));
    mockLauncher.busy = "game.prepare"; await render();
    const cancel = Array.from(container.querySelectorAll("button")).find(button => button.textContent?.includes("取消准备"))!;
    await act(async () => vi.advanceTimersByTime(100));
    expect(cancel.disabled).toBe(true);
    await act(async () => cancel.click());
    expect(mockLauncher.cancelPreparation).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(149));
    expect(cancel.disabled).toBe(true);
    await act(async () => vi.advanceTimersByTime(1));
    expect(cancel.disabled).toBe(false);
    await act(async () => cancel.click());
    expect(mockLauncher.cancelPreparation).toHaveBeenCalledOnce();
    await act(async () => root.render(null));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the same glass action surface throughout preparation and running", async () => {
    await render();
    const surface = container.querySelector(".vx-launch-console__launch");
    expect(surface).not.toBeNull();
    const content = container.querySelector(".vx-launch-console__launch-wrap")!;
    expect(surface!.contains(content.querySelector("button"))).toBe(false);
    expect(getComputedStyle(surface!).height).toBe("56px");
    mockLauncher.busy = "game.prepare";
    await render();
    expect(container.querySelector(".vx-launch-console__launch")).toBe(surface);
    expect(content.textContent).toContain("取消准备");
    expect(surface!.contains(content.querySelector("button"))).toBe(false);
    mockLauncher.busy = ""; mockLauncher.gamePid = 42;
    await render();
    expect(container.querySelector(".vx-launch-console__launch")).toBe(surface);
    expect(content.textContent).toContain("停止");
    expect(surface!.contains(content.querySelector("button"))).toBe(false);
  });

  it("rests the character after a real launch and resumes it after the game ends", async () => {
    vi.useFakeTimers();
    await render();
    mockLauncher.busy = "game.prepare"; await render();
    mockLauncher.busy = ""; mockLauncher.gamePid = 42; await render();
    const character = () => container.querySelector('[data-testid="character-canvas"]')!;
    expect(character().getAttribute("data-animation")).toBe("run");
    await act(async () => vi.advanceTimersByTime(1499));
    expect(character().getAttribute("data-paused")).toBe("false");
    await act(async () => vi.advanceTimersByTime(1));
    expect(character().getAttribute("data-animation")).toBe("idle");
    expect(character().getAttribute("data-paused")).toBe("true");
    mockLauncher.gamePid = undefined; await render();
    expect(character().getAttribute("data-paused")).toBe("false");
  });

  it("does not replay launch feedback or run the character for an already running game", async () => {
    mockLauncher.gamePid = 42;
    await render();
    expect(overturePlay).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="character-canvas"]')?.getAttribute("data-paused")).toBe("true");
    expect(container.querySelector('[data-testid="character-canvas"]')?.getAttribute("data-animation")).toBe("idle");
  });

  it("plays optional launch feedback only after preparation becomes running", async () => {
    await render();
    mockLauncher.busy = "game.prepare"; await render();
    mockLauncher.busy = ""; mockLauncher.gamePid = 42; await render();
    expect(overturePlay).toHaveBeenCalledExactlyOnceWith({ id: "game-launched-42", kind: "game-launched" });
    await render();
    expect(overturePlay).toHaveBeenCalledTimes(1);
  });

  it("hides redundant recent instances when only one exists", async () => {
    await render();
    expect(container.querySelector(".vx-recent")).toBeNull();
  });

  it("keeps account identity accessible without a redundant online preview capsule", async () => {
    await render();
    expect(container.querySelector(".vx-home__preview-source")).toBeNull();
    expect(container.querySelector(".vx-home__character-panel")?.getAttribute("aria-label")).toBe("CyanFixture 的角色预览");
  });

  it("keeps version-directory selection after clearing the instance", async () => {
    await render();
    await chooseHomeInstance();
    mockLauncher.selectedInstance = undefined;
    await render();
    expect(container.querySelector(".vx-home__console-name")?.textContent).toBe("1.21.1");
    expect(container.querySelector('[role="combobox"][aria-label="当前实例"]')?.textContent).toContain("使用版本目录");
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
    expect(container.querySelectorAll('[role="combobox"][aria-label="当前实例"]')).toHaveLength(1);
    await chooseHomeInstance("fixture-second");
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
