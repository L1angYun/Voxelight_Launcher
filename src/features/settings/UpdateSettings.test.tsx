// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { command, defaults, events, type Config } from "../../lib/launcher";
import { LauncherError } from "../../lib/errors";
import { createLauncherI18n } from "../../i18n";
import { LauncherUpdateProvider, type UpdateState, type UpdateView } from "../updates/LauncherUpdates";
import { UpdateSettings } from "./UpdateSettings";

const mocks = vi.hoisted(() => ({ openUrl: vi.fn() }));
const commandMock = vi.mocked(command);
let launcher: { bootstrapped: boolean; data: { config: Config }; running: unknown[]; notice: null; preparing: boolean };
let config: Config;
let root: Root;
let container: HTMLDivElement;
const onPersistedPatch = vi.fn(async (patch: Partial<Config>) => { config = { ...config, ...patch }; });
const onError = vi.fn();

vi.mock("../../lib/launcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/launcher")>()),
  command: vi.fn(),
  events: vi.fn(async () => () => {}),
  desktop: true,
}));
vi.mock("../../app/AppearanceProvider", () => ({ useAppearance: () => ({
  effects: "lite", reducedMotion: true, reducedTransparency: false, highContrast: false,
}) }));
vi.mock("../../app/controller/LauncherProvider", () => ({ useLauncher: () => launcher }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));
vi.mock("../../visual/glass/GlassSystem", () => ({
  GlassSurface: ({ children, className }: { children: React.ReactNode; className?: string }) => createElement("div", { className }, children),
}));

const newer: UpdateView = {
  currentVersion: "0.6.0",
  latestVersion: "0.7.0",
  status: "newer",
  source: "gitee",
  releaseUrl: "https://gitee.com/liangyun_Liu/Voxelight_Launcher/releases/tag/v0.7.0",
  notes: "Synthetic notes for 0.7.0",
  installerSize: 2048,
};
let state: UpdateState;
let handlers: Record<string, (args?: Record<string, unknown>) => unknown>;

async function render(focusRequest = 0) {
  const i18n = createLauncherI18n("en-US", "en-US");
  await i18n.initPromise;
  const tree = () => createElement(I18nextProvider, { i18n }, createElement(LauncherUpdateProvider, null,
    createElement(UpdateSettings, { config, onPersistedPatch, onError, focusRequest })));
  await act(async () => root.render(tree()));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return async (next = focusRequest) => {
    await act(async () => root.render(createElement(I18nextProvider, { i18n }, createElement(LauncherUpdateProvider, null,
      createElement(UpdateSettings, { config, onPersistedPatch, onError, focusRequest: next })))));
  };
}

const text = () => container.textContent ?? "";
const status = () => container.querySelector('[data-testid="launcher-update-status"]')?.textContent;
function button(label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label);
}
async function click(label: string) {
  const target = button(label);
  if (!target) throw new Error(`Missing button: ${label}`);
  await act(async () => target.click());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

beforeEach(() => {
  // The listbox closes when its trigger is off screen; jsdom lays nothing out.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.getAttribute("role") === "combobox" ? new DOMRect(24, 200, 320, 44) : new DOMRect();
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  config = { ...defaults, checkForUpdates: false, updateSource: "auto" };
  launcher = { bootstrapped: true, data: { config }, running: [], notice: null, preparing: false };
  state = { currentVersion: "0.6.0", check: null, download: "idle", staged: null, busy: null };
  handlers = {
    get_launcher_update_state: () => state,
    check_launcher_update: () => newer,
    set_launcher_update_preferences: (args) => ({ ...config, ...args }),
  };
  commandMock.mockReset();
  commandMock.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
    const handler = handlers[name];
    if (!handler) throw new Error(`unexpected command ${name}`);
    return handler(args) as never;
  });
  vi.mocked(events).mockImplementation(async () => () => {});
  mocks.openUrl.mockReset();
  onPersistedPatch.mockClear();
  onError.mockClear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("Settings → About → Updates", () => {
  it("shows the installed version and checks on request", async () => {
    await render();
    expect(status()).toBe("Updates have not been checked.");
    expect(button("Download and update")).toBeUndefined();
    await click("Check for updates");
    expect(status()).toBe("Version 0.7.0 is available.");
    expect(button("Download and update")?.disabled).toBe(false);
    expect(text()).toContain("Release notes for 0.7.0");
    expect(text()).toContain("Synthetic notes for 0.7.0");
  });

  it("opens the release page of the source that answered and reports a refusal", async () => {
    await render();
    await click("Check for updates");
    await click("Open release notes");
    expect(mocks.openUrl).toHaveBeenCalledWith(newer.releaseUrl);
    mocks.openUrl.mockRejectedValueOnce(new Error("Synthetic opener refusal"));
    await click("Open release notes");
    expect(text()).toContain("Could not open the release page. Try again.");
    expect(text()).not.toContain("Synthetic opener refusal");
  });

  it("waits for the game to exit before offering the install", async () => {
    launcher.running = [{ pid: 1 }];
    await render();
    await click("Check for updates");
    expect(button("Download and update")?.disabled).toBe(true);
    expect(text()).toContain("Quit the game to install the update.");
  });

  it("saves the startup check at once and keeps the result", async () => {
    await render();
    await click("Check for updates");
    const toggle = container.querySelector<HTMLInputElement>('input[aria-label="Check for updates on startup"]');
    await act(async () => toggle?.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(commandMock).toHaveBeenCalledWith("set_launcher_update_preferences", { checkForUpdates: true, updateSource: "auto" });
    expect(onPersistedPatch).toHaveBeenCalledWith({ checkForUpdates: true, updateSource: "auto" });
    expect(status()).toBe("Version 0.7.0 is available.");
  });

  it("a new source is saved at once and clears the previous result", async () => {
    const rerender = await render();
    await click("Check for updates");
    const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Update source"]');
    await act(async () => trigger?.click());
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"][data-value="gitee"]')].find((item) => !item.closest('[aria-hidden="true"]'));
    await act(async () => option?.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(commandMock).toHaveBeenCalledWith("set_launcher_update_preferences", { checkForUpdates: false, updateSource: "gitee" });
    expect(onPersistedPatch).toHaveBeenCalledWith({ checkForUpdates: false, updateSource: "gitee" });
    expect(status()).toBe("Updates have not been checked.");
    await rerender();
    expect(button("Download and update")).toBeUndefined();
  });

  it("reports a refused preference change through the page", async () => {
    handlers.set_launcher_update_preferences = () => { throw new LauncherError("update.downloading"); };
    await render();
    const toggle = container.querySelector<HTMLInputElement>('input[aria-label="Check for updates on startup"]');
    await act(async () => toggle?.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "update.downloading" }));
    expect(onPersistedPatch).not.toHaveBeenCalled();
  });

  it("names the rate limit and the timeout, and keeps other check failures generic", async () => {
    await render();
    for (const [code, expected] of [
      ["update.rateLimited", "GitHub's request limit was reached and fallback update information is unavailable. Try again later."],
      ["update.timedOut", "The update check timed out. Try again or choose another update source."],
      ["update.checkFailed", "Could not check for updates. Try again or choose another update source."],
      ["internal.unexpected", "Could not check for updates. Try again or choose another update source."],
    ]) {
      handlers.check_launcher_update = () => { throw new LauncherError(code, {}, "synthetic detail"); };
      await click("Check for updates");
      expect(status()).toBe(expected);
      expect(container.querySelector('[data-testid="launcher-update-status"]')?.getAttribute("role")).toBe("alert");
    }
  });

  it("shows why a download or an install was refused and offers a retry", async () => {
    await render();
    await click("Check for updates");
    handlers.download_launcher_update = () => { throw new LauncherError("update.downloadFailed", {}, "安装包的大小或 SHA-256 校验失败"); };
    await click("Download and update");
    expect(status()).toBe("The installer could not be downloaded or verified. Try again or download it from the release page.");
    handlers.download_launcher_update = () => { throw new LauncherError("update.sourceChanged"); };
    await click("Retry update");
    expect(status()).toBe("The update source changed. Check for updates again.");
    expect(button("Retry update")).toBeUndefined();
    expect(button("Download and update")).toBeUndefined();
    await click("Check for updates");
    handlers.download_launcher_update = () => ({ version: "0.7.0", fileName: "x", size: 2048 });
    handlers.install_launcher_update_and_exit = () => { throw new LauncherError("update.serverRunning"); };
    await click("Download and update");
    expect(status()).toContain("managed server");
    handlers.install_launcher_update_and_exit = () => { throw new LauncherError("update.handOffFailed"); };
    await click("Retry update");
    expect(status()).toContain("Nothing was changed");
  });

  it("offers cancel while downloading", async () => {
    let finish: (value: unknown) => void = () => {};
    handlers.download_launcher_update = () => new Promise((resolve) => { finish = resolve; });
    handlers.cancel_launcher_update = () => undefined;
    await render();
    await click("Check for updates");
    await click("Download and update");
    expect(status()).toBe("Downloading installer… 0%");
    expect(button("Check for updates")?.disabled).toBe(true);
    expect(container.querySelector('[role="progressbar"]')).not.toBeNull();
    await click("Cancel update");
    expect(commandMock).toHaveBeenCalledWith("cancel_launcher_update");
    // The download still ends Ok (the cancel came too late for the backend): no hand-off follows.
    handlers.install_launcher_update_and_exit = vi.fn();
    await act(async () => finish({ version: "0.7.0", fileName: "x", size: 2048 }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(status()).toBe("Update cancelled.");
    expect(handlers.install_launcher_update_and_exit).not.toHaveBeenCalled();
    expect(button("Download and update")?.disabled).toBe(false);
  });

  it("the startup notice's review request focuses the install action", async () => {
    state = { ...state, check: newer };
    const rerender = await render();
    expect(document.activeElement).not.toBe(button("Download and update"));
    await rerender(1);
    expect(document.activeElement).toBe(button("Download and update"));
  });

  it("with nothing to install the review request focuses the check action", async () => {
    state = { ...state, check: { ...newer, status: "current", latestVersion: "0.6.0" } };
    const rerender = await render();
    await rerender(2);
    expect(document.activeElement).toBe(button("Check for updates"));
  });
});

describe("Settings → About → Updates after review", () => {
  it("names a proxy failure instead of suggesting another source", async () => {
    await render();
    handlers.check_launcher_update = () => { throw new LauncherError("proxy.authentication"); };
    await click("Check for updates");
    expect(status()).toBe("The proxy requires valid credentials. Save them and try again.");
  });

  it("downloads nothing and says why when the install would be refused", async () => {
    await render();
    await click("Check for updates");
    handlers.get_launcher_update_state = () => ({ ...state, busy: "update.serverRunning" });
    handlers.download_launcher_update = vi.fn();
    await click("Download and update");
    expect(status()).toContain("managed server");
    expect(handlers.download_launcher_update).not.toHaveBeenCalled();
    expect(button("Download and update")?.disabled).toBe(false);
  });

  it("clears the result as soon as a new source is saved, even if the page reload fails", async () => {
    onPersistedPatch.mockImplementationOnce(async () => { throw new Error("Synthetic reload failure"); });
    await render();
    await click("Check for updates");
    const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Update source"]');
    await act(async () => trigger?.click());
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"][data-value="github"]')].find((item) => !item.closest('[aria-hidden="true"]'));
    await act(async () => option?.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(onError).toHaveBeenCalled();
    expect(status()).toBe("Updates have not been checked.");
    expect(button("Download and update")).toBeUndefined();
  });

  it("reports the review focus as handled so it is not repeated", async () => {
    state = { ...state, check: newer };
    const handled = vi.fn();
    const i18n = createLauncherI18n("en-US", "en-US");
    await i18n.initPromise;
    await act(async () => root.render(createElement(I18nextProvider, { i18n }, createElement(LauncherUpdateProvider, null,
      createElement(UpdateSettings, { config, onPersistedPatch, onError, focusRequest: 1, onFocusHandled: handled })))));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(handled).toHaveBeenCalled();
  });
});
