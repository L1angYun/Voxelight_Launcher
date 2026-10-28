import { expect, test, type Page } from "@playwright/test";
import { installLauncherFixture } from "./fixtures";

const device = {
  sessionId: "device-e2e-fixture",
  userCode: "E2E-CODE",
  verificationUri: "https://microsoft.com/devicelogin",
  expiresIn: 30,
  interval: 5,
  message: "Synthetic authorization",
};

function internals(page: Page) {
  return page.evaluate(() => (window as unknown as {
    __appearanceFixtures: { calls: { name: string; args?: Record<string, unknown> }[] };
  }).__appearanceFixtures.calls);
}

function mockAccountCommands(page: Page) {
  return page.addInitScript((device) => {
    const internals = (window as unknown as {
      __TAURI_INTERNALS__: {
        invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
      };
    }).__TAURI_INTERNALS__;
    const original = internals.invoke;
    internals.invoke = async (name, args) => {
      const record = (result: unknown) => {
        (window as unknown as {
          __appearanceFixtures: { calls: { name: string; args?: Record<string, unknown> }[] };
        }).__appearanceFixtures.calls.push({ name, args });
        return result;
      };
      if (name === "begin_microsoft_login") return record(device);
      if (name === "cancel_auth_login" || name === "add_offline_account" || name === "select_authlib_profile") return record(null);
      if (name === "poll_microsoft_login") return record({ status: "pending", retryAfterSeconds: 5, account: null });
      if (name === "login_authlib") return record({
        status: "selectProfile",
        sessionId: "authlib-e2e",
        profiles: [{ id: "profile-one", name: "First" }, { id: "profile-two", name: "Second" }],
        account: null,
      });
      if (name === "plugin:dialog|open") return record("E:\\SyntheticFixture\\skin.png");
      if (["upload_account_skin", "reset_account_skin", "select_account_cape"].includes(name)) {
        const profile = await original("get_player_profile", { accountId: "fixture-classic" });
        return record(profile);
      }
      return original(name, args);
    };
  }, device);
}

async function openAccounts(page: Page) {
  await page.goto("/?next-ui");
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "角色", exact: true }).click();
  await expect(page.getByRole("heading", { name: "角色", exact: true })).toBeVisible();
}

test("offline creation and account selection keep the existing IPC flow", async ({ page }) => {
  await installLauncherFixture(page);
  await mockAccountCommands(page);
  await openAccounts(page);
  await page.getByRole("button", { name: "选择 AmberFixture", exact: true }).click();
  await page.getByRole("button", { name: "添加角色", exact: true }).click();
  await page.getByRole("tab", { name: "离线角色", exact: true }).click();
  await page.getByRole("textbox", { name: "角色名称", exact: true }).fill("Fixture_Player");
  await page.getByRole("button", { name: "添加离线角色", exact: true }).click();
  const calls = await internals(page);
  expect(calls.some((call) => call.name === "select_account" && call.args?.accountId === "fixture-slim")).toBe(true);
  expect(calls.some((call) => call.name === "add_offline_account" && call.args?.username === "Fixture_Player")).toBe(true);
});

test("Microsoft device authorization can be cancelled without a successful account", async ({ page }) => {
  await installLauncherFixture(page);
  await mockAccountCommands(page);
  await openAccounts(page);
  await page.getByRole("button", { name: "添加角色", exact: true }).click();
  await page.getByRole("textbox", { name: "本项目的 Microsoft Client ID" }).fill("fixture-client-id");
  await page.getByRole("button", { name: "开始 Microsoft 登录", exact: true }).click();
  await expect(page.getByText("E2E-CODE", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "取消此次授权", exact: true }).click();
  const calls = await internals(page);
  expect(calls.some((call) => call.name === "cancel_auth_login" && call.args?.sessionId === device.sessionId)).toBe(true);
  expect(calls.some((call) => call.name === "poll_microsoft_login")).toBe(false);
});

test("Authlib profile selection uses the returned session and clears the password form", async ({ page }) => {
  await installLauncherFixture(page);
  await mockAccountCommands(page);
  await openAccounts(page);
  await page.getByRole("button", { name: "添加角色", exact: true }).click();
  await page.getByRole("tab", { name: "第三方认证", exact: true }).click();
  await page.getByRole("textbox", { name: "认证服务 API 地址" }).fill("https://auth.example.invalid/api/");
  await page.getByRole("textbox", { name: "用户名或邮箱" }).fill("fixture-user");
  await page.getByLabel("密码", { exact: true }).fill("fixture-password");
  await page.getByRole("button", { name: "登录第三方账号", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "密码", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: /Second/ }).click();
  const calls = await internals(page);
  expect(calls.some((call) => call.name === "select_authlib_profile" && call.args?.sessionId === "authlib-e2e" && call.args?.profileId === "profile-two")).toBe(true);
});

test("online skin, reset and cape changes happen only after explicit actions", async ({ page }) => {
  await installLauncherFixture(page);
  await mockAccountCommands(page);
  await openAccounts(page);
  await expect(page.locator(".vx-character-canvas")).toHaveAttribute("data-character-state", "ready");
  let calls = await internals(page);
  expect(calls.some((call) => call.name === "upload_account_skin")).toBe(false);
  await page.getByRole("button", { name: "上传正版皮肤", exact: true }).click();
  await expect(page.getByText("正版皮肤已更新。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "恢复默认皮肤", exact: true }).click();
  await page.getByRole("combobox", { name: "正版披风", exact: true }).selectOption("");
  await expect(page.getByText("披风已隐藏。", { exact: true })).toBeVisible();
  calls = await internals(page);
  expect(calls.some((call) => call.name === "upload_account_skin" && call.args?.path === "E:\\SyntheticFixture\\skin.png" && call.args?.model === "slim")).toBe(true);
  expect(calls.some((call) => call.name === "reset_account_skin" && call.args?.accountId === "fixture-classic")).toBe(true);
  expect(calls.some((call) => call.name === "select_account_cape" && call.args?.capeId === null)).toBe(true);
});

test("profile failure has a retry state and never renders a default as the account", async ({ page }) => {
  await installLauncherFixture(page, { profileFailure: true });
  await page.addInitScript(() => {
    const internals = (window as unknown as {
      __TAURI_INTERNALS__: { invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown> };
    }).__TAURI_INTERNALS__;
    const original = internals.invoke;
    internals.invoke = async (name, args) => {
      if (name === "get_player_profile") {
        (window as unknown as {
          __appearanceFixtures: { calls: { name: string; args?: Record<string, unknown> }[] };
        }).__appearanceFixtures.calls.push({ name, args });
        throw { code: "auth.profileUnavailable", detail: "Synthetic profile failure" };
      }
      return original(name, args);
    };
  });
  await openAccounts(page);
  await expect(page.getByText("暂时无法读取此账号的外观，请检查会话后重试。", { exact: true })).toBeVisible();
  await expect(page.locator(".vx-character-canvas")).toHaveCount(0);
  await page.getByRole("button", { name: "重试账号外观", exact: true }).click();
  const calls = await internals(page);
  expect(calls.filter((call) => call.name === "get_player_profile").length).toBeGreaterThanOrEqual(2);
});

test("empty profiles expose no fake skin or cape", async ({ page }) => {
  await installLauncherFixture(page, { emptyProfile: true });
  await openAccounts(page);
  await expect(page.getByText("尚未取得当前账号的皮肤", { exact: true })).toBeVisible();
  await expect(page.getByText("此账号没有可用披风。", { exact: true })).toBeVisible();
  await expect(page.locator(".vx-character-canvas")).toHaveCount(0);
});

test("local URL preview renders without calling an online-account mutation", async ({ page }) => {
  await installLauncherFixture(page);
  await mockAccountCommands(page);
  await openAccounts(page);
  const skin = await page.evaluate(() => (window as unknown as {
    __appearanceFixtures: { skins: Record<string, string> };
  }).__appearanceFixtures.skins.classic);
  await page.route("https://example.invalid/skin.png", async (route) => {
    await route.fulfill({ contentType: "image/png", body: Buffer.from(skin.split(",")[1], "base64") });
  });
  await page.getByRole("tab", { name: "本地预览", exact: true }).click();
  await page.getByRole("textbox", { name: "在线皮肤 URL", exact: true }).fill("https://example.invalid/skin.png");
  await page.getByRole("button", { name: "加载网址", exact: true }).click();
  await expect(page.locator(".vx-character-canvas")).toHaveAttribute("data-character-state", "ready");
  await expect(page.getByText("仅用于本地预览 · 不会修改账号外观", { exact: true })).toBeVisible();
  const calls = await internals(page);
  expect(calls.some((call) => call.name === "upload_account_skin")).toBe(false);
});
