// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { GlassProvider } from "../../visual/glass/GlassSystem";
import { command, defaults, events, type Account, type Bootstrap, type Instance } from "../../lib/launcher";
import type { LauncherContextValue } from "../../app/controller/types";
import { createLauncherI18n } from "../../i18n";
import { ConfirmContext, type ConfirmFn } from "../../components/ui/ConfirmDialog";
import { MultiplayerPage } from "./MultiplayerPage";
import type { ManagedServer, ServerEntry, ServerImportInspection } from "./useMultiplayer";

const mocks = vi.hoisted(() => ({ openUrl: vi.fn() }));
const commandMock = vi.mocked(command);
const eventsMock = vi.mocked(events);
const listeners = new Map<string, (value: unknown) => void>();
let mockLauncher: LauncherContextValue;
let root: Root;
let container: HTMLDivElement;
let servers: ServerEntry[];
let managed: ManagedServer;
let pickedPath: string | null;
let inspection: ServerImportInspection;
const confirmMock = vi.fn<ConfirmFn>(async () => true);

vi.mock("../../lib/launcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/launcher")>()),
  command: vi.fn(),
  events: vi.fn(),
  desktop: true,
}));
vi.mock("../../app/controller/LauncherProvider", () => ({
  useLauncher: () => mockLauncher,
}));
vi.mock("../../app/AppearanceProvider", () => ({
  useAppearance: () => ({ effects: "lite", reducedMotion: true, reducedTransparency: false, highContrast: false }),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));

const account: Account = {
  id: "fixture-account",
  username: "Fixture",
  uuid: "11111111111111111111111111111111",
  type: "microsoft",
  isSelected: true,
};

/** A version-folder instance, the record the backend resolves for a bare version. */
function versionInstance(versionId: string, overrides: Partial<Instance> = {}): Instance {
  return {
    id: "version-" + versionId,
    name: versionId,
    versionId,
    gameDirectory: "C:\\SyntheticFixture\\versions\\" + versionId,
    createdAt: "2026-01-01T00:00:00Z",
    category: "",
    notes: "",
    totalPlayTime: 0,
    loader: "vanilla",
    loaderVersion: "",
    kind: "version",
    gameFolder: "C:\\SyntheticFixture",
    ...overrides,
  };
}

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
    source: "vanilla",
    software: null,
    jar: null,
  };
}

function fixture(): LauncherContextValue {
  const data: Bootstrap = {
    config: { ...defaults },
    accounts: [account],
    instances: ["1.21.1", "A", "B", "C"].map((id) => versionInstance(id)),
    installedVersions: [{ id: "1.21.1", type: "release", installed: true, launchable: true, javaMajor: 21 }],
    capabilities: {},
  };
  return {
    bootstrapped: true,
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
    preparing: false, progress: null, resourceProgress: null,
    logs: [],
    busy: "",
    notice: null,
    gamePid: undefined,
    reload: vi.fn(async () => {}),
    saveConfig: vi.fn(async (next) => next),
    setTourCompleted: vi.fn(async (completed) => ({ ...defaults, tourCompleted: completed })),
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
    createElement(ConfirmContext.Provider, { value: confirmMock },
      createElement(GlassProvider, { effects: "lite", reducedMotion: true }, createElement(MultiplayerPage))))));
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

function dialog() {
  const found = container.querySelector<HTMLDialogElement>("dialog.vx-import-dialog[open]");
  if (!found) throw new Error("Missing import dialog");
  return found;
}

async function chooseSelect(label: string, optionText: string, scope: ParentNode = container) {
  const trigger = scope.querySelector<HTMLButtonElement>(`[role="combobox"][aria-label="${label}"]`);
  if (!trigger) throw new Error(`Missing select: ${label}`);
  await act(async () => trigger.click());
  const list = document.querySelector<HTMLElement>(`[role="listbox"][aria-label="${label}"]`);
  if (!list) throw new Error(`Missing listbox: ${label}`);
  const option = [...list.querySelectorAll<HTMLElement>('[role="option"]')]
    .find((candidate) => candidate.textContent?.includes(optionText));
  if (!option) throw new Error(`Missing option: ${optionText}`);
  await act(async () => option.click());
}

async function openImport() {
  await click("Managed servers");
  await click("Import server", container.querySelector(".vx-multiplayer-toolbar")!);
  return dialog();
}

function releaseManifest(...ids: string[]) {
  return {
    latestRelease: ids[0] ?? "",
    latestSnapshot: "",
    versions: ids.map((id, index) => ({
      id,
      type: "release",
      releaseTime: `2026-01-${String(ids.length - index).padStart(2, "0")}T00:00:00Z`,
      url: "",
    })),
  };
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function () { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function () { this.open = false; this.dispatchEvent(new Event("close")); } });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.getAttribute("role") === "combobox" ? new DOMRect(24, 120, 260, 48) : new DOMRect();
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mockLauncher = fixture();
  servers = [{ index: 0, name: "Fixture server", address: "play.example.invalid:25565", hideAddress: false, snapshot: "fixture-0" }];
  managed = managedFixture();
  pickedPath = "C:\\SyntheticFixture\\paper.jar";
  inspection = {
    kind: "jar",
    software: "Paper",
    minecraftVersion: "1.21.4",
    jars: ["paper.jar"],
    details: [{ jar: "paper.jar", software: "Paper", minecraftVersion: "1.21.4" }],
    defaultJar: "paper.jar",
    totalBytes: 3670016,
    fileCount: 1,
    unsupported: null,
  };
  listeners.clear();
  commandMock.mockReset();
  commandMock.mockImplementation(async (name, args) => {
    if (name === "list_servers") return servers;
    if (name === "save_server") {
      servers = [
        ...servers.map((server) => ({ ...server, snapshot: "saved-" + server.index })),
        { index: 1, name: "Added server", address: "added.example.invalid", hideAddress: false, snapshot: "saved-1" },
      ];
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
    if (name === "choose_launcher_path") return pickedPath ? [pickedPath] : null;
    if (name === "inspect_server_import") return inspection;
    if (name === "import_managed_server") {
      const request = args?.request as { name: string; versionId: string; jar: string };
      managed = {
        ...managedFixture(),
        id: "imported-server",
        name: request.name,
        versionId: request.versionId,
        source: "imported",
        software: inspection.software,
        jar: request.jar,
      };
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
  confirmMock.mockReset();
  confirmMock.mockResolvedValue(true);
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
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (cause: unknown) => void;
    const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; });
    return { promise, resolve, reject };
  }

  function environmentRows(id: string): ServerEntry[] {
    return [{ ...servers[0], name: `Bookmark ${id}`, address: `${id}.example.invalid`, snapshot: "snapshot-" + id }];
  }

  it("never makes A's row actionable while a new B environment is still loading", async () => {
    const pendingB = deferred<ServerEntry[]>();
    const normal = commandMock.getMockImplementation()!;
    commandMock.mockImplementation((name, args) => name !== "list_servers" ? normal(name, args)
      : args?.versionId === "B" ? pendingB.promise : Promise.resolve(environmentRows("A")));
    mockLauncher.selectedVersionId = "A";
    await render();
    expect(container.querySelector(".vx-server-row__copy h2")?.textContent).toBe("Bookmark A");

    mockLauncher.selectedVersionId = "B";
    await render();
    const staleRemove = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((candidate) => candidate.textContent?.trim() === "Remove server");
    if (staleRemove) await act(async () => staleRemove.click());
    expect(commandMock.mock.calls.filter(([name]) => name === "remove_server")).toEqual([]);
    expect(container.querySelector(".vx-server-row__copy h2")?.textContent).not.toBe("Bookmark A");
    await act(async () => pendingB.resolve(environmentRows("B")));
    expect(container.querySelector(".vx-server-row__copy h2")?.textContent).toBe("Bookmark B");
  });

  it("ignores the delayed B response after C has already displayed its bookmark", async () => {
    const pendingB = deferred<ServerEntry[]>();
    const normal = commandMock.getMockImplementation()!;
    commandMock.mockImplementation((name, args) => name !== "list_servers" ? normal(name, args)
      : args?.versionId === "B" ? pendingB.promise : Promise.resolve(environmentRows(String(args?.versionId))));
    for (const environment of ["A", "B", "C"]) {
      mockLauncher.selectedVersionId = environment;
      await render();
    }
    expect(container.querySelector(".vx-server-row__copy h2")?.textContent).toBe("Bookmark C");
    await act(async () => pendingB.resolve(environmentRows("B")));
    expect(container.querySelector(".vx-server-row__copy h2")?.textContent).toBe("Bookmark C");
  });

  it("does not reaccept an old A request after leaving and revisiting the same environment", async () => {
    const firstA = deferred<ServerEntry[]>();
    const normal = commandMock.getMockImplementation()!;
    let aRequests = 0;
    commandMock.mockImplementation((name, args) => {
      if (name !== "list_servers") return normal(name, args);
      if (args?.versionId === "B") return Promise.resolve(environmentRows("B"));
      return ++aRequests === 1 ? firstA.promise : Promise.resolve(environmentRows("A-new"));
    });
    for (const environment of ["A", "B", "A"]) {
      mockLauncher.selectedVersionId = environment;
      await render();
    }
    expect(container.querySelector(".vx-server-row__copy h2")?.textContent).toBe("Bookmark A-new");
    await act(async () => firstA.resolve(environmentRows("A-old")));
    expect(container.querySelector(".vx-server-row__copy h2")?.textContent).toBe("Bookmark A-new");
  });

  it("refreshes on snapshot conflict and leaves the rejection visible for the current environment", async () => {
    const normal = commandMock.getMockImplementation()!;
    commandMock.mockImplementation((name, args) => {
      if (name !== "remove_server") return normal(name, args);
      servers = environmentRows("updated");
      return Promise.reject({ code: "server.snapshotChanged", params: {} });
    });
    await render();
    await click("Remove server");
    expect(container.querySelector(".vx-server-row__copy h2")?.textContent).toBe("Bookmark updated");
    expect(container.querySelector("[role=alert]")?.textContent).toContain("No bookmark was modified");
    expect(commandMock.mock.calls.filter(([name]) => name === "list_servers")).toHaveLength(2);
  });

  it("retains the complete long server name and offers semantic address break opportunities", async () => {
    servers[0].name = "A very long server name that remains available when the visible title is clamped";
    await render();
    expect(container.querySelector(".vx-server-row__copy h2")?.getAttribute("title")).toBe(servers[0].name);
    expect(container.querySelector(".vx-server-addresses strong")?.getAttribute("title")).toBe(servers[0].name);
    const address = container.querySelector(".vx-server-row__copy p")!;
    expect(address.textContent).toBe(servers[0].address);
    expect(address.querySelectorAll("wbr").length).toBeGreaterThan(1);
  });
  it("uses one saved-server empty explanation inside the normal detail frame", async () => {
    servers = []; await render();
    const empty = container.querySelector('.vx-server-row--empty');
    expect(empty).not.toBeNull();
    expect(empty?.querySelector('.vx-empty')).not.toBeNull();
    const title = empty!.querySelector('h2,h3,strong')!.textContent!;
    expect(container.textContent!.split(title)).toHaveLength(2);
  });
  it("offers one create-server action when the managed inventory is empty", async () => {
    const normal = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => name === "list_managed_servers" ? [] : normal(name, args));
    await render();
    await click("Managed servers");
    const create = [...container.querySelectorAll<HTMLButtonElement>("button")].filter(button => button.textContent?.trim() === "Create server");
    expect(create).toHaveLength(1);
    await act(async () => create[0].click());
    expect(container.querySelector(".vx-managed-create")).not.toBeNull();
  });
  it("offers one add-server action in the empty inventory and opens its form", async () => {
    servers = [];
    await render();
    const add = [...container.querySelectorAll<HTMLButtonElement>("button")].filter((candidate) => candidate.textContent?.trim() === "Add server");
    expect(add).toHaveLength(1);
    await act(async () => add[0].click());
    expect(container.querySelector('input[aria-label="Server name"]')).not.toBeNull();
    expect(container.querySelector('input[aria-label="Server address"]')).not.toBeNull();
  });

  it("keeps unknown status distinct from a real online query and joins the selected address", async () => {
    await render();
    const row = container.querySelector('[data-server-address="play.example.invalid:25565"]')!;
    expect(row.textContent).toContain("Not checked");
    expect(row.textContent).not.toContain("Online");
    await click("Check status", row);
    expect(row.textContent).toContain("Online");
    expect(row.textContent).toContain("42 ms");
    await click("Join", row);
    expect(mockLauncher.launchMultiplayer).toHaveBeenCalledWith("version-1.21.1", "play.example.invalid:25565");
  });

  it("adds and removes servers with a confirmation and the existing backup flow", async () => {
    await render();
    await click("Add server");
    await fill("Server name", "Added server");
    await fill("Server address", "added.example.invalid");
    await click("Save server");
    expect(commandMock).toHaveBeenCalledWith("save_server", {
      versionId: "1.21.1",
      instanceId: "version-1.21.1",
      entry: { name: "Added server", address: "added.example.invalid", hideAddress: false },
    });
    // Cancelling the confirmation keeps the server.
    confirmMock.mockResolvedValueOnce(false);
    await click("Remove server");
    expect(confirmMock).toHaveBeenCalledWith(expect.stringContaining("Fixture server"), { tone: "danger" });
    expect(commandMock).not.toHaveBeenCalledWith("remove_server", expect.anything());
    await click("Remove server");
    expect(confirmMock).toHaveBeenCalledTimes(2);
    expect(commandMock).toHaveBeenCalledWith("remove_server", {
      versionId: "1.21.1",
      instanceId: "version-1.21.1",
      index: 0,
      expected: { index: 0, snapshot: "saved-0" },
    });
  });

  it("lists, saves and joins with the selected instance even when another record shares its version", async () => {
    const modded = versionInstance("fabric-loader-0.16.9-1.21.1", { id: "managed-modded", name: "My Modded", kind: "managed", gameFolder: undefined });
    const folder = versionInstance("fabric-loader-0.16.9-1.21.1");
    mockLauncher.data.instances = [modded, folder];
    mockLauncher.selectedInstance = folder;
    mockLauncher.selectedVersionId = folder.versionId;
    await render();
    expect(commandMock).toHaveBeenCalledWith("list_servers", { versionId: folder.versionId, instanceId: folder.id });
    await click("Join", container.querySelector('[data-server-address="play.example.invalid:25565"]')!);
    expect(mockLauncher.launchMultiplayer).toHaveBeenCalledWith(folder.id, "play.example.invalid:25565");

    mockLauncher.selectedInstance = modded;
    await render();
    expect(commandMock).toHaveBeenCalledWith("list_servers", { versionId: modded.versionId, instanceId: modded.id });
    await click("Add server");
    await fill("Server name", "Added server");
    await fill("Server address", "added.example.invalid");
    await click("Save server");
    expect(commandMock).toHaveBeenCalledWith("save_server", {
      versionId: modded.versionId,
      instanceId: modded.id,
      entry: { name: "Added server", address: "added.example.invalid", hideAddress: false },
    });
  });

  it("offers visible instances as environments and never a hidden loader parent", async () => {
    mockLauncher.data.installedVersions = [
      { id: "1.21.1", type: "release", installed: true, launchable: true, javaMajor: 21 },
      { id: "hidden-parent", type: "release", installed: true, launchable: true, javaMajor: 21 },
    ];
    mockLauncher.data.instances = [versionInstance("1.21.1", { name: "Survival world" })];
    mockLauncher.selectedVersionId = "hidden-parent";
    await render();
    // A version-only choice without a visible record has no servers.dat to show.
    expect(commandMock).not.toHaveBeenCalledWith("list_servers", expect.anything());
    expect(container.textContent).toContain("Choose a game environment before saving or joining a server.");

    const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Game environment"]')!;
    await act(async () => trigger.click());
    const options = [...document.querySelectorAll<HTMLElement>('[role="listbox"][aria-label="Game environment"] [role="option"]')]
      .map((option) => option.textContent ?? "");
    expect(options.some((text) => text.includes("Survival world"))).toBe(true);
    expect(options.some((text) => text.includes("hidden-parent"))).toBe(false);
    await act(async () => trigger.click());
    await chooseSelect("Game environment", "Survival world");
    expect(mockLauncher.selectInstance).toHaveBeenCalledWith("version-1.21.1");
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
    const current = container.querySelector<HTMLButtonElement>('.vx-managed-list [aria-current="true"]');
    expect(current).not.toBeNull();
    expect(current?.textContent).toContain("Synthetic server");
    expect(current?.hasAttribute("aria-pressed")).toBe(false);
    current!.focus(); expect(document.activeElement).toBe(current);
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

  it("shows the import action in the toolbar and the empty state and opens the dialog", async () => {
    const normal = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => name === "list_managed_servers" ? [] : normal(name, args));
    await render();
    await click("Managed servers");
    const toolbar = container.querySelector(".vx-multiplayer-toolbar")!;
    expect(button(toolbar, "Import server")).toBeTruthy();
    await click("Import server", toolbar);
    expect(container.querySelector("dialog.vx-import-dialog[open]")).not.toBeNull();
    expect(dialog().textContent).toContain("Import a server");
    await click("Close", dialog());
    expect(container.querySelector("dialog.vx-import-dialog[open]")).toBeNull();
    const empty = container.querySelector(".vx-empty")!;
    expect(button(empty, "Create server")).toBeTruthy();
    await click("Import server", empty);
    expect(container.querySelector("dialog.vx-import-dialog[open]")).not.toBeNull();
  });

  it("imports a JAR with detected software, size, warning, version and selects it", async () => {
    mockLauncher.manifest = releaseManifest("1.21.4", "1.21.1");
    // The existing server stays first in the list, so the new one must be selected on purpose.
    const existing = managedFixture();
    const normal = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => name === "list_managed_servers"
      ? (managed.source === "imported" ? [existing, managed] : [existing])
      : normal(name, args));
    await render();
    const scope = await openImport();
    expect(scope.textContent).toContain("The launcher cannot verify imported server software.");
    await click("Choose JAR…", scope);
    expect(commandMock).toHaveBeenCalledWith("choose_launcher_path", { purpose: "serverJar", suggestedName: undefined });
    expect(commandMock).toHaveBeenCalledWith("inspect_server_import", { kind: "jar", path: pickedPath });
    expect(scope.textContent).toContain(pickedPath!);
    expect(scope.textContent).toContain("Detected: Paper 1.21.4");
    expect(scope.textContent).toContain("1 file (3.5 MiB) will be copied into the launcher's data folder.");
    expect(scope.querySelector<HTMLInputElement>('input[aria-label="Server name"]')?.value).toBe("Paper 1.21.4");
    expect(scope.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Minecraft version"]')?.textContent).toContain("1.21.4");
    await click("Import", scope);
    expect(commandMock).toHaveBeenCalledWith("import_managed_server", {
      request: { kind: "jar", path: pickedPath, name: "Paper 1.21.4", versionId: "1.21.4", jar: "paper.jar" },
    });
    expect(container.querySelector("dialog.vx-import-dialog[open]")).toBeNull();
    const selected = container.querySelector<HTMLButtonElement>(".vx-managed-list [aria-current='true']");
    expect(selected?.textContent).toContain("Paper 1.21.4");
    expect(selected?.textContent).toContain("Paper 1.21.4");
    expect(container.querySelector(".vx-multiplayer-notice")?.textContent).toBe("Server imported. Review and accept the EULA before starting.");
    expect(commandMock.mock.calls.filter(([name]) => name === "inspect_server_import"), "a fresh choice is not looked at twice").toHaveLength(1);
  });

  it("chooses the JAR to run for a folder import, which brings its own version and name", async () => {
    mockLauncher.manifest = releaseManifest("1.21.4", "1.21.1");
    pickedPath = "C:\\SyntheticFixture\\paper-folder";
    inspection = {
      kind: "folder",
      software: "Paper",
      minecraftVersion: "1.21.4",
      jars: ["paper-original.jar", "paper.jar"],
      details: [
        { jar: "paper-original.jar", software: "Paper", minecraftVersion: "1.21.1" },
        { jar: "paper.jar", software: "Paper", minecraftVersion: "1.21.4" },
      ],
      defaultJar: "paper.jar",
      totalBytes: 8192,
      fileCount: 4,
      unsupported: null,
    };
    await render();
    const scope = await openImport();
    await click("Server folder", scope);
    await click("Choose folder…", scope);
    expect(commandMock).toHaveBeenCalledWith("choose_launcher_path", { purpose: "serverFolder", suggestedName: undefined });
    expect(commandMock).toHaveBeenCalledWith("inspect_server_import", { kind: "folder", path: pickedPath });
    const jarSelect = scope.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Server JAR to run"]')!;
    expect(jarSelect.textContent).toContain("paper.jar");
    expect(scope.textContent).toContain("Detected: Paper 1.21.4");
    await chooseSelect("Server JAR to run", "paper-original.jar", scope);
    expect(jarSelect.textContent).toContain("paper-original.jar");
    expect(scope.textContent).toContain("Detected: Paper 1.21.1");
    expect(scope.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Minecraft version"]')?.textContent).toContain("1.21.1");
    await click("Import", scope);
    expect(commandMock).toHaveBeenCalledWith("import_managed_server", {
      request: { kind: "folder", path: pickedPath, name: "Paper 1.21.1", versionId: "1.21.1", jar: "paper-original.jar" },
    });
  });

  it("keeps a name and version the user chose when another JAR is picked", async () => {
    mockLauncher.manifest = releaseManifest("1.21.4", "1.21.1", "1.20.1");
    pickedPath = "C:\\SyntheticFixture\\paper-folder";
    inspection = {
      kind: "folder",
      software: "Paper",
      minecraftVersion: "1.21.4",
      jars: ["paper-original.jar", "paper.jar"],
      details: [
        { jar: "paper-original.jar", software: "Paper", minecraftVersion: "1.21.1" },
        { jar: "paper.jar", software: "Paper", minecraftVersion: "1.21.4" },
      ],
      defaultJar: "paper.jar",
      totalBytes: 8192,
      fileCount: 4,
      unsupported: null,
    };
    await render();
    const scope = await openImport();
    await click("Server folder", scope);
    await click("Choose folder…", scope);
    const input = scope.querySelector<HTMLInputElement>('input[aria-label="Server name"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Survival");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await chooseSelect("Minecraft version", "1.20.1", scope);
    await chooseSelect("Server JAR to run", "paper-original.jar", scope);
    expect(input.value).toBe("Survival");
    expect(scope.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Minecraft version"]')?.textContent).toContain("1.20.1");
  });

  it.each([
    ["installer", "This is an installer, not a server."],
    ["argsFile", "This server only has Unix arguments files"],
    ["noJar", "This folder has no server JAR"],
    ["needsFolder", "This JAR cannot start on its own"],
  ] as const)("keeps Import disabled for %s imports", async (unsupported, message) => {
    mockLauncher.manifest = releaseManifest("1.21.4");
    pickedPath = "C:\\SyntheticFixture\\server-folder";
    inspection = {
      kind: "folder",
      software: "Paper",
      minecraftVersion: "1.21.4",
      jars: unsupported === "noJar" ? [] : ["paper.jar"],
      details: unsupported === "noJar" ? [] : [{ jar: "paper.jar", software: "Paper", minecraftVersion: "1.21.4" }],
      defaultJar: unsupported === "noJar" ? null : "paper.jar",
      totalBytes: 4096,
      fileCount: 2,
      unsupported,
    };
    await render();
    const scope = await openImport();
    await click("Server folder", scope);
    await click("Choose folder…", scope);
    expect(scope.textContent).toContain(message);
    const action = button(scope, "Import");
    expect(action.disabled).toBe(true);
    await act(async () => action.click());
    expect(commandMock).not.toHaveBeenCalledWith("import_managed_server", expect.anything());
  });

  it("does not offer a detected version missing from the manifest and requires a valid choice", async () => {
    inspection = { ...inspection, minecraftVersion: "1.21.9", details: [{ jar: "paper.jar", software: "Paper", minecraftVersion: "1.21.9" }] };
    await render();
    const scope = await openImport();
    await click("Choose JAR…", scope);
    const versionSelect = scope.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Minecraft version"]')!;
    expect(versionSelect.textContent).toContain("Select game version");
    expect(button(scope, "Import").disabled).toBe(true);
    await act(async () => versionSelect.click());
    const list = document.querySelector<HTMLElement>('[role="listbox"][aria-label="Minecraft version"]')!;
    expect(list.textContent).not.toContain("1.21.9");
    expect(list.textContent).toContain("1.21.1");
    const option = [...list.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((candidate) => candidate.textContent?.includes("1.21.1"))!;
    await act(async () => option.click());
    expect(button(scope, "Import").disabled).toBe(false);
    await click("Import", scope);
    expect(commandMock).toHaveBeenCalledWith("import_managed_server", {
      request: expect.objectContaining({ versionId: "1.21.1", name: "Paper 1.21.9" }),
    });
  });

  it("shows imported software in the list row while vanilla rows keep their version", async () => {
    const vanilla = managedFixture();
    const imported: ManagedServer = {
      ...managedFixture(),
      id: "imported-server",
      name: "Paper server",
      versionId: "1.21.4",
      source: "imported",
      software: "Paper",
      jar: "paper.jar",
    };
    const normal = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => name === "list_managed_servers" ? [vanilla, imported] : normal(name, args));
    await render();
    await click("Managed servers");
    const rows = [...container.querySelectorAll<HTMLButtonElement>(".vx-managed-list button")];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("1.21.1:25565");
    expect(rows[0].textContent).not.toContain("Paper");
    expect(rows[1].textContent).toContain("Paper 1.21.4");
    const listMeta = rows[1].querySelector(".vx-managed-list__meta")!;
    expect([...listMeta.querySelectorAll(":scope > span")].map((item) => item.textContent)).toEqual(["Paper", "1.21.4", ":25565"]);
    expect(listMeta.textContent).not.toContain("·");
    await act(async () => rows[1].click());
    const overview = container.querySelector(".vx-managed-overview header p")!;
    expect(overview.textContent).toContain("Paper 1.21.4");
    expect([...overview.querySelectorAll(":scope > span")].map((item) => item.textContent)).toEqual(["Paper", "1.21.4", "Java 21"]);
    expect(overview.textContent).not.toContain("·");
  });

  it("an imported server whose JAR is gone cannot start and says to import it again", async () => {
    const missing: ManagedServer = { ...managedFixture(), id: "imported-server", source: "imported", software: "Paper", jar: "paper.jar", installed: false, eulaAccepted: true };
    const normal = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => name === "list_managed_servers" ? [missing] : normal(name, args));
    await render();
    await click("Managed servers");
    expect(button(container, "Start server").disabled).toBe(true);
    expect(container.querySelector(".vx-managed-error")?.textContent).toBe("The imported server's JAR is missing from its folder. Import the server again.");
    expect(container.textContent).not.toContain("Install and start");
  });

  it("imports a NeoForge arguments-file folder and surfaces missing win_args.txt clearly", async () => {
    mockLauncher.manifest = releaseManifest("1.21.1");
    pickedPath = "C:\\SyntheticFixture\\neoforge-folder";
    const rel = "libraries/net/neoforged/neoforge/21.1.77/win_args.txt";
    inspection = {
      kind: "folder",
      software: "NeoForge",
      minecraftVersion: "1.21.1",
      jars: [],
      details: [],
      defaultJar: null,
      argsFile: rel,
      totalBytes: 12288,
      fileCount: 6,
      unsupported: null,
    };
    await render();
    const scope = await openImport();
    await click("Server folder", scope);
    await click("Choose folder…", scope);
    expect(scope.textContent).toContain("Detected: NeoForge 1.21.1");
    expect(scope.textContent).toContain(`Start via arguments file: ${rel}`);
    expect(button(scope, "Import").disabled).toBe(false);
    await click("Import", scope);
    expect(commandMock).toHaveBeenCalledWith("import_managed_server", {
      request: { kind: "folder", path: pickedPath, name: "NeoForge 1.21.1", versionId: "1.21.1", jar: "", argsFile: rel },
    });

    const missingArgs: ManagedServer = {
      ...managedFixture(),
      id: "imported-args",
      source: "imported",
      software: "NeoForge",
      jar: null,
      argsFile: rel,
      installed: false,
      eulaAccepted: true,
    };
    const normal = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => name === "list_managed_servers" ? [missingArgs] : normal(name, args));
    await act(async () => button(container.querySelector(".vx-multiplayer-toolbar")!, "Refresh").click());
    expect(button(container, "Start server").disabled).toBe(true);
    expect(container.querySelector(".vx-managed-error")?.textContent).toBe(
      "The imported server's win_args.txt arguments file is missing from its folder. Import the server again.",
    );
  });

  it("names an imported server of unknown software as imported", async () => {
    const unknown: ManagedServer = { ...managedFixture(), id: "imported-server", source: "imported", software: null, jar: "custom.jar" };
    const normal = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => name === "list_managed_servers" ? [unknown] : normal(name, args));
    await render();
    await click("Managed servers");
    expect(container.querySelector(".vx-managed-list button")?.textContent).toContain("Imported server 1.21.1");
    expect(container.querySelector(".vx-managed-overview header p")?.textContent).toContain("Imported server 1.21.1");
    expect(container.querySelector(".vx-managed-overview header p")?.textContent).not.toContain("Vanilla");
  });

  it("shows the import's own errors in the dialog, not an earlier page error", async () => {
    mockLauncher.manifest = releaseManifest("1.21.4");
    const normal = commandMock.getMockImplementation()!;
    let inspectError: unknown = { code: "server.importLinks", params: {} };
    commandMock.mockImplementation(async (name, args) => {
      if (name === "inspect_server_import" && inspectError) throw inspectError;
      if (name === "import_managed_server") throw { code: "server.importProperties", params: { key: "view-distance" } };
      if (name === "set_managed_server_eula") throw { code: "server.busy", params: {} };
      return normal(name, args);
    });
    await render();
    await click("Managed servers");
    const eula = container.querySelector<HTMLInputElement>('input[aria-label="Accept the Minecraft EULA"]')!;
    await act(async () => eula.click());
    expect(container.textContent).toContain("Another server or download operation is still running.");
    const scope = await openImport();
    expect(scope.querySelector(".vx-multiplayer-error"), "an earlier page error is not repeated").toBeNull();
    await click("Choose JAR…", scope);
    expect(scope.querySelector('[role="alert"]')?.textContent).toBe("The server folder contains links, junctions or special files, so it cannot be imported.");
    inspectError = null;
    await click("Choose JAR…", scope);
    expect(scope.querySelector(".vx-multiplayer-error")).toBeNull();
    await click("Import", scope);
    expect(scope.querySelector(".vx-multiplayer-error")?.textContent).toContain("sets view-distance to a value the launcher cannot manage");
    expect(container.querySelector("dialog.vx-import-dialog[open]")).not.toBeNull();
    // The launcher gives the choice back: the form stays for another try.
    expect(scope.querySelector(".vx-path")?.textContent).toBe(pickedPath);
    expect(button(scope, "Import").disabled).toBe(false);
    await click("Import", scope);
    expect(commandMock.mock.calls.filter(([name]) => name === "import_managed_server")).toHaveLength(2);
    // A failing native picker is reported too, in a freshly opened dialog.
    await click("Close", scope);
    commandMock.mockImplementation(async (name, args) => {
      if (name === "choose_launcher_path") throw { code: "storage.pathAuthorizationRequired", params: {} };
      return normal(name, args);
    });
    const reopened = await openImport();
    expect(reopened.querySelector(".vx-multiplayer-error")).toBeNull();
    await click("Choose JAR…", reopened);
    // A launcher-wide code is worded from the shell's texts.
    expect(reopened.querySelector(".vx-multiplayer-error")?.textContent).toBe("Choose or approve this exact path in the native dialog before continuing.");
  });

  it("a lapsed choice clears the form so the path is chosen again", async () => {
    mockLauncher.manifest = releaseManifest("1.21.4");
    const normal = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => {
      if (name === "import_managed_server") throw { code: "storage.pathAuthorizationRequired", params: {} };
      return normal(name, args);
    });
    await render();
    const scope = await openImport();
    await click("Choose JAR…", scope);
    await click("Import", scope);
    expect(scope.querySelector(".vx-multiplayer-error")?.textContent).toBe("Choose or approve this exact path in the native dialog before continuing.");
    expect(scope.querySelector(".vx-path")).toBeNull();
    expect(scope.querySelector('input[aria-label="Server name"]')).toBeNull();
  });

  it("looks at a choice again before importing it when it is about to lapse", async () => {
    mockLauncher.manifest = releaseManifest("1.21.4");
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    await render();
    const scope = await openImport();
    await click("Choose JAR…", scope);
    now.mockReturnValue(1_000_000 + 5 * 60_000);
    await click("Import", scope);
    const order = commandMock.mock.calls.map(([name]) => name).filter((name) => name === "inspect_server_import" || name === "import_managed_server");
    expect(order).toEqual(["inspect_server_import", "inspect_server_import", "import_managed_server"]);
    now.mockRestore();
  });

  it("keeps the import's choices still while it runs", async () => {
    mockLauncher.manifest = releaseManifest("1.21.4");
    const pending = deferred<ManagedServer>();
    const normal = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => name === "import_managed_server" ? pending.promise : normal(name, args));
    await render();
    const scope = await openImport();
    await click("Choose JAR…", scope);
    await act(async () => button(scope, "Import").click());
    expect(button(scope, "Server folder").disabled).toBe(true);
    expect(button(scope, "Choose JAR…").disabled).toBe(true);
    await click("Server folder", scope);
    expect(scope.querySelector(".vx-path")?.textContent).toBe(pickedPath);
    expect(button(container.querySelector(".vx-multiplayer-toolbar")!, "Import server").disabled).toBe(true);
    await act(async () => pending.reject({ code: "server.importChanged", params: {} }));
    expect(scope.querySelector(".vx-multiplayer-error")?.textContent).toContain("If it is running, stop it");
  });

  it("offers the latest release when the cached list does not name it yet", async () => {
    mockLauncher.manifest = { latestRelease: "1.21.4", latestSnapshot: "", versions: [] };
    await render();
    const scope = await openImport();
    await click("Choose JAR…", scope);
    expect(scope.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Minecraft version"]')?.textContent).toContain("1.21.4");
    expect(button(scope, "Import").disabled).toBe(false);
  });

  it("lists releases newest first and offers a detected snapshot from the manifest", async () => {
    mockLauncher.manifest = {
      latestRelease: "1.21.4",
      latestSnapshot: "25w14a",
      versions: [
        { id: "1.20.1", type: "release", releaseTime: "2023-06-12T00:00:00Z", url: "" },
        { id: "25w14a", type: "snapshot", releaseTime: "2025-04-01T00:00:00Z", url: "" },
        { id: "1.21.4", type: "release", releaseTime: "2024-12-03T00:00:00Z", url: "" },
        { id: "24w01a", type: "snapshot", releaseTime: "2024-01-03T00:00:00Z", url: "" },
      ],
    };
    inspection = { ...inspection, minecraftVersion: "25w14a", details: [{ jar: "paper.jar", software: "Paper", minecraftVersion: "25w14a" }] };
    await render();
    const scope = await openImport();
    await click("Choose JAR…", scope);
    const versionSelect = scope.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Minecraft version"]')!;
    expect(versionSelect.textContent).toContain("25w14a");
    await act(async () => versionSelect.click());
    const list = document.querySelector<HTMLElement>('[role="listbox"][aria-label="Minecraft version"]')!;
    const offered = [...list.querySelectorAll<HTMLElement>('[role="option"]')].map((option) => option.textContent ?? "");
    expect(offered.slice(1).map((text) => text.trim())).toEqual(["1.21.4", "1.20.1", "25w14a"]);
  });

  describe("page layout and action hierarchy", () => {
    // The page's own primary actions; a closed dialog keeps its own footer.
    const primaries = () => [...container.querySelectorAll<HTMLButtonElement>(".vx-button--primary")]
      .filter((candidate) => !candidate.closest("dialog"))
      .map((candidate) => candidate.textContent?.trim());

    it("places the three views in the page header instead of a strip of their own", async () => {
      await render();
      const actions = container.querySelector(".vx-page-header__actions");
      expect(actions?.querySelector('[role="tablist"]')).not.toBeNull();
      expect(actions?.querySelectorAll('[role="tab"]')).toHaveLength(3);
      expect(container.querySelector(".vx-page-shell > .vx-multiplayer-tabs")).toBeNull();
    });

    it("keeps a listed address on one clipped line and its full text in the title", async () => {
      servers[0].address = "ops@sub.department.region.example.co.uk:25565";
      await render();
      const listed = container.querySelector(".vx-server-addresses small")!;
      expect(listed.textContent).toBe(servers[0].address);
      expect(listed.querySelectorAll("wbr")).toHaveLength(0);
      expect(listed.getAttribute("title")).toBe(servers[0].address);
      expect(container.querySelector(".vx-server-row__copy p")!.querySelectorAll("wbr").length).toBeGreaterThan(1);
    });

    it("marks the saved-server count for the small tabular figure style", async () => {
      await render();
      expect(container.querySelector(".vx-server-inventory > h2 > .vx-server-inventory__count")?.textContent).toBe("1");
    });

    it("keeps Join as the one primary action once a server is saved and Add while the list is empty", async () => {
      await render();
      expect(primaries()).toEqual(["Join"]);
      expect(button(container.querySelector(".vx-multiplayer-toolbar")!, "Add server").dataset.variant).toBe("secondary");
      await act(async () => root.unmount());
      root = createRoot(container);
      servers = [];
      await render();
      expect(primaries()).toEqual(["Add server"]);
    });

    it("hands the one primary action to Save server while the add form is open", async () => {
      await render();
      await click("Add server");
      expect(container.querySelector(".vx-server-form")).not.toBeNull();
      expect(primaries()).toEqual(["Save server"]);
      expect(button(container.querySelector(".vx-server-row__actions")!, "Join").dataset.variant).toBe("secondary");
      await click("Cancel", container.querySelector(".vx-server-form")!);
      expect(primaries()).toEqual(["Join"]);
    });

    it("hands the one primary action to Save server when the empty list opens the add form", async () => {
      servers = [];
      await render();
      await click("Add server");
      expect(container.querySelector(".vx-server-form")).not.toBeNull();
      expect(primaries()).toEqual(["Save server"]);
      expect(button(container.querySelector(".vx-multiplayer-toolbar")!, "Add server").dataset.variant).toBe("secondary");
    });

    it("keeps one primary action in the managed workbench, open settings included", async () => {
      managed = { ...managedFixture(), eulaAccepted: true };
      await render();
      await click("Managed servers");
      expect(primaries()).toEqual(["Start server"]);
      await click("Server settings");
      expect(primaries()).toEqual(["Start server"]);
      expect(button(container, "Save settings").dataset.variant).toBe("secondary");
    });

    it("frames the managed toolbar as a panel", async () => {
      await render();
      await click("Managed servers");
      expect(container.querySelector(".vx-managed-servers > .vx-multiplayer-toolbar")?.classList.contains("vx-panel")).toBe(true);
    });

    it("marks stop with a stop icon instead of an empty square", async () => {
      managed = { ...managedFixture(), status: "running", pid: 12345, eulaAccepted: true };
      await render();
      await click("Managed servers");
      const stop = button(container, "Save and stop");
      expect(stop.querySelector("svg.lucide-circle-stop")).not.toBeNull();
      expect(stop.querySelector("svg.lucide-square")).toBeNull();
    });

    it("folds server settings behind a title row whose chevron follows the fold", async () => {
      await render();
      await click("Managed servers");
      const toggle = button(container, "Server settings");
      const chevron = () => toggle.querySelector(".vx-managed-section__chevron");
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(chevron()).not.toBeNull();
      expect(chevron()?.hasAttribute("data-open")).toBe(false);
      await act(async () => toggle.click());
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      expect(chevron()?.getAttribute("data-open")).toBe("true");
      const body = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
      expect(body?.querySelector('input[aria-label="Port"]')).not.toBeNull();
    });

    it("hints the expected player name format", async () => {
      managed = { ...managedFixture(), status: "running", pid: 12345, eulaAccepted: true };
      await render();
      await click("Managed servers");
      expect(container.querySelector('input[aria-label="Player name"]')?.getAttribute("placeholder")).toBe("e.g. Steve");
    });

    it("pairs each managed status text with a pixel marker of its state", async () => {
      managed = { ...managedFixture(), status: "running", pid: 12345, eulaAccepted: true };
      await render();
      await click("Managed servers");
      const listed = container.querySelector('.vx-managed-list [aria-current="true"] .vx-managed-list__status');
      expect(listed?.getAttribute("data-state")).toBe("running");
      expect(listed?.querySelector('i[aria-hidden="true"]')).not.toBeNull();
      expect(listed?.textContent).toContain("Running");
      const header = container.querySelector(".vx-managed-overview .vx-managed-state");
      expect(header?.getAttribute("data-state")).toBe("running");
      expect(header?.querySelector('i[aria-hidden="true"]')).not.toBeNull();
    });

    it("gives the empty managed workbench an icon tile and its next steps", async () => {
      const normal = commandMock.getMockImplementation()!;
      commandMock.mockImplementation(async (name, args) => name === "list_managed_servers" ? [] : normal(name, args));
      await render();
      await click("Managed servers");
      const empty = container.querySelector(".vx-managed-layout > .vx-empty--panel");
      expect(empty?.querySelector(".vx-empty__icon.vx-icon-tile svg")).not.toBeNull();
      expect(button(empty!, "Create server").dataset.variant).toBe("primary");
    });

    it("draws the empty saved-server icon on the icon scale inside its tile", async () => {
      servers = [];
      await render();
      const icon = container.querySelector(".vx-server-row--empty .vx-empty--panel .vx-empty__icon.vx-icon-tile svg");
      expect(icon?.getAttribute("width")).toBe("24");
      expect(icon?.getAttribute("stroke-width")).not.toBe("1.2");
    });
  });
});
