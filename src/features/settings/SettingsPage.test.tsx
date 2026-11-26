// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { command, defaults, type Bootstrap, type Config } from "../../lib/launcher";
import { LauncherError } from "../../lib/errors";
import type { LauncherContextValue } from "../../app/controller/types";
import { createLauncherI18n } from "../../i18n";
import { SettingsPage } from "./SettingsPage";
import { settingsIndex } from "./settingsIndex";
import type { LauncherUpdates } from "../updates/LauncherUpdates";

const mocks = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn(), openUrl: vi.fn() }));
const updates = vi.hoisted(() => ({ current: null as unknown as LauncherUpdates }));
const commandMock = vi.mocked(command);
let mockLauncher: LauncherContextValue;
let appearance: { effects: string; accentColor: string; resolvedTheme: string };
let root: Root;
let container: HTMLDivElement;
let scrollIntoView: ReturnType<typeof vi.fn>;

vi.mock("../../lib/launcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/launcher")>()),
  command: vi.fn(),
  desktop: true,
}));
vi.mock("../../app/controller/LauncherProvider", () => ({
  useLauncher: () => mockLauncher,
}));
vi.mock("../../app/AppearanceProvider", () => ({
  useAppearance: () => appearance,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open, save: mocks.save }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));
vi.mock("../updates/LauncherUpdates", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../updates/LauncherUpdates")>()),
  useLauncherUpdates: () => updates.current,
}));
vi.mock("../../visual/glass/GlassSystem", () => ({
  GlassSurface: ({ children, className }: { children: React.ReactNode; className?: string }) => createElement("div", { className }, children),
}));

function fixture(): LauncherContextValue {
  const config: Config = {
    ...defaults,
    gameDirectory: "C:\\SyntheticFixture",
    language: "en-US",
    theme: "dark",
    effects: "full",
    accentSource: "voxelight",
    soundEnabled: false,
    microsoftClientId: "11111111-1111-1111-1111-111111111111",
  };
  const data: Bootstrap = { config, accounts: [], instances: [], installedVersions: [], capabilities: {} };
  return {
    bootstrapped: true,
    data,
    config,
    manifest: null,
    activeAccount: undefined,
    accountAppearance: { profile: null, setProfile: vi.fn(), skinUrl: undefined, model: "auto", capeUrl: undefined, hasAccountSkin: false, loading: false, error: "", refresh: vi.fn() },
    selectedInstance: undefined,
    selectedVersion: undefined,
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
    setConfig: vi.fn((next) => {
      mockLauncher.config = next;
      appearance.effects = next.effects;
      appearance.accentColor = next.accentSource === "system" ? "#system" : next.accentColor;
      appearance.resolvedTheme = next.theme;
    }),
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
  await act(async () => root.render(createElement(I18nextProvider, { i18n }, createElement(SettingsPage))));
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
    .find((candidate) => candidate.textContent?.trim() === label || candidate.getAttribute("aria-label") === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

async function click(label: string) {
  await act(async () => button(label).click());
}

async function fill(label: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!input) throw new Error(`Missing input: ${label}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function searchInput(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="search"]');
  if (!input) throw new Error("Missing settings search input");
  return input;
}

async function search(value: string) {
  const input = searchInput();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function searchResults(): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('ul[aria-label="Matching settings"] button')];
}

function searchResult(target: string): HTMLButtonElement {
  const found = searchResults().find((candidate) => candidate.dataset.settingsResult === target);
  if (!found) throw new Error(`Missing search result: ${target}`);
  return found;
}

function activeElementInside(target: Element | null): boolean {
  const active = document.activeElement;
  return Boolean(target && active && (target === active || target.contains(active)));
}

function accessibleName(element: Element | null): string {
  if (!element) return "";
  return element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "";
}

async function settleFrame() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
}

async function settleFrames(count = 3) {
  for (let index = 0; index < count; index += 1) await settleFrame();
}

async function select(label: string, value: string) {
  const trigger = container.querySelector<HTMLButtonElement>(`[role="combobox"][aria-label="${label}"]`);
  if (!trigger) throw new Error(`Missing combobox: ${label}`);
  await act(async () => trigger.click());
  const option = [...document.querySelectorAll<HTMLElement>(`[role="option"][data-value="${value}"]`)]
    .find((item) => !item.closest('[aria-hidden="true"]'));
  if (!option) throw new Error(`Missing option: ${label} / ${value}`);
  await act(async () => option.click());
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  appearance = { effects: "full", accentColor: "#b4f17a", resolvedTheme: "dark" };
  mockLauncher = fixture();
  updates.current = {
    result: null,
    status: { key: "notChecked" },
    progress: 0,
    checking: false,
    installing: false,
    notice: null,
    check: vi.fn(async () => {}),
    install: vi.fn(async () => {}),
    cancel: vi.fn(),
    sourceChanged: vi.fn(),
    dismissNotice: vi.fn(),
  };
  commandMock.mockReset();
  commandMock.mockImplementation(async (name, args) => {
    if (name === "choose_launcher_path") {
      const picked = args?.purpose === "presetWrite" ? await mocks.save() : await mocks.open();
      return typeof picked === "string" ? [picked] : picked;
    }
    if (name === "get_service_status") return { curseforgeConfigured: false };
    if (name === "set_service_secret") return Boolean(args?.secret);
    if (name === "get_assistant_status") return {
      apiKeyConfigured: false,
      provider: mockLauncher.config.assistantProvider,
      baseUrl: mockLauncher.config.assistantBaseUrl,
      effectiveBaseUrl: "https://api.openai.com/v1",
      model: mockLauncher.config.assistantModel,
      permission: mockLauncher.config.assistantPermission,
      proactive: mockLauncher.config.assistantProactive,
      loopbackEndpoint: false,
      ready: false,
      mcp: { running: false, port: mockLauncher.config.assistantMcpPort, url: null, tokenMasked: null },
      tools: [
        { name: "list_instances", tier: "readOnly", description: "List registered instances." },
        { name: "update_instance_notes", tier: "controlled", description: "Update instance notes." },
      ],
    };
    if (name === "set_assistant_api_key") return Boolean(args?.secret);
    if (name === "detect_local_proxies") return {
      systemProxy: null,
      autoConfigUrl: null,
      candidates: [
        {
          scheme: "http",
          host: "127.0.0.1",
          port: 7897,
          source: "localPort",
          label: "Clash Verge / Mihomo",
          url: "http://127.0.0.1:7897",
        },
      ],
    };
    if (name === "reset_launcher_state") return { ...defaults, tourCompleted: false };
    if (name === "start_mcp_server") {
      const port = Number(args?.port ?? mockLauncher.config.assistantMcpPort);
      return { running: true, port, url: `http://127.0.0.1:${port}/mcp`, tokenMasked: "••••••••abcdef" };
    }
    if (name === "stop_mcp_server") return { running: false, port: mockLauncher.config.assistantMcpPort, url: null, tokenMasked: null };
    if (name === "rotate_mcp_token") return { running: true, port: mockLauncher.config.assistantMcpPort, url: `http://127.0.0.1:${mockLauncher.config.assistantMcpPort}/mcp`, tokenMasked: "••••••••999999" };
    if (name === "get_mcp_token") return "synthetic-mcp-token-abcdef";
    if (name === "detect_java") return [{ path: "C:\\SyntheticFixture\\java.exe", version: "21.0.1", major: 21 }];
    if (name === "set_launcher_update_preferences") return {
      ...mockLauncher.config,
      checkForUpdates: args?.checkForUpdates === true,
      updateSource: String(args?.updateSource ?? mockLauncher.config.updateSource),
      updateChannel: String(args?.updateChannel ?? mockLauncher.config.updateChannel),
    };
    if (name === "set_launcher_background") return { ...mockLauncher.config, customBackground: args?.path ?? null };
    if (name === "export_launcher_config") return args?.path;
    if (name === "import_launcher_config") return { config: { ...mockLauncher.config, effects: "lite", accentSource: "system" }, heapArgumentsRemoved: false };
    return null;
  });
  mocks.open.mockReset();
  mocks.save.mockReset();
  mocks.openUrl.mockReset();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.getAttribute("role") === "combobox" ? new DOMRect(24, 200, 320, 44) : new DOMRect();
  });
  scrollIntoView = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value: scrollIntoView,
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("global settings", () => {

  it("tests the unsaved launcher proxy and persists only its nonsecret settings", async () => {
    commandMock.mockResolvedValueOnce({ curseforgeConfigured: false });
    await render();
    await click("Downloads");
    await select("Launcher proxy mode", "custom");
    await select("Proxy protocol", "https");
    await fill("Proxy host", "proxy.example.test");
    await fill("Proxy port", "443");
    expect(button("Save proxy credentials").disabled).toBe(true);
    commandMock.mockResolvedValueOnce({ latencyMs: 12 });
    await click("Test proxy connection");
    expect(commandMock).toHaveBeenCalledWith("test_proxy_connection", {
      proxyMode: "custom", proxyScheme: "https", proxyHost: "proxy.example.test", proxyPort: 443,
    });
    expect(container.textContent).toContain("Connection successful (12 ms).");
    expect(mockLauncher.saveConfig).not.toHaveBeenCalled();
    await click("Save settings");
    expect(mockLauncher.saveConfig).toHaveBeenCalledWith(expect.objectContaining({
      proxyMode: "custom", proxyScheme: "https", proxyHost: "proxy.example.test", proxyPort: 443,
      gameProxyMode: "system",
    }), { preserveAppearance: true });
    expect(mockLauncher.saveConfig).toHaveBeenCalledWith(expect.not.objectContaining({ username: expect.anything() }), expect.anything());
    expect(mockLauncher.saveConfig).toHaveBeenCalledWith(expect.not.objectContaining({ password: expect.anything() }), expect.anything());
  });

  it("shows an actionable rejection when inheriting a TLS proxy", async () => {
    const saved = {
      ...mockLauncher.config,
      proxyMode: "custom", proxyScheme: "https", proxyHost: "proxy.example.test", proxyPort: 443,
      gameProxyMode: "off",
    } satisfies Config;
    mockLauncher.config = mockLauncher.data.config = saved;
    vi.mocked(mockLauncher.saveConfig).mockRejectedValueOnce({ code: "proxy.tlsInheritance" });
    await render();
    await click("Downloads");
    await select("Game proxy mode", "launcher");
    await click("Save settings");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Use an http:// proxy, Follow system, or Off.");
  });

  it("saves and clears credentials separately for the saved endpoint", async () => {
    const saved = {
      ...mockLauncher.config,
      proxyMode: "custom", proxyScheme: "http", proxyHost: "proxy.example.test", proxyPort: 3128,
      gameProxyMode: "off",
    } satisfies Config;
    mockLauncher.config = mockLauncher.data.config = saved;
    await render();
    await click("Downloads");
    expect(container.textContent).toContain("unencrypted on the connection to the proxy");
    await fill("Proxy username", "synthetic-user");
    await fill("Proxy password", "synthetic-pass");
    commandMock.mockResolvedValueOnce(true);
    await click("Save proxy credentials");
    expect(commandMock).toHaveBeenCalledWith("set_proxy_credentials", {
      proxyMode: "custom", proxyScheme: "http", proxyHost: "proxy.example.test", proxyPort: 3128,
      username: "synthetic-user", password: "synthetic-pass",
    });
    expect(container.querySelector<HTMLInputElement>('[aria-label="Proxy password"]')?.value).toBe("");
    expect(mockLauncher.saveConfig).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Credentials saved in the system credential store.");
    commandMock.mockResolvedValueOnce(false);
    await click("Clear proxy credentials");
    expect(commandMock).toHaveBeenCalledWith("set_proxy_credentials", {
      proxyMode: "custom", proxyScheme: "http", proxyHost: "proxy.example.test", proxyPort: 3128,
      username: "", password: "",
    });
    expect(container.textContent).not.toContain("Credentials saved in the system credential store.");
  });

  it("lets users clear unreadable credentials for a saved endpoint", async () => {
    const saved = {
      ...mockLauncher.config,
      proxyMode: "custom", proxyScheme: "https", proxyHost: "proxy.example.test", proxyPort: 8443,
      gameProxyMode: "off",
    } satisfies Config;
    mockLauncher.config = mockLauncher.data.config = saved;
    await render();
    commandMock.mockResolvedValueOnce({ proxyCredentialsUnreadable: true });
    await click("Downloads");
    expect(container.textContent).not.toContain("Credentials saved in the system credential store.");
    commandMock.mockResolvedValueOnce(false);
    await click("Clear proxy credentials");
    expect(commandMock).toHaveBeenCalledWith("set_proxy_credentials", {
      proxyMode: "custom", proxyScheme: "https", proxyHost: "proxy.example.test", proxyPort: 8443,
      username: "", password: "",
    });
  });

  it("previews world scene and material immediately and saves both choices explicitly", async () => {
    await render();
    await click("Appearance");
    expect(button("World scene").textContent).toContain("Horizon");
    expect(button("World material").textContent).toContain("Lattice");
    await select("World scene", "massif");
    expect(mockLauncher.setConfig).toHaveBeenLastCalledWith(expect.objectContaining({ worldScene: "massif", worldMaterial: "lattice" }));
    await select("World material", "solid");
    expect(mockLauncher.setConfig).toHaveBeenLastCalledWith(expect.objectContaining({ worldScene: "massif", worldMaterial: "solid" }));
    expect(mockLauncher.saveConfig).not.toHaveBeenCalled();
    await click("Save settings");
    expect(mockLauncher.saveConfig).toHaveBeenCalledWith(expect.objectContaining({ worldScene: "massif", worldMaterial: "solid" }), { appearancePatch: { worldScene: "massif", worldMaterial: "solid" } });
  });

  it("previews appearance immediately, offers exactly two effect levels, and saves explicitly", async () => {
    await render();
    await click("Appearance");
    await click("Effects level");
    expect([...document.querySelectorAll('[role="option"]')].map((option) => option.getAttribute("data-value"))).toEqual(["lite", "full"]);
    await act(async () => button("Effects level").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Sound effects"]')!.checked).toBe(false);
    await select("Effects level", "lite");
    expect(appearance.effects).toBe("lite");
    expect(mockLauncher.saveConfig).not.toHaveBeenCalled();
    expect(commandMock).not.toHaveBeenCalledWith("save_config", expect.anything());
    await select("Accent source", "system");
    await select("Theme", "light");
    await select("Language", "zh-CN");
    await act(async () => container.querySelector<HTMLInputElement>('input[aria-label="Sound effects"]')!.click());
    await click("Save settings");
    expect(mockLauncher.saveConfig).toHaveBeenCalledWith(expect.objectContaining({
      effects: "lite",
      accentSource: "system",
      theme: "light",
      language: "zh-CN",
      soundEnabled: true,
    }), { appearancePatch: { effects: "lite", accentSource: "system", theme: "light", language: "zh-CN", soundEnabled: true } });
  });

  it("supports custom accents without adding a third effects mode", async () => {
    await render();
    await click("Appearance");
    await select("Accent source", "custom");
    await fill("Accent color", "#ff7fb5");
    await click("Accent color #78ded5");
    expect(mockLauncher.config.accentSource).toBe("custom");
    expect(mockLauncher.config.accentColor).toBe("#78ded5");
    await click("Effects level");
    expect([...document.querySelectorAll('[role="option"]')].filter((option) => !option.closest('[aria-hidden="true"]'))).toHaveLength(2);
  });

  it("owns game directory, isolation and window fields", async () => {
    mocks.open.mockResolvedValue("C:\\ChangedFixture");
    await render();
    await click("Game");
    await click("Browse");
    await act(async () => container.querySelector<HTMLInputElement>('input[aria-label="Version isolation"]')!.click());
    await fill("Game window width", "1600");
    await fill("Game window height", "900");
    await click("Save settings");
    expect(commandMock).toHaveBeenCalledWith("choose_launcher_path", { purpose: "gameDirectory", suggestedName: undefined });
    expect(mockLauncher.saveConfig).toHaveBeenCalledWith(expect.objectContaining({
      gameDirectory: "C:\\ChangedFixture",
      versionIsolation: false,
      screenWidth: 1600,
      screenHeight: 900,
    }), { preserveAppearance: true });
  });

  it("R4-M1 saves appearance despite the operation lock and keeps other changes for retry", async () => {
    const save = vi.fn<LauncherContextValue["saveConfig"]>()
      .mockImplementationOnce(async (next) => next)
      .mockRejectedValueOnce(new LauncherError("config.busy"))
      .mockImplementationOnce(async (next) => next);
    mockLauncher.saveConfig = save;
    mockLauncher.busy = "instance.install";
    await render();
    await click("Game");
    await fill("Game window width", "1600");
    await click("Appearance");
    await select("Theme", "light");
    await click("Save settings");

    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenNthCalledWith(1, expect.objectContaining({ theme: "light", screenWidth: defaults.screenWidth }), { appearancePatch: { theme: "light" } });
    expect(save).toHaveBeenNthCalledWith(2, expect.objectContaining({ theme: "light", screenWidth: 1600 }), { preserveAppearance: true });
    expect(container.textContent).toContain("Appearance saved.");
    expect(container.textContent).toContain("Other settings were not saved.");
    expect(container.textContent).toContain("Wait for the current installation or launch preparation");
    expect(container.textContent).toContain("You have unsaved changes.");
    expect(appearance.resolvedTheme).toBe("light");

    await click("Game");
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Game window width"]')!.value).toBe("1600");
    mockLauncher.busy = "";
    await click("Save settings");
    expect(save).toHaveBeenCalledTimes(3);
    expect(save).toHaveBeenNthCalledWith(3, expect.objectContaining({ theme: "light", screenWidth: 1600 }), { preserveAppearance: true });
    expect(container.textContent).toContain("Other settings saved.");
    expect(container.textContent).not.toContain("You have unsaved changes.");
  });

  it("R4-M1 saves other settings even if the appearance write fails", async () => {
    const save = vi.fn<LauncherContextValue["saveConfig"]>()
      .mockRejectedValueOnce(new LauncherError("config.invalid"))
      .mockImplementationOnce(async (next) => next);
    mockLauncher.saveConfig = save;
    await render();
    await click("Appearance");
    await select("Theme", "light");
    await click("Game");
    await fill("Game window width", "1600");
    await click("Save settings");

    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenNthCalledWith(2, expect.objectContaining({ theme: "dark", screenWidth: 1600 }), { preserveAppearance: true });
    expect(container.textContent).toContain("Appearance was not saved.");
    expect(container.textContent).toContain("Other settings saved.");
    expect(container.textContent).toContain("You have unsaved changes.");
    expect(appearance.resolvedTheme).toBe("light");
    await click("Reset changes");
    expect(appearance.resolvedTheme).toBe("dark");
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Game window width"]')!.value).toBe("1600");
  });

  it("shows system memory and refreshes it only on demand", async () => {
    const base = commandMock.getMockImplementation()!;
    let reads = 0;
    commandMock.mockImplementation(async (name, args) => name === "get_memory_overview" ? {
      totalMb: 32768, availableMb: ++reads === 1 ? 16384 : 8192, recommendedMb: 4096,
      effectiveMode: "manual", modCount: 0,
    } : base(name, args));
    await render();
    await click("Java");
    expect(container.textContent).toContain("System RAM: 32 GiB; available: 16 GiB; recommended: 4096 MB (assumes 64-bit Java).");
    expect(reads).toBe(1);
    await click("Refresh memory");
    expect(container.textContent).toContain("available: 8 GiB");
    expect(reads).toBe(2);
  });

  it("hides the memory hint when the backend has no memory snapshot", async () => {
    const base = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => name === "get_memory_overview" ? {
      totalMb: null, availableMb: null, recommendedMb: 4096, effectiveMode: "auto", modCount: 0,
    } : base(name, args));
    await render();
    await click("Java");
    expect(container.textContent).not.toContain("System RAM");
    expect(container.querySelector('button[aria-label="Refresh memory"]')).toBeNull();
  });

  it("disables the maximum in automatic mode and saves the initial memory as a number or null", async () => {
    await render();
    await click("Java");
    const maximum = () => container.querySelector<HTMLInputElement>('input[aria-label="Maximum memory (MB)"]')!;
    expect(maximum().disabled).toBe(true);
    await click("Manual memory");
    expect(maximum().disabled).toBe(false);
    await fill("Initial memory (MB)", "1024");
    await click("Save settings");
    expect(mockLauncher.saveConfig).toHaveBeenLastCalledWith(expect.objectContaining({ minMemoryMb: 1024 }), { preserveAppearance: true });
    await fill("Initial memory (MB)", "");
    await click("Save settings");
    expect(mockLauncher.saveConfig).toHaveBeenLastCalledWith(expect.objectContaining({ minMemoryMb: null }), { preserveAppearance: true });
  });

  it("detects Java and saves runtime, memory, JVM and auto-download settings", async () => {
    await render();
    await click("Java");
    await click("Detect Java");
    await click("Java 21");
    await click("Manual memory");
    await fill("Maximum memory (MB)", "8192");
    await fill("JVM arguments", "-XX:+UseG1GC");
    await act(async () => container.querySelector<HTMLInputElement>('input[aria-label="Prepare Java automatically"]')!.click());
    await click("Save settings");
    expect(commandMock).toHaveBeenCalledWith("detect_java");
    expect(mockLauncher.saveConfig).toHaveBeenCalledWith(expect.objectContaining({
      javaPath: "C:\\SyntheticFixture\\java.exe",
      maxMemoryMb: 8192,
      memoryMode: "manual",
      jvmArguments: "-XX:+UseG1GC",
      javaAutoDownload: false,
    }), { preserveAppearance: true });
  });

  it("keeps download source, concurrency and rate limit together", async () => {
    await render();
    await click("Downloads");
    await select("Download source", "bmclapi");
    await fill("Download concurrency", "8");
    await fill("Download limit (KiB/s)", "1024");
    expect(container.textContent).toContain("community mirror");
    await click("Save settings");
    expect(mockLauncher.saveConfig).toHaveBeenCalledWith(expect.objectContaining({ downloadSource: "bmclapi", downloadConcurrency: 8, downloadLimitKib: 1024 }), { preserveAppearance: true });
  });

  it("shows the session download source verdict only for a saved auto source", async () => {
    await render();
    await click("Downloads");
    expect(container.querySelector('[data-testid="download-source-verdict"]')).toBeNull();
    expect(commandMock.mock.calls.some(([name]) => name === "get_download_source_verdict")).toBe(false);
    await select("Download source", "auto");
    // An unsaved switch to auto has no verdict of its own yet.
    expect(container.querySelector('[data-testid="download-source-verdict"]')).toBeNull();
  });

  async function renderAutoVerdict(verdict: unknown) {
    mockLauncher.data.config.downloadSource = "auto";
    mockLauncher.config.downloadSource = "auto";
    commandMock.mockImplementation(async (name) => name === "get_download_source_verdict"
      ? verdict
      : name === "get_service_status" ? { curseforgeConfigured: false } : null);
    await render();
    await click("Downloads");
    expect(commandMock).toHaveBeenCalledWith("get_download_source_verdict");
    return container.querySelector('[data-testid="download-source-verdict"]')?.textContent;
  }

  it("renders a measured verdict for a saved auto source", async () => {
    expect(await renderAutoVerdict({ preferred: "mirror", officialMs: null, mirrorMs: 85, conclusive: true }))
      .toBe("This session: BMCLAPI first (official no answer, BMCLAPI 85 ms).");
    expect(container.textContent).toContain("Official goes first unless it does not answer or is clearly slower");
    expect(container.textContent).toContain("one summary line goes to the local launcher log");
  });

  it("renders the not-yet-measured state for a saved auto source without a verdict", async () => {
    expect(await renderAutoVerdict(null))
      .toBe("Not measured yet in this session. Both sources are measured the first time the version list or a file is fetched.");
  });

  it("does not present an inconclusive verdict as the session's choice", async () => {
    const text = await renderAutoVerdict({ preferred: "official", officialMs: null, mirrorMs: null, conclusive: false });
    expect(text).toBe("Neither source answered. Official goes first for now; both are measured again the next time the version list is fetched, after a minute.");
    expect(text).not.toContain("This session");
  });

  it("stores service configuration in General rather than About", async () => {
    await render();
    expect(container.textContent).toContain("Service connections");
    await fill("CurseForge API Key", "fixture-secret");
    await click("Save key");
    expect(commandMock).toHaveBeenCalledWith("set_service_secret", { service: "curseforge", secret: "fixture-secret" });
    expect(container.textContent).toContain("Configured");
    await click("Clear saved key");
    expect(commandMock).toHaveBeenCalledWith("set_service_secret", { service: "curseforge", secret: "" });
    await fill("Microsoft Client ID", "22222222-2222-2222-2222-222222222222");
    await click("Save settings");
    expect(mockLauncher.saveConfig).toHaveBeenCalledWith(expect.objectContaining({ microsoftClientId: "22222222-2222-2222-2222-222222222222" }), { preserveAppearance: true });
  });

  it("labels the Client ID as optional when a built-in Microsoft app is available", async () => {
    mockLauncher.config.microsoftClientId = "";
    commandMock.mockImplementationOnce(async () => ({ curseforgeConfigured: false, microsoftBuiltin: true }));
    await render();
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Microsoft Client ID"]')!;
    expect(input.closest("label")?.textContent).toContain("Microsoft Client ID (optional)");
    expect(input.placeholder).toBe("Leave empty to use the built-in app");
    expect(input.value).toBe("");
    expect(container.textContent).toContain("A built-in Microsoft app is available. Leave this field empty to use it.");
    await click("Game");
    await fill("Game window width", "1600");
    await click("Save settings");
    expect(mockLauncher.saveConfig).toHaveBeenCalledWith(expect.objectContaining({ microsoftClientId: "" }), { preserveAppearance: true });
  });

  it("shows the build-time CurseForge key fallback without filling the input", async () => {
    commandMock.mockImplementationOnce(async () => ({ curseforgeConfigured: false, curseforgeBuiltin: true }));
    await render();
    const input = container.querySelector<HTMLInputElement>('input[aria-label="CurseForge API Key"]')!;
    expect(input.placeholder).toBe("Leave empty to use the built-in key");
    expect(input.value).toBe("");
  });

  it("keeps a saved CurseForge override ahead of the build-time fallback", async () => {
    commandMock.mockImplementationOnce(async () => ({ curseforgeConfigured: true, curseforgeBuiltin: true }));
    await render();
    const input = container.querySelector<HTMLInputElement>('input[aria-label="CurseForge API Key"]')!;
    expect(input.placeholder).toBe("Encrypted key saved; leave blank to keep it");
    expect(input.value).toBe("");
  });

  it("keeps the existing Client ID label when service status omits the built-in flag", async () => {
    await render();
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Microsoft Client ID"]')!;
    expect(input.closest("label")?.textContent?.trim()).toBe("Microsoft application Client ID");
    expect(input.placeholder).toBe("Client ID from your app registration");
    expect(container.textContent).not.toContain("A built-in Microsoft app is available");
  });

  it("sets and clears a custom background through the existing commands", async () => {
    mocks.open.mockResolvedValue("C:\\SyntheticFixture\\background.png");
    await render();
    await click("Appearance");
    await click("Choose background");
    expect(commandMock).toHaveBeenCalledWith("set_launcher_background", { path: "C:\\SyntheticFixture\\background.png" });
    await click("Reset background");
    expect(commandMock).toHaveBeenCalledWith("set_launcher_background", { path: null });
  });

  it("imports and exports presets without including service secrets", async () => {
    mocks.save.mockResolvedValue("C:\\SyntheticFixture\\preset.json");
    mocks.open.mockResolvedValue("C:\\SyntheticFixture\\preset.json");
    await render();
    await click("Export preset");
    expect(commandMock).toHaveBeenCalledWith("export_launcher_config", { path: "C:\\SyntheticFixture\\preset.json" });
    await click("Import preset");
    expect(commandMock).toHaveBeenCalledWith("import_launcher_config", { path: "C:\\SyntheticFixture\\preset.json" });
    expect(mockLauncher.config.effects).toBe("lite");
    expect(mockLauncher.config.accentSource).toBe("system");
    expect(mockLauncher.reload).toHaveBeenCalled();
    expect(container.textContent).toContain("Preset imported.");
  });

  it("tells the user when an imported preset's heap arguments were ignored", async () => {
    mocks.open.mockResolvedValue("C:\\SyntheticFixture\\preset.json");
    const base = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) => name === "import_launcher_config"
      ? { config: { ...mockLauncher.config }, heapArgumentsRemoved: true } : base(name, args));
    await render();
    await click("Import preset");
    expect(container.textContent).toContain("Its -Xms/-Xmx JVM arguments were ignored");
  });

  it("restores the saved appearance on reset and localizes action errors", async () => {
    mocks.open.mockResolvedValue("C:\\SyntheticFixture\\background.png");
    await render();
    await click("Appearance");
    await select("Effects level", "lite");
    await click("Reset changes");
    expect(mockLauncher.config.effects).toBe("full");
    expect(appearance.effects).toBe("full");
    expect(mockLauncher.saveConfig).not.toHaveBeenCalled();
    commandMock.mockImplementation(async (name) => {
      if (name === "choose_launcher_path") return [await mocks.open()];
      if (name === "set_launcher_background") throw new LauncherError("config.backgroundInvalid");
      return null;
    });
    await click("Choose background");
    expect(container.textContent).toContain("Choose a valid PNG, JPEG, or WebP background no larger than 12 MB.");
    expect(container.textContent).not.toContain("Something went wrong");
  });

  it("shows the expected configuration error when explicit save is rejected", async () => {
    mockLauncher.saveConfig = vi.fn(async () => { throw new LauncherError("config.gameDirectory"); });
    await render();
    await click("Game");
    await fill("Game directory", "relative-path");
    await click("Save settings");
    expect(container.textContent).toContain("The game directory must be an absolute path.");
    expect(container.textContent).not.toContain("Something went wrong");
  });
});

describe("settings search", () => {
  it("lists a matching setting with its section and reveals it after choosing", async () => {
    await render();
    await search("memory");
    const matches = searchResults();
    expect(matches.length).toBeGreaterThan(0);
    const initial = matches.find((candidate) => candidate.textContent?.includes("Initial memory (MB)"));
    expect(initial).toBeTruthy();
    expect(initial!.textContent).toContain("Java");
    await act(async () => initial!.click());
    await settleFrame();
    expect(searchInput().value).toBe("");
    expect(searchResults()).toHaveLength(0);
    const target = container.querySelector<HTMLElement>('[data-settings-target="java-initial-memory"]');
    expect(target).not.toBeNull();
    expect(target!.contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Initial memory (MB)");
  });

  it("clears the query with Escape", async () => {
    await render();
    await search("memory");
    expect(searchInput().value).toBe("memory");
    await act(async () => searchInput().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(searchInput().value).toBe("");
    expect(container.querySelector('ul[aria-label="Matching settings"]')).toBeNull();
  });

  it("shows the no-match message for a query without results", async () => {
    await render();
    await search("zzzzzz");
    expect(searchResults()).toHaveLength(0);
    expect(container.textContent).toContain("No setting matches.");
  });

  it("moves into the results with Arrow Down and chooses the first result with Enter", async () => {
    await render();
    await search("language");
    const input = searchInput();
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.activeElement).toBe(searchResults()[0]);
    await act(async () => {
      input.focus();
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await settleFrame();
    expect(searchInput().value).toBe("");
    const target = container.querySelector<HTMLElement>('[data-settings-target="appearance-language"]');
    expect(target).not.toBeNull();
    expect(target!.contains(document.activeElement)).toBe(true);
  });

  it("reveals the controlling field when a conditional setting is hidden in the current state", async () => {
    await render();
    const cases = [
      { query: "proxy host", target: "downloads-proxy-host", fallback: "downloads-proxy-mode", name: "Launcher proxy mode" },
      { query: "accent color", target: "appearance-accent-color", fallback: "appearance-accent-source", name: "Accent source" },
    ];
    for (const item of cases) {
      await search(item.query);
      await act(async () => searchResult(item.target).click());
      await settleFrame();
      const fallback = container.querySelector<HTMLElement>(`[data-settings-target="${item.fallback}"]`);
      expect(fallback, item.target).not.toBeNull();
      expect(activeElementInside(fallback), item.target).toBe(true);
      expect(accessibleName(document.activeElement), item.target).toBe(item.name);
    }
  });

  it("indexes memory allocation and falls back to it when maximum memory is disabled", async () => {
    await render();
    expect(mockLauncher.config.memoryMode).toBe("auto");
    await search("memory allocation");
    expect(searchResult("java-memory-mode")).toBeTruthy();
    await search("memory");
    await act(async () => searchResult("java-max-memory").click());
    await settleFrame();
    const mode = container.querySelector<HTMLElement>('[data-settings-target="java-memory-mode"]');
    expect(mode).not.toBeNull();
    expect(activeElementInside(mode)).toBe(true);
    expect(accessibleName(document.activeElement)).toBe("Automatic memory");
  });

  it("treats a whitespace-only query as empty", async () => {
    await render();
    await search("   ");
    expect(searchResults()).toHaveLength(0);
    expect(container.textContent).not.toContain("No setting matches.");
    expect(container.querySelector('[data-testid="settings-search-status"]')?.textContent).toBe("");
  });

  it("announces result counts and associates the input with the result list", async () => {
    await render();
    const status = container.querySelector<HTMLElement>('[data-testid="settings-search-status"]');
    expect(status?.getAttribute("role")).toBe("status");
    expect(status?.textContent).toBe("");
    await search("memory");
    const list = container.querySelector<HTMLElement>('ul[aria-label="Matching settings"]');
    expect(list).not.toBeNull();
    expect(list!.id).toBe("vx-settings-search-results");
    expect(searchInput().getAttribute("aria-controls")).toBe(list!.id);
    expect(status?.textContent).toBe("3 matching settings");
    await search("language");
    expect(status?.textContent).toBe("1 matching setting");
    await search("zzzzzz");
    expect(status?.textContent).toBe("No setting matches.");
  });

  it("focuses the named action rather than a sibling or nested field", async () => {
    await render();
    const actions = [
      { query: "Import preset", target: "general-import-preset", name: "Import preset" },
      { query: "Export preset", target: "general-export-preset", name: "Export preset" },
      { query: "Detect Java", target: "java-detect", name: "Detect Java" },
      { query: "Choose background", target: "appearance-background", name: "Choose background" },
      { query: "Test proxy connection", target: "downloads-proxy-test", name: "Test proxy connection" },
      { query: "Check for updates", target: "about-update-actions", name: "Check for updates" },
    ];
    for (const action of actions) {
      await search(action.query);
      await act(async () => searchResult(action.target).click());
      await settleFrame();
      expect(accessibleName(document.activeElement), action.target).toBe(action.name);
      expect(activeElementInside(container.querySelector(`[data-settings-target="${action.target}"]`)),
        action.target).toBe(true);
    }
  });

  it("does not focus a destructive sibling when Check for updates is disabled by a download", async () => {
    updates.current = {
      ...updates.current,
      result: {
        currentVersion: "0.6.0", latestVersion: "0.7.0", status: "newer", source: "github",
        releaseUrl: "https://example.test/release", notes: null, installerSize: 4096,
      },
      status: { key: "downloading" },
      progress: 0.42,
      installing: true,
    };
    await render();
    await search("check for updates");
    await act(async () => searchResult("about-update-actions").click());
    await settleFrame();

    expect(button("Check for updates").disabled).toBe(true);
    const cancel = button("Cancel update");
    expect(cancel.disabled).toBe(false);
    expect(document.activeElement).not.toBe(cancel);
    expect(accessibleName(document.activeElement)).not.toBe("Cancel update");
    const target = container.querySelector<HTMLElement>('[data-settings-target="about-update-actions"]');
    expect(activeElementInside(target)).toBe(true);
  });

  it("does not focus the destructive clear action for Save proxy credentials", async () => {
    const saved = {
      ...mockLauncher.config,
      proxyMode: "custom", proxyScheme: "http", proxyHost: "proxy.example.test", proxyPort: 3128,
      gameProxyMode: "off",
    } satisfies Config;
    mockLauncher.config = mockLauncher.data.config = saved;
    const base = commandMock.getMockImplementation()!;
    commandMock.mockImplementation(async (name, args) =>
      name === "get_service_status"
        ? { curseforgeConfigured: false, proxyCredentialsConfigured: true }
        : base(name, args));
    await render();
    await click("Downloads");
    await settleFrames(2);
    expect(button("Clear proxy credentials")).toBeTruthy();
    await search("save proxy");
    await act(async () => searchResult("downloads-proxy-username").click());
    await settleFrame();
    expect(accessibleName(document.activeElement)).toBe("Proxy username");
    expect(accessibleName(document.activeElement)).not.toBe("Clear proxy credentials");
  });

  it.each(["Proxy username", "Proxy password"])(
    "waits for the credential status before focusing %s",
    async (label) => {
      const saved = {
        ...mockLauncher.config,
        proxyMode: "custom", proxyScheme: "http", proxyHost: "proxy.example.test", proxyPort: 3128,
        gameProxyMode: "off",
      } satisfies Config;
      mockLauncher.config = mockLauncher.data.config = saved;
      let resolveStatus!: (value: { curseforgeConfigured: boolean; proxyCredentialsConfigured: boolean }) => void;
      const pending = new Promise<{ curseforgeConfigured: boolean; proxyCredentialsConfigured: boolean }>((resolve) => {
        resolveStatus = resolve;
      });
      const base = commandMock.getMockImplementation()!;
      commandMock.mockImplementation(async (name, args) =>
        name === "get_service_status" ? pending : base(name, args));
      await render();
      await search(label.toLowerCase());
      const target = label === "Proxy username" ? "downloads-proxy-username" : "downloads-proxy-password";
      await act(async () => searchResult(target).click());
      await settleFrame();
      const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
      expect(input).not.toBeNull();
      expect(input!.disabled).toBe(true);
      await act(async () => {
        resolveStatus({ curseforgeConfigured: false, proxyCredentialsConfigured: false });
        await pending;
      });
      await settleFrames(3);
      expect(document.activeElement).toBe(input);
    },
  );

  it("scrolls the target to the center and clears the reveal highlight after 1.5 seconds", async () => {
    await render();
    await search("language");
    await act(async () => searchResult("appearance-language").click());
    await settleFrame();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
    const target = container.querySelector<HTMLElement>('[data-settings-target="appearance-language"]');
    expect(target).not.toBeNull();
    expect(target!.classList.contains("vx-settings-target-revealed")).toBe(true);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1600)); });
    expect(target!.classList.contains("vx-settings-target-revealed")).toBe(false);
  });

  it("reveals every indexed setting in the default configuration without leaving focus on body", async () => {
    const i18n = createLauncherI18n("en-US", "en-US");
    await i18n.initPromise;
    const t = (key: string) => i18n.t(key);
    await render();
    for (const entry of settingsIndex) {
      await search(t(entry.labelKey));
      const result = searchResult(entry.target);
      await act(async () => result.click());
      await settleFrame();
      const active = document.activeElement;
      expect(active, `${entry.target} left focus on <body>`).not.toBe(document.body);
      const primary = container.querySelector(`[data-settings-target="${entry.target}"]`);
      const fallback = entry.fallbackTarget
        ? container.querySelector(`[data-settings-target="${entry.fallbackTarget}"]`)
        : null;
      expect(activeElementInside(primary) || activeElementInside(fallback),
        `${entry.target} focused ${accessibleName(active)} outside its target`).toBe(true);
    }
  }, 30000);
});

describe("settings search styles", () => {
  const css = () => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "settings.css"), "utf8");

  it("holds the reveal outline before fading it over 1.5 seconds", () => {
    const source = css();
    expect(source).toMatch(/\.vx-settings-target-revealed\s*\{[^}]*animation:\s*vx-settings-target-reveal 1\.5s/);
    expect(source).toMatch(/@keyframes vx-settings-target-reveal\s*\{\s*0%,\s*65%\s*\{\s*outline-color:\s*var\(--accent(?:-indicator)?\)/);
    expect(source).toMatch(/\[data-reduced-motion="true"\]\s+\.vx-settings-target-revealed\s*\{[^}]*animation:\s*none/);
  });

  it("keeps the shared focus ring inside the scrolling result list", () => {
    expect(css()).toMatch(/\.vx-settings-search-results button:focus-visible\s*\{\s*outline-offset:\s*-2px/);
  });
});

describe("Settings review request", () => {
  it("opens About and focuses the update action once, not on every return to About", async () => {
    const i18n = createLauncherI18n("en-US", "en-US");
    await i18n.initPromise;
    await act(async () => root.render(createElement(I18nextProvider, { i18n }, createElement(SettingsPage, { reviewUpdates: 1 }))));
    expect(container.textContent).toContain("Updates");
    expect(document.activeElement?.textContent?.trim()).toBe("Check for updates");
    await click("General");
    await click("About");
    expect(document.activeElement?.textContent?.trim()).not.toBe("Check for updates");
  });

  it("configures Lumen provider, encrypted API key, permission tier, proactive wake, and local MCP server", async () => {
    await render();
    await click("Lumen & MCP");
    await select("Provider", "anthropic");
    await fill("Model", "claude-sonnet-4-20250514");
    await fill("Lumen API key", "sk-ant-synthetic-key");
    await click("Save key");
    expect(commandMock).toHaveBeenCalledWith("set_assistant_api_key", { secret: "sk-ant-synthetic-key" });
    expect(container.textContent).toContain("Lumen API key saved with system encryption.");
    await click("Controlled");
    const proactive = container.querySelector<HTMLInputElement>('input[aria-label="Proactively wake Lumen on game crashes"]')!;
    expect(proactive.checked).toBe(true);
    await act(async () => proactive.click());
    await click("Save settings");
    expect(mockLauncher.saveConfig).toHaveBeenCalledWith(expect.objectContaining({
      assistantProvider: "anthropic",
      assistantModel: "claude-sonnet-4-20250514",
      assistantPermission: "controlled",
      assistantProactive: false,
    }), { preserveAppearance: true });

    await click("Start MCP server");
    expect(commandMock).toHaveBeenCalledWith("start_mcp_server", { port: 25590 });
    expect(container.textContent).toContain("127.0.0.1:25590/mcp");
    await click("Rotate token");
    expect(commandMock).toHaveBeenCalledWith("rotate_mcp_token");
    expect(container.textContent).toContain("••••••••999999");
    await click("Stop MCP server");
    expect(commandMock).toHaveBeenCalledWith("stop_mcp_server");
    expect(container.textContent).toContain("Stopped.");
  });

  it("restores initial launcher state from Settings → General after confirmation", async () => {
    await render();
    await click("Restore initial state");
    const dialog = document.querySelector<HTMLDialogElement>("dialog[open]")!;
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain("Your Minecraft game directory");
    const confirm = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.trim() === "Restore now",
    )!;
    await act(async () => confirm.click());
    expect(commandMock).toHaveBeenCalledWith("reset_launcher_state");
    expect(mockLauncher.reload).toHaveBeenCalled();
    expect(container.textContent).toContain("Launcher restored to its initial state.");
  });

  it("auto-detects local proxy listeners in Downloads settings and applies them with one click", async () => {
    await render();
    await click("Downloads");
    await settleFrame();
    expect(commandMock).toHaveBeenCalledWith("detect_local_proxies");
    expect(container.textContent).toContain("http://127.0.0.1:7897");
    expect(container.textContent).toContain("Clash Verge / Mihomo");
    await click("Use");
    await click("Save settings");
    expect(mockLauncher.saveConfig).toHaveBeenCalledWith(expect.objectContaining({
      proxyMode: "custom",
      proxyScheme: "http",
      proxyHost: "127.0.0.1",
      proxyPort: 7897,
    }), { preserveAppearance: true });
  });

  it("switches the update channel between Stable and Beta immediately and supports search by beta", async () => {
    await render();
    await search("beta");
    expect(searchResult("about-update-channel")).toBeTruthy();
    await click("About");
    await select("Update channel", "beta");
    expect(commandMock).toHaveBeenCalledWith("set_launcher_update_preferences", {
      checkForUpdates: true,
      updateSource: "auto",
      updateChannel: "beta",
    });
    expect(updates.current.sourceChanged).toHaveBeenCalledTimes(1);
  });
});
