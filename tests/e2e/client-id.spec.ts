// SPDX-License-Identifier: GPL-3.0-only
import { chromium, expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { installLauncherFixture } from "./fixtures";

const nativeTest = test.extend({
  context: async ({ baseURL }, use) => {
    const browser = await chromium.launch({ channel: "chromium", args: ["--use-angle=d3d11"] });
    const context = await browser.newContext({ baseURL, deviceScaleFactor: 1, viewport: { width: 1440, height: 930 } });
    try { await use(context); } finally { await context.close(); await browser.close(); }
  },
});
const override = "22222222-2222-2222-2222-222222222222";
const startLabel = "开始 Microsoft 登录";

async function prepare(page: Page, builtin: boolean, savedOverride = "") {
  await installLauncherFixture(page, { theme: "light" });
  await page.addInitScript(({ builtin, savedOverride }) => {
    const host = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown> };
      __appearanceFixtures: { calls: { name: string; args?: Record<string, unknown> }[] };
    };
    const original = host.__TAURI_INTERNALS__.invoke;
    let current = savedOverride;
    host.__TAURI_INTERNALS__.invoke = async (name, args) => {
      if (name === "bootstrap") {
        const data = await original(name, args) as { capabilities: Record<string, unknown>; config: Record<string, unknown> };
        return { ...data, config: { ...data.config, microsoftClientId: current },
          capabilities: { ...data.capabilities, microsoftBuiltinClientId: builtin } };
      }
      if (name === "get_service_status") {
        const status = await original(name, args) as Record<string, unknown>;
        return { ...status, microsoftBuiltin: builtin, microsoftOverride: Boolean(current),
          microsoftConfigured: builtin || Boolean(current) };
      }
      if (name === "save_config") {
        current = String((args?.config as Record<string, unknown>).microsoftClientId ?? "");
        return original(name, args);
      }
      if (name === "begin_microsoft_login") {
        host.__appearanceFixtures.calls.push({ name, args });
        return { sessionId: "r3-device-fixture", userCode: "R3-ONLY", verificationUri: "https://microsoft.com/devicelogin",
          expiresIn: 600, interval: 30, message: "Synthetic authorization" };
      }
      if (name === "cancel_auth_login" || name === "poll_microsoft_login") {
        host.__appearanceFixtures.calls.push({ name, args });
        return name === "cancel_auth_login" ? null : { status: "pending", retryAfterSeconds: 30, account: null };
      }
      return original(name, args);
    };
  }, { builtin, savedOverride });
  await page.goto("/");
  await page.locator('button[data-page="accounts"]').click();
  await page.getByRole("button", { name: "添加账号", exact: true }).click();
  await expect(page.getByRole("button", { name: startLabel, exact: true })).toBeVisible();
}

async function calls(page: Page) {
  return page.evaluate(() => (window as unknown as {
    __appearanceFixtures: { calls: { name: string; args?: Record<string, unknown> }[] };
  }).__appearanceFixtures.calls);
}

nativeTest.afterEach(async ({ page }, info) => {
  const runtime = await page.evaluate(() => {
    const gl = document.querySelector<HTMLCanvasElement>(".world-scene canvas")?.getContext("webgl2");
    const debug = gl?.getExtension("WEBGL_debug_renderer_info");
    return { renderer: debug ? gl!.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null, dpr: devicePixelRatio };
  });
  await writeFile(info.outputPath("runtime.json"), JSON.stringify(runtime, null, 2));
  expect(runtime.renderer).toMatch(/D3D11/);
  expect(runtime.renderer).not.toMatch(/swiftshader|software|llvmpipe/i);
  expect(runtime.dpr).toBe(1);
});

nativeTest("R3-1 public login retains required Client ID and explicit device authorization", async ({ page }, info) => {
  await prepare(page, false);
  const input = page.getByRole("textbox", { name: "本项目的 Microsoft Client ID", exact: true });
  const start = page.getByRole("button", { name: startLabel, exact: true });
  await expect(input).toBeVisible();
  await expect(start).toBeDisabled();
  await input.fill(override);
  await expect(start).toBeEnabled();
  await start.click();
  await expect(page.getByText("R3-ONLY", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "取消此次授权", exact: true }).click();
  expect((await calls(page)).filter(call => call.name === "begin_microsoft_login")).toHaveLength(1);
  await page.screenshot({ path: info.outputPath("public-login.png") });
});

nativeTest("R3-1 builtin login starts without saving an ID and exposes optional settings", async ({ page }, info) => {
  await prepare(page, true);
  await expect(page.getByText("正在使用内置 Microsoft 应用。", { exact: true })).toBeVisible();
  const input = page.getByRole("textbox", { name: "自定义 Microsoft Client ID（可选）", exact: true });
  await expect(input).not.toBeVisible();
  await expect(page.getByRole("button", { name: startLabel, exact: true })).toBeEnabled();
  await page.screenshot({ path: info.outputPath("builtin-login.png") });
  await page.getByRole("button", { name: startLabel, exact: true }).click();
  await expect(page.getByText("R3-ONLY", { exact: true })).toBeVisible();
  expect((await calls(page)).filter(call => call.name === "save_config")).toHaveLength(0);
  await page.getByRole("button", { name: "取消此次授权", exact: true }).click();
  await page.getByRole("dialog").locator("[data-dialog-close]").click();
  await page.locator('button[data-page="settings"]').click();
  const setting = page.getByRole("textbox", { name: "Microsoft Client ID", exact: true });
  await expect(setting).toBeVisible();
  await expect(setting.locator("..")).toContainText("Microsoft Client ID（可选）");
  await expect(setting).toHaveAttribute("placeholder", "留空以使用内置应用");
  await page.screenshot({ path: info.outputPath("builtin-settings.png") });
});

nativeTest("R3-1 saved override can be cleared to return to the builtin application", async ({ page }, info) => {
  await prepare(page, true, override);
  await expect(page.getByText("正在使用已保存的自定义 Microsoft Client ID。", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "自定义 Microsoft Client ID（可选）", exact: true })).toHaveValue(override);
  await page.getByRole("button", { name: "恢复内置", exact: true }).click();
  await expect(page.getByText("正在使用内置 Microsoft 应用。", { exact: true })).toBeVisible();
  const saved = (await calls(page)).filter(call => call.name === "save_config");
  expect(saved).toHaveLength(1);
  expect((saved[0].args?.config as Record<string, unknown>).microsoftClientId).toBe("");
  await page.screenshot({ path: info.outputPath("override-restored.png") });
});

nativeTest("R3-1 advanced override is saved before device authorization begins", async ({ page }) => {
  await prepare(page, true);
  await page.getByText("使用自定义 Client ID", { exact: true }).click();
  await page.getByRole("textbox", { name: "自定义 Microsoft Client ID（可选）", exact: true }).fill(override);
  await page.getByRole("button", { name: startLabel, exact: true }).click();
  await expect(page.getByText("R3-ONLY", { exact: true })).toBeVisible();
  const names = (await calls(page)).map(call => call.name);
  expect(names.indexOf("save_config")).toBeGreaterThanOrEqual(0);
  expect(names.indexOf("begin_microsoft_login")).toBeGreaterThan(names.indexOf("save_config"));
});
