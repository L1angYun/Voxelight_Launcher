// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { command, defaults, type Bootstrap, type Config } from "../../lib/launcher";
import { LauncherError } from "../../lib/errors";
import type { LauncherContextValue } from "../../app/controller/types";
import { createLauncherI18n } from "../../i18n";
import { SettingsPage } from "./SettingsPage";

const mocks = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn(), openUrl: vi.fn() }));
const commandMock = vi.mocked(command);
let mockLauncher: LauncherContextValue;
let appearance: { effects: string; accentColor: string; resolvedTheme: string };
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
  useAppearance: () => appearance,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open, save: mocks.save }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));
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
    progress: null,
    logs: [],
    busy: "",
    notice: null,
    gamePid: undefined,
    reload: vi.fn(async () => {}),
    saveConfig: vi.fn(async () => true),
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
  commandMock.mockReset();
  commandMock.mockImplementation(async (name, args) => {
    if (name === "get_service_status") return { curseforgeConfigured: false };
    if (name === "set_service_secret") return Boolean(args?.secret);
    if (name === "detect_java") return [{ path: "C:\\SyntheticFixture\\java.exe", version: "21.0.1", major: 21 }];
    if (name === "set_launcher_background") return { ...mockLauncher.config, customBackground: args?.path ?? null };
    if (name === "export_launcher_config") return args?.path;
    if (name === "import_launcher_config") return { ...mockLauncher.config, effects: "lite", accentSource: "system" };
    return null;
  });
  mocks.open.mockReset();
  mocks.save.mockReset();
  mocks.openUrl.mockReset();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.getAttribute("role") === "combobox" ? new DOMRect(24, 200, 320, 44) : new DOMRect();
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
    expect(mockLauncher.saveConfig).toHaveBeenCalledWith(expect.objectContaining({ worldScene: "massif", worldMaterial: "solid" }));
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
    }));
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
    expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ directory: true }));
    expect(mockLauncher.saveConfig).toHaveBeenCalledWith(expect.objectContaining({
      gameDirectory: "C:\\ChangedFixture",
      versionIsolation: false,
      screenWidth: 1600,
      screenHeight: 900,
    }));
  });

  it("detects Java and saves runtime, memory, JVM and auto-download settings", async () => {
    await render();
    await click("Java");
    await click("Detect Java");
    await click("Java 21");
    await fill("Maximum memory (MB)", "8192");
    await fill("JVM arguments", "-XX:+UseG1GC");
    await act(async () => container.querySelector<HTMLInputElement>('input[aria-label="Prepare Java automatically"]')!.click());
    await click("Save settings");
    expect(commandMock).toHaveBeenCalledWith("detect_java");
    expect(mockLauncher.saveConfig).toHaveBeenCalledWith(expect.objectContaining({
      javaPath: "C:\\SyntheticFixture\\java.exe",
      maxMemoryMb: 8192,
      jvmArguments: "-XX:+UseG1GC",
      javaAutoDownload: false,
    }));
  });

  it("keeps download source, concurrency and rate limit together", async () => {
    await render();
    await click("Downloads");
    await select("Download source", "bmclapi");
    await fill("Download concurrency", "8");
    await fill("Download limit (KiB/s)", "1024");
    expect(container.textContent).toContain("community mirror");
    await click("Save settings");
    expect(mockLauncher.saveConfig).toHaveBeenCalledWith(expect.objectContaining({ downloadSource: "bmclapi", downloadConcurrency: 8, downloadLimitKib: 1024 }));
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
    expect(mockLauncher.saveConfig).toHaveBeenCalledWith(expect.objectContaining({ microsoftClientId: "22222222-2222-2222-2222-222222222222" }));
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
    expect(mockLauncher.saveConfig).toHaveBeenCalledWith(expect.objectContaining({ microsoftClientId: "" }));
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
      if (name === "set_launcher_background") throw new LauncherError("config.backgroundInvalid");
      return null;
    });
    await click("Choose background");
    expect(container.textContent).toContain("Choose a valid PNG, JPEG, or WebP background no larger than 12 MB.");
    expect(container.textContent).not.toContain("Something went wrong");
  });

  it("shows the expected configuration error when explicit save is rejected", async () => {
    mockLauncher.saveConfig = vi.fn(async () => {
      mockLauncher.notice = { kind: "error", code: "config.gameDirectory", params: {}, error: new LauncherError("config.gameDirectory") };
      return false;
    });
    await render();
    await click("Game");
    await fill("Game directory", "relative-path");
    await click("Save settings");
    expect(container.textContent).toContain("The game directory must be an absolute path.");
    expect(container.textContent).not.toContain("Something went wrong");
  });
});
