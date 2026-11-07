// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { GlassProvider } from "../../visual/glass/GlassSystem";
import { command, defaults, type Account, type Bootstrap } from "../../lib/launcher";
import { useDefaultSkin } from "../../lib/defaultSkin";
import type { PlayerProfile } from "../../lib/playerProfile";
import type { LauncherContextValue } from "../../app/controller/types";
import { createLauncherI18n } from "../../i18n";
import { AccountsPage } from "./AccountsPage";

const mocks = vi.hoisted(() => ({
  character: vi.fn(),
  open: vi.fn(),
  openUrl: vi.fn(),
}));
const commandMock = vi.mocked(command);
const defaultSkinMock = vi.mocked(useDefaultSkin);
let mockLauncher: LauncherContextValue;
let root: Root;
let container: HTMLDivElement;
let reducedMotion = false;
let highContrast = false;
let reducedTransparency = false;
let effects: "full" | "lite" = "full";

vi.mock("../../lib/launcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/launcher")>()),
  command: vi.fn(),
  desktop: true,
}));
vi.mock("../../lib/defaultSkin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/defaultSkin")>()),
  useDefaultSkin: vi.fn(),
}));
vi.mock("../../app/controller/LauncherProvider", () => ({
  useLauncher: () => mockLauncher,
}));
vi.mock("../../app/AppearanceProvider", () => ({
  useAppearance: () => ({ effects, reducedMotion, reducedTransparency, highContrast }),
}));
vi.mock("../../visual/character/CharacterCanvas", () => ({
  CharacterCanvas: (props: unknown) => {
    mocks.character(props);
    return null;
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));

const microsoft: Account = {
  id: "fixture-classic",
  username: "CyanFixture",
  uuid: "11111111111111111111111111111111",
  type: "microsoft",
  isSelected: true,
  skinUrl: "fixture-skin",
  skinModel: "slim",
};
const authlib: Account = {
  id: "fixture-authlib",
  username: "AmberFixture",
  uuid: "22222222222222222222222222222222",
  type: "authlib",
  isSelected: false,
  skinUrl: null,
  skinModel: "classic",
  authlibServer: "https://auth.example.invalid/api/",
};
const profile: PlayerProfile = {
  id: microsoft.uuid,
  name: microsoft.username,
  skins: [{ id: "skin", state: "ACTIVE", url: "fixture-skin", variant: "slim" }],
  capes: [{ id: "cape", state: "ACTIVE", url: "fixture-cape", alias: "Fixture cape" }],
};
const device = {
  sessionId: "device-fixture",
  userCode: "TEST-CODE",
  verificationUri: "https://microsoft.com/devicelogin",
  expiresIn: 30,
  interval: 5,
  message: "Fixture authorization",
};

function fixture(): LauncherContextValue {
  const config = { ...defaults, microsoftClientId: "fixture-client-id", defaultSkin: "steve" as const };
  const data: Bootstrap = {
    config,
    accounts: [microsoft, authlib],
    instances: [],
    installedVersions: [],
    capabilities: {},
  };
  return {
    bootstrapped: true,
    data,
    config,
    manifest: null,
    activeAccount: microsoft,
    accountAppearance: {
      profile,
      setProfile: vi.fn(),
      skinUrl: "fixture-skin",
      model: "slim",
      capeUrl: "fixture-cape",
      hasAccountSkin: true,
      loading: false,
      error: "",
      refresh: vi.fn(),
    },
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

function setAccounts(accounts: Account[]) {
  mockLauncher.data.accounts = accounts;
  mockLauncher.activeAccount = accounts.find((account) => account.isSelected);
}

function setMicrosoftClient(builtin: boolean, clientId: string) {
  mockLauncher.config.microsoftClientId = clientId;
  mockLauncher.data.capabilities.microsoftBuiltinClientId = builtin;
}

async function render(language: "en-US" | "zh-CN" = "en-US") {
  const i18n = createLauncherI18n(language, language);
  await i18n.initPromise;
  await act(async () => root.render(createElement(I18nextProvider, { i18n },
    createElement(GlassProvider, { effects: "lite", reducedMotion: true }, createElement(AccountsPage)))));
}

function button(label: string, scope: ParentNode = container): HTMLButtonElement {
  const found = Array.from(scope.querySelectorAll<HTMLButtonElement>("button"))
    .find((candidate) => candidate.textContent?.trim() === label || candidate.getAttribute("aria-label") === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

function buttonContaining(label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
    .find((candidate) => candidate.textContent?.includes(label));
  if (!found) throw new Error(`Missing button containing: ${label}`);
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

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.getAttribute("role") === "combobox" ? new DOMRect(24, 200, 280, 44) : new DOMRect();
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mockLauncher = fixture();
  reducedMotion = false;
  highContrast = false;
  reducedTransparency = false;
  effects = "full";
  mocks.character.mockReset();
  mocks.open.mockReset();
  mocks.openUrl.mockReset();
  commandMock.mockReset();
  commandMock.mockImplementation(async (name, args) => {
    if (name === "begin_microsoft_login") return device;
    if (name === "login_authlib") return {
      status: "selectProfile",
      sessionId: "authlib-session",
      profiles: [{ id: "profile-one", name: "First" }, { id: "profile-two", name: "Second" }],
      account: null,
    };
    if (name === "save_config") return args?.config;
    if (["upload_account_skin", "reset_account_skin", "select_account_cape", "get_player_profile"].includes(name)) return profile;
    if (name === "poll_microsoft_login") return { status: "pending", retryAfterSeconds: 5, account: null };
    return null;
  });
  defaultSkinMock.mockReturnValue({
    skin: { id: "steve", name: "Steve", dataUrl: "fixture-steve", model: "classic" },
    loading: false,
    error: "",
    refresh: vi.fn(),
  });
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:fixture-local") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function () { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function () { this.open = false; this.dispatchEvent(new Event("close")); } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("accounts and appearance", () => {
  it("introduces account content with its existing subtitle", async () => {
    await render();
    expect(container.querySelector(".vx-page-header__text p")?.textContent).toBe("Accounts, online appearance, and local previews.");
  });
  it("uses account terminology and localized model names while retaining the Players page title", async () => {
    await render("zh-CN");
    expect(container.querySelector("h1")?.textContent).toBe("角色");
    expect(container.textContent).toContain("添加账号");
    expect(container.textContent).not.toContain("添加角色");
    expect(container.textContent).not.toMatch(/Classic|Slim/);
  });
  it("names the current zh account while retaining the Players page title", async () => {
    await render("zh-CN");
    expect(container.querySelector('.vx-account-choice[aria-current="true"]')?.getAttribute("aria-label"))
      .toBe("当前账号 CyanFixture");
    expect(container.querySelector("h1")?.textContent).toBe("角色");
  });
  it("names the empty zh account list without confusing accounts and characters", async () => {
    setAccounts([]);
    await render("zh-CN");
    expect(container.querySelector(".vx-account-list .vx-empty h2")?.textContent).toBe("还没有账号");
    expect(container.querySelector("h1")?.textContent).toBe("角色");
  });

  it("uses automatic login tabs with labelled panels before a device flow", async () => {
    await render(); await click("Add account");
    const microsoft = button("Microsoft"), offline = button("Offline");
    microsoft.focus();
    await act(async () => microsoft.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(offline);
    expect(offline.getAttribute("aria-selected")).toBe("true");
    const panel = container.querySelector('dialog[open] [role="tabpanel"]')!;
    expect(panel.getAttribute("aria-labelledby")).toBe(offline.id);
    expect(offline.id).not.toBe("");
  });

  it("preserves the required Client ID field and disabled Start in a public build", async () => {
    setMicrosoftClient(false, "");
    await render(); await click("Add account");
    expect(container.querySelector('input[aria-label="Microsoft Client ID for this project"]')).not.toBeNull();
    expect(button("Start Microsoft login").disabled).toBe(true);
    expect(container.textContent).toContain("Register your own public client app");
    expect(container.querySelector("dialog details")).toBeNull();
  });

  it("starts with the built-in app without exposing or saving a Client ID", async () => {
    setMicrosoftClient(true, "");
    await render(); await click("Add account");
    const details = container.querySelector<HTMLDetailsElement>("dialog details");
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(container.querySelector('input[aria-label="Microsoft Client ID for this project"]')).toBeNull();
    expect(details?.querySelector<HTMLInputElement>("input")?.value).toBe("");
    expect(container.textContent).toContain("Using the built-in Microsoft app.");
    expect(container.textContent).not.toContain("Register your own public client app");
    expect(button("Start Microsoft login").disabled).toBe(false);
    vi.useFakeTimers();
    await click("Start Microsoft login");
    expect(commandMock).toHaveBeenCalledWith("begin_microsoft_login");
    expect(commandMock).not.toHaveBeenCalledWith("save_config", expect.anything());
    expect(commandMock.mock.calls.find(([name]) => name === "begin_microsoft_login")).toEqual(["begin_microsoft_login"]);
    expect(container.textContent).toContain("TEST-CODE");
  });

  it("shows a persisted override and restores the built-in app by saving an empty override", async () => {
    setMicrosoftClient(true, "22222222-2222-2222-2222-222222222222");
    await render(); await click("Add account");
    expect(container.querySelector<HTMLDetailsElement>("dialog details")?.open).toBe(true);
    expect(container.textContent).toContain("Using your saved custom Microsoft Client ID.");
    await click("Restore built-in app");
    expect(commandMock).toHaveBeenCalledWith("save_config", {
      config: expect.objectContaining({ microsoftClientId: "" }),
    });
    expect(mockLauncher.reload).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Restored the built-in Microsoft app.");
    expect(container.textContent).toContain("Using the built-in Microsoft app.");
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Custom Microsoft Client ID (optional)"]')?.value).toBe("");
  });

  it("keeps restore available for the persisted override after its draft is cleared", async () => {
    setMicrosoftClient(true, "22222222-2222-2222-2222-222222222222");
    await render(); await click("Add account");
    await fill("Custom Microsoft Client ID (optional)", "");
    expect(container.textContent).toContain("Using your saved custom Microsoft Client ID.");
    expect(button("Restore built-in app").disabled).toBe(false);
    vi.useFakeTimers();
    await click("Start Microsoft login");
    expect(commandMock.mock.calls.slice(0, 2)).toEqual([
      ["save_config", { config: expect.objectContaining({ microsoftClientId: "" }) }],
      ["begin_microsoft_login"],
    ]);
  });

  it("saves a custom override before starting built-in-capable Microsoft login", async () => {
    setMicrosoftClient(true, "");
    await render(); await click("Add account");
    const details = container.querySelector<HTMLDetailsElement>("dialog details")!;
    await act(async () => { details.open = true; });
    await fill("Custom Microsoft Client ID (optional)", "22222222-2222-2222-2222-222222222222");
    vi.useFakeTimers();
    await click("Start Microsoft login");
    expect(commandMock.mock.calls.slice(0, 2)).toEqual([
      ["save_config", { config: expect.objectContaining({ microsoftClientId: "22222222-2222-2222-2222-222222222222" }) }],
      ["begin_microsoft_login"],
    ]);
  });

  it("marks a newly saved custom Client ID as the active persisted override", async () => {
    setMicrosoftClient(true, "");
    await render(); await click("Add account");
    const details = container.querySelector<HTMLDetailsElement>("dialog details")!;
    await act(async () => { details.open = true; });
    await fill("Custom Microsoft Client ID (optional)", "22222222-2222-2222-2222-222222222222");
    expect(container.textContent).toContain("Using the built-in Microsoft app.");
    await click("Save Client ID");
    expect(container.textContent).toContain("Using your saved custom Microsoft Client ID.");
    expect(button("Restore built-in app").disabled).toBe(false);
  });

  it("disables override editing and restore while Microsoft login is starting", async () => {
    setMicrosoftClient(true, "22222222-2222-2222-2222-222222222222");
    await render(); await click("Add account");
    let complete!: (value: typeof device) => void;
    commandMock.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    vi.useFakeTimers();
    await click("Start Microsoft login");
    expect(button("Restore built-in app").disabled).toBe(true);
    expect(button("Save Client ID").disabled).toBe(true);
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Custom Microsoft Client ID (optional)"]')?.disabled).toBe(true);
    await click("Restore built-in app");
    expect(commandMock).not.toHaveBeenCalledWith("save_config", expect.anything());
    await act(async () => complete(device));
    expect(container.textContent).toContain("TEST-CODE");
  });

  it.each([
    ["en-US", "auth.clientRejected", "Enable public client flows and personal Microsoft accounts"],
    ["en-US", "auth.appNotApproved", "Your Microsoft login succeeded, but this app has not passed Mojang's Minecraft API review"],
    ["en-US", "auth.rateLimited", "Too many authentication requests"],
    ["en-US", "auth.minecraftExchangeFailed", "Minecraft could not complete sign-in"],
    ["en-US", "auth.xboxFailed", "Xbox authentication failed"],
    ["zh-CN", "auth.clientRejected", "允许公共客户端流"],
    ["zh-CN", "auth.appNotApproved", "Microsoft 账号已登录成功，但此应用尚未通过 Mojang 的 Minecraft API 审核"],
    ["zh-CN", "auth.rateLimited", "认证请求过于频繁"],
    ["zh-CN", "auth.minecraftExchangeFailed", "Minecraft 登录交换失败"],
    ["zh-CN", "auth.xboxFailed", "Xbox 认证失败"],
  ] as const)("localizes %s Microsoft login error %s", async (language, code, message) => {
    await render(language); await click(language === "zh-CN" ? "添加账号" : "Add account");
    commandMock.mockRejectedValueOnce({ code });
    await click(language === "zh-CN" ? "开始 Microsoft 登录" : "Start Microsoft login");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(message);
    expect(container.querySelector('[role="alert"]')?.textContent).not.toContain("Something went wrong");
  });
  it("does not cancel a device flow when arrow keys move login-tab focus", async () => {
    await render(); await click("Add account"); vi.useFakeTimers();
    await click("Start Microsoft login");
    const microsoft = button("Microsoft"), offline = button("Offline");
    microsoft.focus(); commandMock.mockClear();
    await act(async () => microsoft.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(offline);
    expect(microsoft.getAttribute("aria-selected")).toBe("true");
    expect(microsoft.tabIndex).toBe(0);
    expect(offline.tabIndex).toBe(-1);
    expect(container.textContent).toContain("TEST-CODE");
    expect(commandMock).not.toHaveBeenCalledWith("cancel_auth_login", expect.anything());
    await act(async () => offline.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(microsoft);
    await act(async () => microsoft.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })));
    await act(async () => microsoft.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })));
    expect(container.textContent).toContain("TEST-CODE");
    expect(commandMock).not.toHaveBeenCalledWith("cancel_auth_login", expect.anything());
    await act(async () => offline.click());
    expect(offline.getAttribute("aria-selected")).toBe("true");
    expect(commandMock).toHaveBeenCalledWith("cancel_auth_login", { sessionId: device.sessionId });
    expect(commandMock.mock.calls.filter(([name]) => name === "cancel_auth_login")).toHaveLength(1);
  });
  it("keeps the current account focusable and named while activating it is a no-op", async () => {
    await render();
    const current = container.querySelector<HTMLButtonElement>('.vx-account-choice[aria-current="true"]')!;
    expect(current.disabled).toBe(false);
    expect(current.getAttribute("aria-label")).toContain("Current");
    current.focus(); expect(document.activeElement).toBe(current);
    commandMock.mockClear();
    await act(async () => current.click());
    expect(commandMock).not.toHaveBeenCalled();
    expect(current.querySelector(".lucide-check")).toBeNull();
  });
  it.each([
    { mode: "full", effects: "full" as const, reduce: false, contrast: false, transparency: false, delay: 280 },
    { mode: "lite", effects: "lite" as const, reduce: false, contrast: false, transparency: false, delay: 280 },
    { mode: "reduced transparency", effects: "full" as const, reduce: false, contrast: false, transparency: true, delay: 280 },
    { mode: "reduced motion", effects: "full" as const, reduce: true, contrast: false, transparency: false, delay: 0 },
    { mode: "high contrast", effects: "full" as const, reduce: false, contrast: true, transparency: false, delay: 0 },
  ])("uses the appropriate character creation delay for $mode", async (preference) => {
    effects = preference.effects;
    reducedMotion = preference.reduce;
    highContrast = preference.contrast;
    reducedTransparency = preference.transparency;
    await render();
    expect(mocks.character).toHaveBeenLastCalledWith(expect.objectContaining({ deferMs: preference.delay }));
    if (preference.transparency) {
      expect(mocks.character).toHaveBeenLastCalledWith(expect.objectContaining({ autoRotate: true, animation: "idle" }));
    }
  });

  it("keeps the no-account default clearly labeled as a local preview", async () => {
    setAccounts([]);
    await render();
    expect(container.textContent).toContain("No accounts yet");
    expect(container.textContent).toContain("Local preview only");
    expect(container.textContent).not.toContain("Microsoft skin updated");
    expect(mocks.character).toHaveBeenCalledWith(expect.objectContaining({ skinUrl: "fixture-steve" }));
    expect(commandMock).not.toHaveBeenCalledWith("upload_account_skin", expect.anything());
  });

  it("creates an offline account through the new login dialog", async () => {
    setAccounts([]);
    await render();
    await click("Add account");
    await click("Offline");
    await fill("Player name", "Fixture_Player");
    await click("Add offline account");
    expect(commandMock).toHaveBeenCalledWith("add_offline_account", { username: "Fixture_Player" });
    expect(mockLauncher.reload).toHaveBeenCalledTimes(1);
    expect(container.querySelector("dialog")?.open).toBe(false);
  });

  it("selects, refreshes and removes accounts with their existing IPC arguments", async () => {
    await render();
    await click("Select AmberFixture");
    expect(commandMock).toHaveBeenCalledWith("select_account", { accountId: authlib.id });
    await click("Refresh CyanFixture session");
    expect(commandMock).toHaveBeenCalledWith("refresh_account", { accountId: microsoft.id });
    await click("Remove AmberFixture");
    expect(commandMock).toHaveBeenCalledWith("remove_account", { accountId: authlib.id });
    expect(mockLauncher.reload).toHaveBeenCalledTimes(3);
  });

  it("cancels the active Microsoft device session without polling or adding an account", async () => {
    await render();
    await click("Add account");
    vi.useFakeTimers();
    await click("Start Microsoft login");
    expect(container.textContent).toContain("TEST-CODE");
    await click("Cancel authorization");
    expect(commandMock).toHaveBeenCalledWith("cancel_auth_login", { sessionId: device.sessionId });
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(commandMock).not.toHaveBeenCalledWith("poll_microsoft_login", expect.anything());
    expect(mockLauncher.reload).not.toHaveBeenCalled();
  });

  it("selects an Authlib profile and clears the password immediately", async () => {
    await render();
    await click("Add account");
    await click("Authlib");
    await fill("Authlib API URL", "https://auth.example.invalid/api/");
    await fill("Username or email", "fixture-user");
    await fill("Password", "fixture-password");
    await click("Sign in with Authlib");
    expect(commandMock).toHaveBeenCalledWith("login_authlib", {
      server: "https://auth.example.invalid/api/",
      username: "fixture-user",
      password: "fixture-password",
      profileId: null,
    });
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Password"]')).toBeNull();
    await act(async () => buttonContaining("Second").click());
    expect(commandMock).toHaveBeenCalledWith("select_authlib_profile", { sessionId: "authlib-session", profileId: "profile-two" });
    expect(mockLauncher.reload).toHaveBeenCalledTimes(1);
  });

  it("shows a neutral profile failure with retry and never substitutes the default character", async () => {
    mockLauncher.accountAppearance = {
      ...mockLauncher.accountAppearance,
      profile: null,
      skinUrl: undefined,
      capeUrl: undefined,
      hasAccountSkin: false,
      error: "fixture diagnostic",
      errorCode: "auth.profileUnavailable",
    };
    await render();
    expect(container.textContent).toContain("We couldn't load this account's appearance.");
    expect(mocks.character).not.toHaveBeenCalled();
    await click("Retry appearance");
    expect(mockLauncher.accountAppearance.refresh).toHaveBeenCalledTimes(1);
  });

  it("handles an empty skin and cape profile without inventing content", async () => {
    mockLauncher.accountAppearance = {
      ...mockLauncher.accountAppearance,
      profile: { ...profile, skins: [], capes: [] },
      skinUrl: undefined,
      capeUrl: undefined,
      hasAccountSkin: false,
    };
    await render();
    expect(container.textContent).toContain("No account skin is available");
    expect(container.textContent).toContain("No capes are available");
    expect(container.querySelector('[role="combobox"][aria-label="Cape"]')).toBeNull();
    expect(mocks.character).not.toHaveBeenCalled();
  });

  it("uploads, resets and changes capes only after explicit online-account actions", async () => {
    mocks.open.mockResolvedValue("E:\\fixtures\\skin.png");
    await render();
    expect(commandMock).not.toHaveBeenCalledWith("upload_account_skin", expect.anything());
    await click("Upload skin");
    expect(commandMock).toHaveBeenCalledWith("upload_account_skin", { accountId: microsoft.id, path: "E:\\fixtures\\skin.png", model: "slim" });
    expect(container.textContent).toContain("Microsoft skin updated");
    await click("Reset skin");
    expect(commandMock).toHaveBeenCalledWith("reset_account_skin", { accountId: microsoft.id });
    const cape = container.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Cape"]')!;
    await act(async () => cape.click());
    await act(async () => document.querySelector<HTMLElement>('[role="option"][data-value=""]')!.click());
    expect(commandMock).toHaveBeenCalledWith("select_account_cape", { accountId: microsoft.id, capeId: null });
    expect(mockLauncher.accountAppearance.setProfile).toHaveBeenCalledWith(profile);
  });

  it("does not upload when the native skin picker is cancelled", async () => {
    mocks.open.mockResolvedValue(null);
    await render();
    await click("Upload skin");
    expect(commandMock).not.toHaveBeenCalledWith("upload_account_skin", expect.anything());
    expect(mockLauncher.reload).not.toHaveBeenCalled();
  });

  it("loads a URL only into the local preview and never claims an online update", async () => {
    await render();
    expect(container.querySelector('[aria-label="Online account source · changes below require an explicit action"]')).not.toBeNull();
    await click("Local preview");
    expect(container.querySelector('[aria-label="Local preview only · does not change your account"]')).not.toBeNull();
    await fill("Online skin URL", "https://example.invalid/skin.png");
    await click("Load URL");
    expect(mocks.character).toHaveBeenCalledWith(expect.objectContaining({ skinUrl: "https://example.invalid/skin.png" }));
    expect(container.textContent).toContain("Local preview only");
    expect(container.textContent).not.toContain("Microsoft skin updated");
    expect(commandMock).not.toHaveBeenCalledWith("upload_account_skin", expect.anything());
  });

  it("imports a PNG into the local preview without calling an account mutation", async () => {
    await render();
    await click("Local preview");
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Import local PNG"]')!;
    const file = new File(["fixture"], "local.png", { type: "image/png" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    expect(mocks.character).toHaveBeenCalledWith(expect.objectContaining({ skinUrl: "blob:fixture-local" }));
    expect(commandMock).not.toHaveBeenCalledWith("upload_account_skin", expect.anything());
  });

  it("saves the default preview character separately from the online account", async () => {
    await render();
    await click("Local preview");
    const alex = container.querySelector<HTMLInputElement>('input[aria-label="Alex"]')!;
    await act(async () => alex.click());
    expect(commandMock).toHaveBeenCalledWith("save_config", {
      config: expect.objectContaining({ defaultSkin: "alex" }),
    });
    expect(commandMock).not.toHaveBeenCalledWith("upload_account_skin", expect.anything());
  });

  it("offers only Steve and Alex as default preview characters", async () => {
    await render();
    await click("Local preview");
    expect(container.querySelector('input[aria-label="Lumen"]')).toBeNull();
    expect(container.querySelector('input[aria-label="Steve"]')).not.toBeNull();
    expect(container.querySelector('input[aria-label="Alex"]')).not.toBeNull();
  });

  it("shows reduced-motion controls without claiming automatic motion is active", async () => {
    reducedMotion = true;
    await render();
    await click("Local preview");
    const rotate = button("Auto-rotate");
    expect(rotate.disabled).toBe(true);
    expect(rotate.getAttribute("aria-pressed")).toBe("false");
    const animation = container.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Preview animation"]')!;
    expect(animation.textContent).toContain("Still");
    expect(animation.disabled).toBe(true);
    expect(container.textContent).toContain("Reduced motion is enabled");
  });
});
