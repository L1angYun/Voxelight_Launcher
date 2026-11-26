// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { command, defaults, events, type Config } from "../../lib/launcher";
import { LauncherError } from "../../lib/errors";
import { createLauncherI18n } from "../../i18n";
import { ToastProvider } from "../../components/ui/ToastProvider";
import { LauncherUpdateProvider, UpdateNoticeBridge, useLauncherUpdates, type LauncherUpdates, type UpdateState, type UpdateView } from "./LauncherUpdates";

const commandMock = vi.mocked(command);
const eventsMock = vi.mocked(events);
let launcher: { bootstrapped: boolean; data: { config: Config }; notice: { code: string; kind: string } | null; preparing: boolean; running: unknown[] };
let progress: ((value: { downloaded: number; total: number }) => void) | undefined;
let root: Root;
let container: HTMLDivElement;
let latest: LauncherUpdates;

vi.mock("../../lib/launcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/launcher")>()),
  command: vi.fn(),
  events: vi.fn(),
  desktop: true,
}));
vi.mock("../../app/AppearanceProvider", () => ({ useAppearance: () => ({
  effects: "lite", reducedMotion: true, reducedTransparency: false, highContrast: false,
}) }));
vi.mock("../../app/controller/LauncherProvider", () => ({ useLauncher: () => launcher }));

const newer: UpdateView = {
  currentVersion: "0.6.0",
  latestVersion: "0.7.0",
  status: "newer",
  source: "github",
  releaseUrl: "https://github.com/L1angYun/Voxelight_Launcher/releases/tag/v0.7.0",
  notes: "Synthetic notes",
  installerSize: 1024,
};
const idleState: UpdateState = { currentVersion: "0.6.0", check: null, download: "idle", staged: null, busy: null };

function Probe() {
  latest = useLauncherUpdates();
  return null;
}

async function render(children: ReactNode = null, pollMs = 5) {
  const i18n = createLauncherI18n("en-US", "en-US");
  await i18n.initPromise;
  await act(async () => root.render(createElement(I18nextProvider, { i18n },
    createElement(ToastProvider, null, createElement(LauncherUpdateProvider, { pollMs }, createElement(Probe), children)))));
}

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const calls = (name: string) => commandMock.mock.calls.filter(([called]) => called === name);

function respond(handlers: Record<string, (args?: Record<string, unknown>) => unknown>) {
  commandMock.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
    const handler = handlers[name];
    if (!handler) throw new Error(`unexpected command ${name}`);
    return handler(args) as never;
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  launcher = { bootstrapped: true, data: { config: { ...defaults, checkForUpdates: true, updateSource: "auto" } }, notice: null, preparing: false, running: [] };
  progress = undefined;
  commandMock.mockReset();
  eventsMock.mockReset();
  eventsMock.mockImplementation(async (name, callback) => {
    if (name === "launcher://update-progress") progress = callback as typeof progress;
    return () => {};
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

describe("launcher update session state", () => {
  it("checks once in the background after startup and offers the newer version as a notice", async () => {
    respond({ get_launcher_update_state: () => idleState, check_launcher_update: () => newer });
    const onReview = vi.fn();
    await render(createElement(UpdateNoticeBridge, { onReview }));
    await flush();
    expect(calls("check_launcher_update")).toHaveLength(1);
    expect(latest.status).toEqual({ key: "available", version: "0.7.0" });
    expect(latest.notice?.latestVersion).toBe("0.7.0");
    const toast = document.querySelector(".vx-toast");
    expect(toast?.textContent).toContain("Version 0.7.0 is available");
    expect(toast?.textContent).toContain("Settings → About");
    const view = [...document.querySelectorAll("button")].find((button) => button.textContent === "View update");
    await act(async () => view?.click());
    expect(onReview).toHaveBeenCalledTimes(1);
    expect(latest.notice).toBeNull();
    expect(document.querySelector(".vx-toast")).toBeNull();
    // A later manual check never raises the startup notice again.
    await act(async () => latest.check());
    expect(latest.notice).toBeNull();
    expect(calls("check_launcher_update")).toHaveLength(2);
  });

  it("does not check on startup when the option is off", async () => {
    launcher.data.config.checkForUpdates = false;
    respond({ get_launcher_update_state: () => idleState });
    await render();
    await flush();
    expect(calls("check_launcher_update")).toHaveLength(0);
    expect(latest.status).toEqual({ key: "notChecked" });
  });

  it("waits for the bootstrap before checking", async () => {
    launcher.bootstrapped = false;
    respond({ get_launcher_update_state: () => idleState, check_launcher_update: () => newer });
    await render();
    await flush();
    expect(commandMock).not.toHaveBeenCalled();
  });

  it("restores a check the backend still holds instead of checking again", async () => {
    respond({ get_launcher_update_state: () => ({ ...idleState, check: newer }) });
    await render();
    await flush();
    expect(calls("check_launcher_update")).toHaveLength(0);
    expect(latest.result).toEqual(newer);
    expect(latest.status).toEqual({ key: "available", version: "0.7.0" });
    expect(latest.notice).toBeNull();
  });

  it("follows a download started before a window reload until it ends", async () => {
    let polls = 0;
    respond({
      get_launcher_update_state: () => (++polls < 3 ? { ...idleState, check: newer, download: "downloading" } : { ...idleState, check: newer }),
    });
    await render(null, 1);
    await flush();
    expect(latest.installing || polls >= 3).toBe(true);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(polls).toBeGreaterThanOrEqual(3);
    expect(latest.installing).toBe(false);
    expect(latest.status).toEqual({ key: "available", version: "0.7.0" });
  });

  it("downloads, reports progress, then hands off with the localized helper texts", async () => {
    let finishDownload: () => void = () => {};
    respond({
      get_launcher_update_state: () => ({ ...idleState, check: newer }),
      download_launcher_update: () => new Promise((resolve) => { finishDownload = () => resolve({ version: "0.7.0", fileName: "x", size: 1024 }); }),
      install_launcher_update_and_exit: () => new Promise(() => {}),
    });
    await render();
    await flush();
    let install: Promise<void> | undefined;
    act(() => { install = latest.install(); });
    await flush();
    expect(latest.status).toEqual({ key: "downloading" });
    expect(latest.installing).toBe(true);
    await act(async () => progress?.({ downloaded: 256, total: 1024 }));
    expect(latest.progress).toBe(0.25);
    await act(async () => finishDownload());
    await flush();
    expect(latest.status).toEqual({ key: "preparing" });
    const [, args] = calls("install_launcher_update_and_exit")[0];
    expect(args).toEqual({
      errorText: "The update did not complete. Reopen Voxelight to retry, or download the installer from the release page.",
      logsText: "Failure diagnostic logs:",
    });
    expect(install).toBeDefined();
  });

  it("reports a cancelled download, a failed download and a refused install apart", async () => {
    const outcomes: unknown[] = [
      new LauncherError("update.cancelled"),
      new LauncherError("update.downloadFailed", {}, "detail"),
      "ok",
    ];
    respond({
      get_launcher_update_state: () => ({ ...idleState, check: newer }),
      download_launcher_update: () => {
        const next = outcomes.shift();
        if (next instanceof LauncherError) throw next;
        return { version: "0.7.0", fileName: "x", size: 1024 };
      },
      install_launcher_update_and_exit: () => { throw new LauncherError("update.gameRunning"); },
      cancel_launcher_update: () => undefined,
    });
    await render();
    await flush();
    await act(async () => latest.install());
    expect(latest.status).toEqual({ key: "cancelled" });
    await act(async () => latest.install());
    expect(latest.status).toMatchObject({ key: "downloadFailed", error: { code: "update.downloadFailed" } });
    await act(async () => latest.install());
    expect(latest.status).toMatchObject({ key: "installFailed", error: { code: "update.gameRunning" } });
    expect(latest.installing).toBe(false);
    act(() => latest.cancel());
    expect(calls("cancel_launcher_update")).toHaveLength(1);
  });

  it("refuses to install without a newer release that has an installer, and clears the result on a source change", async () => {
    respond({ get_launcher_update_state: () => ({ ...idleState, check: { ...newer, installerSize: null } }) });
    await render();
    await flush();
    expect(latest.status).toEqual({ key: "noInstaller", version: "0.7.0" });
    await act(async () => latest.install());
    expect(calls("download_launcher_update")).toHaveLength(0);
    act(() => latest.sourceChanged());
    expect(latest.result).toBeNull();
    expect(latest.status).toEqual({ key: "notChecked" });
  });

  it("keeps a check that fails as a failure with its code", async () => {
    respond({ get_launcher_update_state: () => idleState, check_launcher_update: () => { throw new LauncherError("update.rateLimited"); } });
    await render();
    await flush();
    expect(latest.status).toMatchObject({ key: "failed", error: { code: "update.rateLimited" } });
    expect(latest.result).toBeNull();
    expect(latest.notice).toBeNull();
  });
});

describe("launcher update review fixes", () => {
  it("raises no notice when check on startup is turned off before the startup check ends", async () => {
    let finish: (view: UpdateView) => void = () => {};
    respond({ get_launcher_update_state: () => idleState, check_launcher_update: () => new Promise((resolve) => { finish = resolve; }) });
    await render();
    await flush();
    launcher.data.config = { ...launcher.data.config, checkForUpdates: false };
    await render();
    await act(async () => finish(newer));
    await flush();
    expect(latest.status).toEqual({ key: "available", version: "0.7.0" });
    expect(latest.notice).toBeNull();
  });

  it("a notice dismissed before the startup check ends stays dismissed", async () => {
    let finish: (view: UpdateView) => void = () => {};
    respond({ get_launcher_update_state: () => idleState, check_launcher_update: () => new Promise((resolve) => { finish = resolve; }) });
    await render();
    await flush();
    act(() => latest.dismissNotice());
    await act(async () => finish(newer));
    await flush();
    expect(latest.notice).toBeNull();
  });

  it("a Cancel that arrives while the download finishes stops before the hand-off", async () => {
    let finish: () => void = () => {};
    respond({
      get_launcher_update_state: () => ({ ...idleState, check: newer }),
      download_launcher_update: () => new Promise((resolve) => { finish = () => resolve({ version: "0.7.0", fileName: "x", size: 1024 }); }),
      cancel_launcher_update: () => undefined,
      install_launcher_update_and_exit: () => new Promise(() => {}),
    });
    await render();
    await flush();
    act(() => { void latest.install(); });
    await flush();
    act(() => latest.cancel());
    await act(async () => finish());
    await flush();
    expect(latest.status).toEqual({ key: "cancelled" });
    expect(calls("install_launcher_update_and_exit")).toHaveLength(0);
    expect(latest.installing).toBe(false);
  });

  it("downloads nothing while the install would be refused", async () => {
    respond({
      get_launcher_update_state: () => ({ ...idleState, check: newer, busy: null }),
    });
    await render();
    await flush();
    respond({ get_launcher_update_state: () => ({ ...idleState, check: newer, busy: "update.serverRunning" }) });
    await act(async () => latest.install());
    expect(latest.status).toMatchObject({ key: "blocked", error: { code: "update.serverRunning" } });
    expect(calls("download_launcher_update")).toHaveLength(0);
    expect(latest.installing).toBe(false);
  });

  it("a source saved elsewhere, or a download refused for the source, clears the result", async () => {
    respond({ get_launcher_update_state: () => ({ ...idleState, check: newer }) });
    await render();
    await flush();
    expect(latest.result).toEqual(newer);
    launcher.data.config = { ...launcher.data.config, updateSource: "gitee" };
    await render();
    expect(latest.result).toBeNull();
    expect(latest.status).toEqual({ key: "notChecked" });

    respond({ get_launcher_update_state: () => idleState, check_launcher_update: () => newer });
    await act(async () => latest.check());
    expect(latest.result).toEqual(newer);
    launcher.data.config = { ...launcher.data.config, updateChannel: "beta" };
    await render();
    expect(latest.result).toBeNull();
    expect(latest.status).toEqual({ key: "notChecked" });

    for (const code of ["update.sourceChanged", "update.notOffered"]) {
      respond({
        get_launcher_update_state: () => idleState,
        check_launcher_update: () => newer,
        download_launcher_update: () => { throw new LauncherError(code); },
      });
      await act(async () => latest.check());
      expect(latest.result).toEqual(newer);
      await act(async () => latest.install());
      expect(latest.status).toMatchObject({ key: "downloadFailed", error: { code } });
      expect(latest.result).toBeNull();
    }
  });

  it("a followed operation shows its phase and offers no Cancel once cancelling or installing", async () => {
    let current: UpdateState["download"] = "downloading";
    respond({ get_launcher_update_state: () => ({ ...idleState, check: newer, download: current }) });
    await render(null, 1);
    await flush();
    expect(latest.installing).toBe(true);
    expect(latest.status).toEqual({ key: "downloading" });
    for (const [phase, expected] of [["cancelling", { key: "cancelled" }], ["installing", { key: "preparing" }]] as const) {
      current = phase;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
      expect(latest.status).toEqual(expected);
      expect(latest.installing).toBe(true);
    }
    current = "idle";
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(latest.installing).toBe(false);
    expect(latest.status).toEqual({ key: "available", version: "0.7.0" });
  });

  it("the startup notice waits for a launcher notice and then appears", async () => {
    launcher.notice = { code: "versions.unavailable", kind: "error" };
    respond({ get_launcher_update_state: () => idleState, check_launcher_update: () => newer });
    await render(createElement(UpdateNoticeBridge, { onReview: () => {} }));
    await flush();
    expect(latest.notice?.latestVersion).toBe("0.7.0");
    expect(document.querySelector(".vx-toast")).toBeNull();
    launcher.notice = null;
    await render(createElement(UpdateNoticeBridge, { onReview: () => {} }));
    await flush();
    expect(document.querySelector(".vx-toast")?.textContent).toContain("Version 0.7.0 is available");
  });
});

describe("launcher update notices", () => {
  it("a manual check that finds a newer version raises no startup notice", async () => {
    const current: UpdateView = { ...newer, status: "current", latestVersion: "0.6.0", installerSize: null };
    let next = current;
    respond({ get_launcher_update_state: () => idleState, check_launcher_update: () => next });
    await render(createElement(UpdateNoticeBridge, { onReview: () => {} }));
    await flush();
    expect(latest.status).toEqual({ key: "current", version: "0.6.0" });
    next = newer;
    await act(async () => latest.check());
    expect(latest.status).toEqual({ key: "available", version: "0.7.0" });
    expect(latest.notice).toBeNull();
    expect(document.querySelector(".vx-toast")).toBeNull();
  });
});
