// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
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
    if (name === "reserve_launch_task") return "reserved-fixture-task";
    if (name === "launch_game") return { pid: 12345 };
    if (name === "save_config") return args?.config as Config;
    if (name === "cancel_download_task" || name === "set_download_paused") return { revision: 0, tasks: [] };
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
  it("ignores the cancelled initial failure after StrictMode's active bootstrap succeeds", async () => {
    const normal = commandMock.getMockImplementation()!;
    let reject!: (reason: Error) => void;
    let calls = 0;
    commandMock.mockImplementation(async (name, args) => {
      if (name === "bootstrap" && ++calls === 1) return new Promise((_resolve, fail) => { reject = fail; });
      return normal(name, args);
    });
    await act(async () => root.render(createElement(StrictMode, null, createElement(LauncherProvider, null, createElement(Harness)))));
    expect(current.bootstrapped).toBe(true);
    await act(async () => reject(new Error("obsolete initial error")));
    expect(current.bootstrapFailed).toBe(false);
  });
  it("ignores a stale successful bootstrap after current StrictMode data arrives", async () => {
    const normal = commandMock.getMockImplementation()!;
    let resolveOld!: (data: Bootstrap) => void;
    let calls = 0;
    commandMock.mockImplementation(async (name, args) => {
      if (name === "bootstrap" && ++calls === 1) return new Promise((resolve) => { resolveOld = resolve; });
      return normal(name, args);
    });
    bootstrap.config = { ...defaults, theme: "dark" };
    await act(async () => root.render(createElement(StrictMode, null, createElement(LauncherProvider, null, createElement(Harness)))));
    expect(current.config.theme).toBe("dark");
    await act(async () => resolveOld({ ...bootstrap, config: { ...defaults, theme: "light" }, accounts: [] }));
    expect(current.config.theme).toBe("dark");
    expect(current.data.accounts).toHaveLength(1);
  });

  it("reloads saved data without clobbering an in-progress appearance preview", async () => {
    bootstrap.config = { ...defaults, theme: "dark", maxMemoryMb: 4096 };
    await render();
    await act(async () => current.setConfig({ ...current.config, theme: "light" }));
    bootstrap = { ...bootstrap, config: { ...bootstrap.config, maxMemoryMb: 16384 } };
    await act(async () => current.reload());
    expect(current.data.config.maxMemoryMb).toBe(16384);
    expect(current.config.theme).toBe("light");
    expect(current.config.maxMemoryMb).toBe(16384);
  });

  it("publishes a completed save even when a pre-save Bootstrap response arrives afterwards", async () => {
    await render();
    const normal = commandMock.getMockImplementation()!;
    let resolveOld!: (data: Bootstrap) => void;
    commandMock.mockImplementation(async (name,args) => name === "bootstrap"
      ? new Promise((resolve) => { resolveOld = resolve; }) : normal(name,args));
    let reload!: Promise<void>;
    await act(async () => { reload = current.reload(); });
    const revised = { ...current.config, theme: "light" as const };
    await act(async () => current.saveConfig(revised));
    await act(async () => { resolveOld(bootstrap); await reload; });
    expect(current.data.config.theme).toBe("light");
    expect(current.config.theme).toBe("light");
  });

  it("uses the explicit appearance-only IPC while another operation owns the global lock", async () => {
    const normal = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => {
      if (name === "save_appearance_config") return Object.assign({}, bootstrap.config, args?.patch);
      if (name === "save_config") throw new LauncherError("config.busy");
      return normal(name, args);
    });
    await render();
    const candidate = { ...current.config, theme: "light" as const };
    await act(async () => {
      await expect(current.saveConfig(candidate, { theme: "light" })).resolves.toBe(true);
    });
    expect(commandMock).toHaveBeenCalledWith("save_appearance_config", { patch: { theme: "light" } });
    expect(commandMock.mock.calls.some(([name]) => name === "save_config")).toBe(false);
    expect(current.data.config.theme).toBe("light");
  });

  it("exposes a retryable initial bootstrap failure without treating a later reload failure as boot failure", async () => {
    const normal = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => {
      if (name === "bootstrap") throw new Error("offline");
      return normal(name, args);
    });
    await render();
    expect(current.bootstrapped).toBe(false);
    expect(current.bootstrapFailed).toBe(true);
    commandMock.mockImplementation(normal);
    await act(async () => { await current.reload(); });
    expect(current.bootstrapped).toBe(true);
    expect(current.bootstrapFailed).toBe(false);
    commandMock.mockImplementation(async (name, args) => {
      if (name === "bootstrap") throw new Error("offline again");
      return normal(name, args);
    });
    await act(async () => { await expect(current.reload()).rejects.toThrow("offline again"); });
    expect(current.bootstrapped).toBe(true);
    expect(current.bootstrapFailed).toBe(false);
  });

  it("waits for the actual bootstrap config even for an empty library, and stays ready during later reloads", async () => {
    let resolve!: (value: Bootstrap) => void;
    let pending = new Promise<Bootstrap>(done => { resolve = done; });
    commandMock.mockImplementation(async name => name === "bootstrap" ? pending : name === "list_running_games" ? [] : null);
    bootstrap = { ...bootstrap, accounts: [], instances: [], installedVersions: [], config: { ...defaults, effects: "lite" } };
    await render();
    expect(current.bootstrapped).toBe(false);
    await act(async () => resolve(bootstrap));
    expect(current.bootstrapped).toBe(true);
    expect(current.config.effects).toBe("lite");
    expect(current.data.instances).toEqual([]);
    pending = new Promise<Bootstrap>(done => { resolve = done; });
    let reloading!: Promise<void>;
    await act(async () => { reloading = current.reload(); });
    expect(current.bootstrapped).toBe(true);
    await act(async () => { resolve(bootstrap); await reloading; });
    expect(current.bootstrapped).toBe(true);
  });

  it("does not mark a failed initial bootstrap as loaded defaults", async () => {
    commandMock.mockImplementation(async name => {
      if (name === "bootstrap") throw new LauncherError("desktop.required");
      return name === "list_running_games" ? [] : null;
    });
    await render();
    expect(current.bootstrapped).toBe(false);
    expect(current.notice?.code).toBe("desktop.required");
  });

  it("cancels the exact launch reservation before a delayed reservation can start anything", async () => {
    const normal = commandMock.getMockImplementation()!;
    let reserve!: (id: string) => void;
    const reservation = new Promise<string>(resolve => { reserve = resolve; });
    commandMock.mockImplementation(async (name, args) => name === "reserve_launch_task" ? reservation : normal(name, args));
    await render();
    act(() => current.selectInstance("fixture-world"));
    let launching!: Promise<void>;
    let cancelling!: Promise<void>;
    await act(async () => { launching = current.launch(); });
    await act(async () => { cancelling = current.cancelPreparation(); });
    await act(async () => { reserve("reserved-world-29"); await Promise.all([launching, cancelling]); });
    expect(commandMock).toHaveBeenCalledWith("cancel_download_task", { taskId: "reserved-world-29" });
    expect(commandMock).not.toHaveBeenCalledWith("cancel_download_task", { taskId: null });
    expect(commandMock.mock.calls.some(([name]) => name === "launch_game" || name === "set_download_paused")).toBe(false);
  });

  it("owns launch preparation and exact cancellation while another install owns the busy message", async () => {
    const normal = commandMock.getMockImplementation()!;
    let finishInstall!: () => void;
    const installResult = new Promise<void>(resolve => { finishInstall = resolve; });
    let finishLaunch!: (reason: LauncherError) => void;
    const launchResult = new Promise<never>((_resolve, reject) => { finishLaunch = reject; });
    commandMock.mockImplementation(async (name, args) => {
      if (name === "reserve_launch_task") return "launch-while-installing";
      if (name === "launch_game") return launchResult;
      return normal(name, args);
    });
    await render();
    let installing!: Promise<unknown>;
    let launching!: Promise<void>;
    await act(async () => { installing = current.run("instance.install", () => installResult); });
    await act(async () => { launching = current.launch(); });
    const wasPreparing = current.preparing;
    const competingBusy = current.busy;
    await act(async () => current.cancelPreparation());
    const didCancelLaunch = commandMock.mock.calls.some(([name, args]) => name === "cancel_download_task" && args?.taskId === "launch-while-installing");
    await act(async () => { finishLaunch(new LauncherError("download.cancelled")); await launching; });
    expect(wasPreparing).toBe(true);
    expect(competingBusy).toBe("instance.install");
    expect(didCancelLaunch).toBe(true);
    expect(current.preparing).toBe(false);
    expect(current.notice?.kind).not.toBe("error");
    await act(async () => { finishInstall(); await installing; });
  });

  it("ignores another operation's progress even when it targets the same version", async () => {
    const normal = commandMock.getMockImplementation()!;
    let finish!: (pid: { pid: number }) => void;
    const launchResult = new Promise<{ pid: number }>(resolve => { finish = resolve; });
    commandMock.mockImplementation(async (name, args) => {
      if (name === "reserve_launch_task") return "owned-launch-33";
      if (name === "launch_game") return launchResult;
      return normal(name, args);
    });
    await render();
    let launching!: Promise<void>;
    await act(async () => { launching = current.launch(); });
    const delivered = { versionId: "1.21.1", stage: "assets", total: 100, bytesCompleted: 0, bytesTotal: 0, message: "fixture progress" };
    await act(async () => listeners.get("launcher://progress")?.({ ...delivered, taskId: "owned-launch-33", operation: "launch", completed: 37 }));
    expect(current.progress?.completed).toBe(37);
    await act(async () => listeners.get("launcher://progress")?.({ ...delivered, taskId: "separate-install-51", operation: "install", completed: 82 }));
    expect(current.progress?.completed).toBe(37);
    await act(async () => { finish({ pid: 12345 }); await launching; });
    await act(async () => listeners.get("launcher://progress")?.({ ...delivered, taskId: "owned-launch-33", operation: "launch", completed: 100 }));
    expect(current.progress).toBeNull();
  });

  it("launches the selected instance using its reservation and ignores cancellation after it starts", async () => {
    await render();
    act(() => current.selectInstance("fixture-world"));
    expect(current.selectedInstance?.id).toBe("fixture-world");
    await act(async () => current.launch());
    expect(commandMock).toHaveBeenCalledWith("reserve_launch_task", { versionId: "1.21.1", instanceId: "fixture-world" });
    expect(commandMock).toHaveBeenCalledWith("launch_game", {
      versionId: "1.21.1",
      instanceId: "fixture-world",
      accountId: "fixture-classic",
      taskId: "reserved-fixture-task",
    });
    await act(async () => current.cancelPreparation());
    expect(commandMock.mock.calls.some(([name]) => name === "cancel_download_task" || name === "set_download_paused")).toBe(false);
    expect(current.busy).toBe("");
  });

  it("releases only its queued reservation if launch IPC fails before entering the handler", async () => {
    const normal = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => {
      if (name === "reserve_launch_task") return "aborted-launch-fixture";
      if (name === "launch_game") throw new LauncherError("desktop.required");
      if (name === "cancel_download_task") throw new LauncherError("download.notFound");
      return normal(name, args);
    });
    await render();
    await act(async () => current.launch());
    expect(commandMock.mock.calls.filter(([name]) => name === "cancel_download_task")).toEqual([
      ["cancel_download_task", { taskId: "aborted-launch-fixture" }],
    ]);
    expect(current.notice?.code).toBe("desktop.required");
    expect(current.preparing).toBe(false);
  });

  it("passes a direct multiplayer address to the native launch boundary", async () => {
    await render();
    await act(async () => current.launchMultiplayer("1.21.1", "play.example.invalid:25565"));
    expect(commandMock).toHaveBeenCalledWith("launch_game", {
      versionId: "1.21.1",
      accountId: "fixture-classic",
      serverAddress: "play.example.invalid:25565",
      taskId: "reserved-fixture-task",
    });
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
      if (name === "reserve_launch_task") return "reserved-busy-fixture";
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
