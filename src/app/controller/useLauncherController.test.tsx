// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  command,
  defaults,
  events,
  type Bootstrap,
  type Config,
  type RunningGame,
} from "../../lib/launcher";
import { LauncherError } from "../../lib/errors";
import { LauncherProvider, useLauncher } from "./LauncherProvider";
import type { LauncherContextValue } from "./types";

vi.mock("../../lib/launcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/launcher")>()),
  command: vi.fn(),
  events: vi.fn(),
}));

vi.mock("../../lib/accountSkin", () => ({
  useAccountSkin: () => ({
    profile: null,
    skinUrl: undefined,
    model: "auto",
    capeUrl: undefined,
    hasAccountSkin: false,
    loading: false,
    error: "",
    refresh: vi.fn(),
    setProfile: vi.fn(),
  }),
}));

const commandMock = vi.mocked(command);
const eventsMock = vi.mocked(events);
const listeners = new Map<string, (value: unknown) => void>();
let container: HTMLDivElement;
let root: Root;
let current: LauncherContextValue;
let bootstrap: Bootstrap;

function fixtureBootstrap(): Bootstrap {
  return {
    config: { ...defaults },
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
}

function Harness() {
  current = useLauncher();
  return null;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function render() {
  await act(async () => {
    root.render(createElement(LauncherProvider, null, createElement(Harness)));
  });
  await flush();
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  bootstrap = fixtureBootstrap();
  listeners.clear();
  commandMock.mockImplementation(async (name, args) => {
    if (name === "bootstrap") return bootstrap;
    if (name === "list_versions")
      return { latestRelease: "1.21.1", latestSnapshot: "", versions: [] };
    if (name === "list_running_games") return [];
    if (name === "launch_game") return { pid: 12345 };
    if (name === "save_config") return args?.config as Config;
    if (name === "cancel_download_task" || name === "set_download_paused") return [];
    return null;
  });
  eventsMock.mockImplementation((name, callback) => {
    listeners.set(name, callback);
    return Promise.resolve(() => listeners.delete(name));
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("launcher controller", () => {
  it("launches the selected instance and cancels preparation with existing IPC arguments", async () => {
    await render();
    act(() => current.selectInstance("fixture-world"));
    expect(current.selectedInstance?.id).toBe("fixture-world");
    await act(async () => current.launch());
    expect(commandMock).toHaveBeenCalledWith("launch_game", {
      versionId: "1.21.1",
      instanceId: "fixture-world",
      accountId: "fixture-classic",
    });
    await act(async () => current.cancelPreparation());
    expect(commandMock).toHaveBeenCalledWith("cancel_download_task", { taskId: null });
    expect(commandMock).toHaveBeenCalledWith("set_download_paused", { paused: false });
    expect(current.busy).toBe("");
  });

  it("passes a direct multiplayer address to the native launch boundary", async () => {
    await render();
    await act(async () => current.launchMultiplayer("1.21.1", "play.example.invalid:25565"));
    expect(commandMock).toHaveBeenCalledWith("launch_game", {
      versionId: "1.21.1",
      accountId: "fixture-classic",
      serverAddress: "play.example.invalid:25565",
    });
  });

  it("clears preparation progress after the game process starts", async () => {
    await render();
    act(() => listeners.get("launcher://progress")?.({
      operation: "launch",
      stage: "assets",
      completed: 37,
      total: 100,
      bytesCompleted: 37,
      bytesTotal: 100,
      message: "fixture progress",
      versionId: "1.21.1",
    }));
    expect(current.progress?.completed).toBe(37);
    await act(async () => current.launch());
    expect(current.progress).toBeNull();
  });

  it("reports whether an explicit settings save succeeded", async () => {
    await render();
    await act(async () => {
      await expect(current.saveConfig(current.config)).resolves.toBe(true);
    });
  });

  it("reconciles selection after the selected instance disappears", async () => {
    await render();
    act(() => current.selectInstance("fixture-world"));
    bootstrap.instances = [];
    await act(async () => current.reload());
    expect(current.selectedInstance).toBeUndefined();
    expect(current.selectedVersionId).toBe("1.21.1");
  });

  it("applies running events and exposes normalized busy errors", async () => {
    await render();
    const running: RunningGame = {
      pid: 99,
      versionId: "1.21.1",
      instanceId: "fixture-world",
      gameDirectory: "C:\\SyntheticFixture\\world",
      startedAt: "2026-10-26T00:00:00Z",
    };
    act(() => listeners.get("launcher://games")?.([running]));
    expect(current.running).toEqual([running]);
    commandMock.mockImplementation(async (name) => {
      if (name === "launch_game") throw new LauncherError("instance.running", {}, "实例正在运行");
      if (name === "bootstrap") return bootstrap;
      if (name === "list_versions") return { latestRelease: "1.21.1", versions: [] };
      return null;
    });
    await act(async () => current.launch());
    expect(current.busy).toBe("");
    expect(current.notice?.code).toBe("instance.running");
    expect(current.notice?.error).toBeInstanceOf(LauncherError);
  });

  it("saves config through the same command and updates the shared snapshot", async () => {
    await render();
    const next = { ...current.config, effects: "lite" as const };
    await act(async () => current.saveConfig(next));
    expect(commandMock).toHaveBeenCalledWith("save_config", { config: next });
    expect(current.config.effects).toBe("lite");
    expect(current.data.config.effects).toBe("lite");
  });

  it("unsubscribes all native events on unmount", async () => {
    await render();
    expect(listeners.size).toBeGreaterThan(0);
    await act(async () => root.unmount());
    await flush();
    expect(listeners.size).toBe(0);
    root = createRoot(container);
  });
});
