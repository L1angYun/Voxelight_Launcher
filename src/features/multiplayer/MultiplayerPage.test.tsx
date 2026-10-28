// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { GlassProvider } from "../../visual/glass/GlassSystem";
import { command, defaults, events, type Account, type Bootstrap } from "../../lib/launcher";
import type { LauncherContextValue } from "../../app/controller/types";
import { createLauncherI18n } from "../../i18n";
import { MultiplayerPage } from "./MultiplayerPage";
import type { ManagedServer, ServerEntry } from "./useMultiplayer";

const mocks = vi.hoisted(() => ({ openUrl: vi.fn() }));
const commandMock = vi.mocked(command);
const eventsMock = vi.mocked(events);
const listeners = new Map<string, (value: unknown) => void>();
let mockLauncher: LauncherContextValue;
let root: Root;
let container: HTMLDivElement;
let servers: ServerEntry[];
let managed: ManagedServer;

vi.mock("../../lib/launcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/launcher")>()),
  command: vi.fn(),
  events: vi.fn(),
  desktop: true,
}));
vi.mock("../../app/controller/LauncherProvider", () => ({
  useLauncher: () => mockLauncher,
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));

const account: Account = {
  id: "fixture-account",
  username: "Fixture",
  uuid: "11111111111111111111111111111111",
  type: "microsoft",
  isSelected: true,
};

function managedFixture(): ManagedServer {
  return {
    id: "fixture-server",
    name: "Synthetic server",
    versionId: "1.21.1",
    createdAt: "2026-01-01T00:00:00Z",
    directory: "C:\\SyntheticFixture\\server",
    settings: {
      port: 25565,
      maxPlayers: 20,
      onlineMode: true,
      whitelist: false,
      motd: "Synthetic MOTD",
      difficulty: "normal",
      gamemode: "survival",
      viewDistance: 10,
      maxMemoryMb: 2048,
      bindAddress: "",
    },
    eulaAccepted: false,
    eulaUrl: "https://aka.ms/MinecraftEULA",
    installed: true,
    status: "stopped",
    pid: null,
    exitCode: null,
    error: null,
    javaMajor: 21,
  };
}

function fixture(): LauncherContextValue {
  const data: Bootstrap = {
    config: { ...defaults },
    accounts: [account],
    instances: [],
    installedVersions: [{ id: "1.21.1", type: "release", installed: true, launchable: true, javaMajor: 21 }],
    capabilities: {},
  };
  return {
    data,
    config: data.config,
    manifest: { latestRelease: "1.21.1", latestSnapshot: "", versions: [{ id: "1.21.1", type: "release", releaseTime: "", url: "" }] },
    activeAccount: account,
    accountAppearance: { profile: null, setProfile: vi.fn(), skinUrl: undefined, model: "auto", capeUrl: undefined, hasAccountSkin: false, loading: false, error: "", refresh: vi.fn() },
    selectedInstance: undefined,
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
  const i18n = createLauncherI18n("en-US", "en-US");
  await i18n.initPromise;
  await act(async () => root.render(createElement(I18nextProvider, { i18n },
    createElement(GlassProvider, { effects: "lite", reducedMotion: true }, createElement(MultiplayerPage)))));
}

function button(scope: ParentNode, label: string): HTMLButtonElement {
  const found = Array.from(scope.querySelectorAll<HTMLButtonElement>("button"))
    .find((candidate) => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

async function click(label: string, scope: ParentNode = container) {
  await act(async () => button(scope, label).click());
}

async function fill(label: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!input) throw new Error(`Missing input: ${label}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mockLauncher = fixture();
  servers = [{ index: 0, name: "Fixture server", address: "play.example.invalid:25565", hideAddress: false }];
  managed = managedFixture();
  listeners.clear();
  commandMock.mockReset();
  commandMock.mockImplementation(async (name, args) => {
    if (name === "list_servers") return servers;
    if (name === "save_server") {
      servers = [...servers, { index: 1, name: "Added server", address: "added.example.invalid", hideAddress: false }];
      return servers;
    }
    if (name === "remove_server") {
      servers = [];
      return servers;
    }
    if (name === "ping_server") return { online: true, latencyMs: 42, version: "1.21.1", playersOnline: 3, playersMax: 20, description: "Fixture MOTD" };
    if (name === "discover_lan") return [];
    if (name === "list_managed_servers") return [managed];
    if (name === "read_managed_server_logs") return [{ serverId: managed.id, timestamp: "2026-01-01T00:00:00Z", stream: "stdout", message: "Fixture log" }];
    if (name === "set_managed_server_eula") {
      managed = { ...managed, eulaAccepted: Boolean(args?.accepted) };
      return managed;
    }
    if (name === "start_managed_server") {
      managed = { ...managed, status: "running", pid: 12345 };
      return { serverId: managed.id, status: "running", pid: 12345 };
    }
    if (name === "stop_managed_server") {
      managed = { ...managed, status: "stopped", pid: null };
      return null;
    }
    if (name === "update_managed_server") {
      managed = { ...managed, settings: args?.settings as ManagedServer["settings"] };
      return managed;
    }
    if (name === "create_managed_server") {
      managed = { ...managedFixture(), name: "Created server" };
      return managed;
    }
    return null;
  });
  eventsMock.mockReset();
  eventsMock.mockImplementation((name, callback) => {
    listeners.set(name, callback);
    return Promise.resolve(() => listeners.delete(name));
  });
  mocks.openUrl.mockReset();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("multiplayer", () => {
  it("keeps unknown status distinct from a real online query and joins the selected address", async () => {
    await render();
    const row = container.querySelector('[data-server-address="play.example.invalid:25565"]')!;
    expect(row.textContent).toContain("Not checked");
    expect(row.textContent).not.toContain("Online");
    await click("Check status", row);
    expect(row.textContent).toContain("Online");
    expect(row.textContent).toContain("42 ms");
    await click("Join", row);
    expect(mockLauncher.launchMultiplayer).toHaveBeenCalledWith("1.21.1", "play.example.invalid:25565");
  });

  it("adds and removes servers with a confirmation and the existing backup flow", async () => {
    await render();
    await click("Add server");
    await fill("Server name", "Added server");
    await fill("Server address", "added.example.invalid");
    await click("Save server");
    expect(commandMock).toHaveBeenCalledWith("save_server", {
      versionId: "1.21.1",
      entry: { index: 0, name: "Added server", address: "added.example.invalid", hideAddress: false },
    });
    await click("Remove server");
    expect(window.confirm).toHaveBeenCalled();
    expect(commandMock).toHaveBeenCalledWith("remove_server", { versionId: "1.21.1", index: 0 });
  });

  it("shows an honest empty result after LAN discovery", async () => {
    await render();
    await click("Discover LAN");
    expect(commandMock).toHaveBeenCalledWith("discover_lan");
    expect(container.textContent).toContain("No LAN worlds found");
  });

  it("cannot start a managed server until EULA is explicitly accepted", async () => {
    await render();
    await click("Managed servers");
    expect(container.querySelector('.vx-managed-list [aria-pressed="true"]')?.textContent).toContain("Synthetic server");
    expect(container.querySelector(".vx-managed-detail h2")?.textContent).toBe("Synthetic server");
    const start = button(container, "Start server");
    expect(start.disabled).toBe(true);
    expect(commandMock).not.toHaveBeenCalledWith("start_managed_server", expect.anything());
    const eula = container.querySelector<HTMLInputElement>('input[aria-label="Accept the Minecraft EULA"]')!;
    await act(async () => eula.click());
    expect(commandMock).toHaveBeenCalledWith("set_managed_server_eula", { serverId: managed.id, accepted: true });
    await click("Start server");
    expect(commandMock).toHaveBeenCalledWith("start_managed_server", { serverId: managed.id });
  });

  it("preserves managed stop, console commands and live logs", async () => {
    managed = { ...managedFixture(), status: "running", pid: 12345, eulaAccepted: true };
    await render();
    await click("Managed servers");
    expect(container.textContent).toContain("Fixture log");
    await fill("Console command", "list");
    await click("Send command");
    expect(commandMock).toHaveBeenCalledWith("send_managed_server_command", { serverId: managed.id, command: "list" });
    await act(async () => listeners.get("launcher://server-log")?.({ serverId: managed.id, timestamp: "2026-01-01T00:00:01Z", stream: "stdout", message: "There are 3 players online" }));
    expect(container.textContent).toContain("There are 3 players online");
    await click("Save and stop");
    expect(commandMock).toHaveBeenCalledWith("stop_managed_server", { serverId: managed.id, force: false });
  });

  it("saves the complete managed settings object", async () => {
    await render();
    await click("Managed servers");
    await click("Server settings");
    await fill("Port", "25566");
    await fill("MOTD", "Changed MOTD");
    await click("Save settings");
    expect(commandMock).toHaveBeenCalledWith("update_managed_server", {
      serverId: managed.id,
      settings: expect.objectContaining({ port: 25566, motd: "Changed MOTD", maxPlayers: 20, onlineMode: true }),
    });
  });

  it("creates without accepting EULA or starting automatically", async () => {
    await render();
    await click("Managed servers");
    await click("Create server");
    await fill("Server name", "Created server");
    await click("Install server");
    expect(commandMock).toHaveBeenCalledWith("create_managed_server", {
      request: expect.objectContaining({ name: "Created server", versionId: "1.21.1" }),
    });
    expect(commandMock).not.toHaveBeenCalledWith("set_managed_server_eula", expect.anything());
    expect(commandMock).not.toHaveBeenCalledWith("start_managed_server", expect.anything());
  });

  it("uses process failure state instead of a decorative running indicator", async () => {
    managed = { ...managedFixture(), status: "error", error: "native diagnostic" };
    await render();
    await click("Managed servers");
    expect(container.textContent).toContain("Needs log review");
    expect(container.textContent).not.toContain("Running");
    expect(container.textContent).not.toContain("native diagnostic");
  });
});
