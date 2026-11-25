import { expect, test, type Page } from "@playwright/test";
import { installLauncherFixture } from "./fixtures";

async function calls(page: Page) {
  return page.evaluate(() => (window as unknown as {
    __appearanceFixtures: { calls: { name: string; args?: Record<string, unknown> }[] };
  }).__appearanceFixtures.calls);
}

function navigation(page: Page) {
  return page.getByRole("navigation", { name: "主导航" });
}

test("the first-run tour shows once, can be skipped, and is saved on its own", async ({ page }) => {
  await page.setViewportSize({ width: 1050, height: 720 });
  await installLauncherFixture(page, { tourCompleted: false });
  await page.goto("/?next-ui");
  const tour = page.getByRole("dialog", { name: "快速导览" });
  await expect(tour).toBeVisible();
  const box = (await tour.boundingBox())!;
  expect(box.x >= 0 && box.y >= 0 && box.x + box.width <= 1050 && box.y + box.height <= 720).toBe(true);
  await page.keyboard.press("Escape");
  await expect(tour).toBeHidden();
  const recorded = await calls(page);
  expect(recorded.filter((call) => call.name === "set_tour_completed")).toEqual([{ name: "set_tour_completed", args: { completed: true } }]);
  expect(recorded.some((call) => call.name === "save_config")).toBe(false);
});

test("keyboard shortcuts move between pages and Ctrl+F finds the page's search", async ({ page }) => {
  await installLauncherFixture(page);
  await page.goto("/?next-ui");
  await page.keyboard.press("Control+2");
  await expect(page.getByRole("heading", { name: "游戏库", exact: true })).toBeVisible();
  await page.keyboard.press("Control+f");
  await expect(page.locator("main input[type=search]").first()).toBeFocused();
  await page.locator("main").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+,");
  await expect(page.getByRole("heading", { name: "设置", exact: true })).toBeVisible();
  await page.keyboard.press("F1");
  await expect(page.getByRole("dialog").filter({ hasText: "Ctrl" })).toBeVisible();
});

test("settings search opens the section and focuses the setting at the smallest window", async ({ page }) => {
  await page.setViewportSize({ width: 1050, height: 720 });
  await installLauncherFixture(page);
  await page.goto("/?next-ui");
  await navigation(page).getByRole("button", { name: "设置", exact: true }).click();
  const search = page.getByRole("searchbox", { name: "搜索设置" });
  await search.fill("内存");
  await expect(page.getByRole("button", { name: /内存分配/ })).toBeVisible();
  await search.press("Enter");
  await expect(search).toHaveValue("");
  const focused = await page.evaluate(() => document.activeElement?.closest("[data-settings-target]")?.getAttribute("data-settings-target"));
  expect(focused).toBe("java-memory-mode");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("a custom home background shows on Home only, over a paused world", async ({ page }) => {
  await installLauncherFixture(page, { customBackground: "C:\\SyntheticFixture\\background.png" });
  await page.goto("/?next-ui");
  const layer = page.locator("[data-home-background]");
  await expect(layer).toHaveAttribute("data-visible", "true");
  await expect(page.locator(".vx-global-scene")).toHaveAttribute("data-paused", "true");
  await navigation(page).getByRole("button", { name: "游戏库", exact: true }).click();
  await expect(layer).not.toHaveAttribute("data-visible", "true");
});

test("local resource packs can be searched and disabled in a batch", async ({ page }) => {
  await installLauncherFixture(page, { localResources: [
    { fileName: "faithful.zip" }, { fileName: "fresh-animations.zip" }, { fileName: "low-pixel.zip" },
  ] });
  await page.goto("/?next-ui");
  await navigation(page).getByRole("button", { name: "游戏库", exact: true }).click();
  await page.locator(".vx-instance-card").first().click();
  await page.getByRole("tab", { name: "内容", exact: true }).click();
  const search = page.getByRole("searchbox", { name: "搜索文件" });
  await search.fill("f");
  await expect(page.getByRole("checkbox", { name: /low-pixel/ })).toHaveCount(0);
  await page.getByRole("checkbox", { name: "选择所有可见文件" }).check();
  await expect(page.getByText("已选择 2 个文件")).toBeVisible();
  await page.getByRole("button", { name: "禁用", exact: true }).click();
  await expect.poll(async () => (await calls(page)).filter((call) => call.name === "toggle_resource").map((call) => call.args?.fileName))
    .toEqual(["faithful.zip", "fresh-animations.zip"]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("local resources can be deleted in a batch with confirmation and logs tab loads game logs", async ({ page }) => {
  await page.setViewportSize({ width: 1050, height: 720 });
  await installLauncherFixture(page, { localResources: [
    { fileName: "alpha.zip" }, { fileName: "beta.zip" }, { fileName: "gamma.zip" },
  ] });
  await page.goto("/?next-ui");
  await navigation(page).getByRole("button", { name: "游戏库", exact: true }).click();
  await page.locator(".vx-instance-card").first().click();
  await page.getByRole("tab", { name: "内容", exact: true }).click();
  await page.getByRole("checkbox", { name: /alpha/ }).check();
  await page.getByRole("checkbox", { name: /beta/ }).check();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await expect(page.getByText("已从磁盘永久删除 2 个资源。")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /alpha/ })).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: /gamma/ })).toHaveCount(1);
  await page.getByRole("tab", { name: "日志", exact: true }).click();
  await expect(page.getByRole("heading", { name: "游戏日志", exact: true })).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "搜索游戏日志" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("drag-and-drop imports mods in instance content, opens modpack import, and previews dropped skins", async ({ page }) => {
  await page.setViewportSize({ width: 1050, height: 720 });
  await installLauncherFixture(page);
  await page.goto("/?next-ui");
  const emit = (event: string, payload: unknown) =>
    page.evaluate(([name, data]) => (window as unknown as { __VX_EMIT__: (e: string, p: unknown) => void }).__VX_EMIT__(name, data), [event, payload] as const);

  // 1. Drag overlay appears and hides cleanly; dropping a .mrpack opens import dialog pre-filled.
  await emit("launcher://file-drag", { active: true, count: 1 });
  await expect(page.locator("[data-file-drop-overlay]")).toBeVisible();
  await emit("launcher://file-drop", { mods: [], zips: [], modpacks: ["C:\\Downloads\\skyblock.mrpack"], skins: [], unsupported: 0 });
  await expect(page.locator("[data-file-drop-overlay]")).toHaveCount(0);
  const dialog = page.locator("dialog[open]");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/skyblock\.mrpack/)).toBeVisible();
  await dialog.getByRole("button", { name: "导入整合包", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  // 2. Dropping a .jar mod inside an instance's Content tab imports it as a mod.
  await navigation(page).getByRole("button", { name: "游戏库", exact: true }).click();
  await page.locator(".vx-instance-card").first().click();
  await page.getByRole("tab", { name: "内容", exact: true }).click();
  await emit("launcher://file-drop", { mods: ["C:\\Downloads\\sodium.jar"], zips: [], modpacks: [], skins: [], unsupported: 0 });
  await expect(page.getByText("sodium.jar")).toBeVisible();

  // 3. Dropping a .png skin on Players previews it via read_skin_preview.
  await navigation(page).getByRole("button", { name: "角色", exact: true }).click();
  await expect(page.locator(".vx-accounts-page")).toBeVisible();
  await emit("launcher://file-drop", { mods: [], zips: [], modpacks: [], skins: ["C:\\Downloads\\hero.png"], unsupported: 0 });
  await expect(page.getByText("hero.png", { exact: true })).toBeVisible();
  await expect(page.getByText("已拖入皮肤预览：hero.png", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "上传至微软账号", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("instance settings changes an existing instance's loader while preserving the instance", async ({ page }) => {
  await page.setViewportSize({ width: 1050, height: 720 });
  await installLauncherFixture(page);
  await page.goto("/?next-ui");
  await navigation(page).getByRole("button", { name: "游戏库", exact: true }).click();
  await page.locator(".vx-instance-card").first().click();
  await page.getByRole("tab", { name: "设置", exact: true }).click();
  await expect(page.getByRole("heading", { name: "加载器", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Fabric", exact: true }).click();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "更换加载器", exact: true }).click();
  await expect(page.getByText("实例加载器已更换。", { exact: true })).toBeVisible();
  await expect(page.getByText("Minecraft 1.21.1 · Fabric 0.16.9", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("built-in assistant and local MCP server can be configured, started, and approved via Ctrl+K", async ({ page }) => {
  await page.setViewportSize({ width: 1050, height: 720 });
  await installLauncherFixture(page);
  await page.goto("/?next-ui");

  // Configure provider model, encrypted key, Controlled mode, and start local MCP in Settings → Assistant & MCP
  await navigation(page).getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "助手与 MCP", exact: true }).click();
  await page.getByRole("textbox", { name: "模型名称" }).fill("gpt-4o-mini");
  await page.getByLabel("助手 API Key").fill("sk-synthetic-fixture-key");
  await page.getByRole("button", { name: "保存密钥", exact: true }).click();
  await expect(page.getByText("助手 API Key 已加密保存。")).toBeVisible();
  await page.getByRole("button", { name: "受控", exact: true }).click();
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(page.getByText("其他设置已保存。")).toBeVisible();

  await page.getByRole("button", { name: "启动 MCP 服务", exact: true }).click();
  await expect(page.getByTestId("mcp-status-card")).toContainText("127.0.0.1:25590");
  await expect(page.getByRole("button", { name: "复制 MCP 配置 JSON", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "停止 MCP 服务", exact: true }).click();
  await expect(page.getByTestId("mcp-status-card")).toContainText("已停止");

  // Open built-in assistant via Ctrl+K, run a controlled turn, approve write action
  await page.locator("main").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "内置助手" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: "发给助手的消息" }).fill("给我的实例添加一条备注");
  await dialog.getByRole("button", { name: "发送", exact: true }).click();
  await expect(dialog.getByText("确认启动器写入操作")).toBeVisible();
  await expect(dialog.getByText("update_instance_notes")).toBeVisible();
  await dialog.getByRole("button", { name: "批准并执行", exact: true }).click();
  await expect(dialog.getByText("已更新实例备注。")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
