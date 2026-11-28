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

test("the first-run OOBE shows once with live preview, hides Lumen, can be skipped, and saves on its own", async ({ page }) => {
  await page.setViewportSize({ width: 1050, height: 720 });
  await installLauncherFixture(page, { tourCompleted: false });
  await page.goto("/?next-ui");
  const tour = page.getByRole("dialog", { name: "欢迎使用 Voxelight" });
  await expect(tour).toBeVisible();
  await expect(tour).not.toContainText("Lumen");
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

// R9 D7 (ui-language-spec §2.11.1 and §2.11.4): the custom background is the
// full-page layer of every page. It is mounted once outside the page
// transitions, and the 3D world it covers stays paused and hidden on every page.
test("a custom background stays on every page over a paused world", async ({ page }) => {
  await installLauncherFixture(page, { customBackground: "C:\\SyntheticFixture\\background.png" });
  await page.goto("/?next-ui");
  const layer = page.locator("[data-app-background]");
  const scene = page.locator(".vx-global-scene");
  await expect(layer).toHaveAttribute("data-visible", "true");
  await expect(layer.locator("[data-app-background-image]")).toHaveAttribute("style", /background-image: url\(/);
  await expect(scene).toHaveAttribute("data-paused", "true");
  await expect(scene).toBeHidden();
  const mounted = await layer.elementHandle();
  for (const [name, heading] of [["游戏库", "游戏库"], ["设置", "设置"]] as const) {
    await navigation(page).getByRole("button", { name, exact: true }).click();
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    // Home's own launch-side scrim leaves with Home; only the shared layer stays.
    await expect(page.locator(".vx-home")).toHaveCount(0);
    await expect(layer).toHaveCount(1);
    await expect(layer).toHaveAttribute("data-visible", "true");
    expect(await layer.evaluate((node, original) => node === original, mounted)).toBe(true);
    await expect(scene).toHaveAttribute("data-paused", "true");
    await expect(scene).toBeHidden();
  }
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
  // Select-all is labelled with the count it selects: the two files the search shows.
  await page.getByRole("checkbox", { name: "全选（2）", exact: true }).check();
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
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await page.getByRole("dialog", { name: "确认操作", exact: true }).getByRole("button", { name: "确认", exact: true }).click();
  await expect(page.getByText("已从磁盘永久删除 2 个资源。")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /alpha/ })).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: /gamma/ })).toHaveCount(1);
  await page.getByRole("tab", { name: "日志", exact: true }).click();
  await expect(page.getByRole("heading", { name: "游戏日志", exact: true })).toBeVisible();
  await expect.poll(async () => (await calls(page)).some((call) => call.name === "read_game_log")).toBe(true);
  // The fixture's log has no lines: the section says so, and offers no search over nothing.
  await expect(page.getByRole("heading", { name: "还没有游戏日志", exact: true })).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "搜索游戏日志" })).toHaveCount(0);
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
  await page.getByRole("button", { name: "更换加载器", exact: true }).click();
  await page.getByRole("dialog", { name: "确认操作", exact: true }).getByRole("button", { name: "确认", exact: true }).click();
  await expect(page.getByText("实例加载器已更换。", { exact: true })).toBeVisible();
  await expect(page.getByText("Minecraft 1.21.1，Fabric 0.16.9", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("Lumen stays invisible until configured, wakes proactively on crash, and factory reset restores initial state", async ({ page }) => {
  await page.setViewportSize({ width: 1050, height: 720 });
  await installLauncherFixture(page);
  await page.goto("/?next-ui");
  const emit = (event: string, payload: unknown) =>
    page.evaluate(([name, data]) => (window as unknown as { __VX_EMIT__: (e: string, p: unknown) => void }).__VX_EMIT__(name, data), [event, payload] as const);

  // 1. Before configuring Lumen: Ctrl+K does nothing and F1 shortcut help does not mention Lumen.
  await page.locator("main").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+k");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await page.keyboard.press("F1");
  const helpDialog = page.locator("dialog.vx-shortcuts-dialog[open]");
  await expect(helpDialog).toBeVisible();
  await expect(helpDialog).not.toContainText("Lumen");
  await page.keyboard.press("Escape");
  await expect(helpDialog).toHaveCount(0);

  // 2. Configure Lumen model, encrypted key, Controlled mode, and verify local MCP in Settings → Lumen & MCP.
  await navigation(page).getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "Lumen 与 MCP", exact: true }).click();
  await page.getByRole("textbox", { name: "模型名称" }).fill("gpt-4o-mini");
  await page.getByLabel("Lumen API Key").fill("sk-synthetic-fixture-key");
  await page.getByRole("button", { name: "保存密钥", exact: true }).click();
  await expect(page.getByText("Lumen API Key 已加密保存。")).toBeVisible();
  await page.getByRole("button", { name: "受控", exact: true }).click();
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(page.getByText("其他设置已保存。")).toBeVisible();

  await page.getByRole("button", { name: "启动 MCP 服务", exact: true }).click();
  await expect(page.getByTestId("mcp-status-card")).toContainText("127.0.0.1:25590");
  await expect(page.getByRole("button", { name: "复制 MCP 配置 JSON", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "停止 MCP 服务", exact: true }).click();
  await expect(page.getByTestId("mcp-status-card")).toContainText("已停止");

  // 3. Once configured: Ctrl+K opens Lumen and Controlled-mode approval executes.
  await page.locator("main").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Lumen" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: "发给 Lumen 的消息" }).fill("给我的实例添加一条备注");
  await dialog.getByRole("button", { name: "发送", exact: true }).click();
  await expect(dialog.getByText("确认 Lumen 写入操作")).toBeVisible();
  await expect(dialog.getByText("更新实例备注", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "批准并执行", exact: true }).click();
  await expect(dialog.getByText("已更新实例备注。")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // 4. Proactive crash wake-up: non-zero game exit wakes Lumen automatically with crash banner.
  await emit("launcher://game-exit", { gameId: "fixture-crash-1", pid: 4321, code: 1 });
  const woken = page.getByRole("dialog", { name: "Lumen" });
  await expect(woken).toBeVisible();
  await expect(woken.getByTestId("lumen-wake-banner")).toContainText("退出码 1");
  await page.keyboard.press("Escape");
  await expect(woken).toHaveCount(0);

  // 5. Factory reset in Settings → General restores initial state, re-opens OOBE, and hides Lumen again.
  await page.getByRole("button", { name: "通用", exact: true }).click();
  await page.getByRole("button", { name: "还原为初始状态", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "确定要将启动器还原为初始状态吗？" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "确认还原", exact: true }).click();
  await expect(confirm).toHaveCount(0);
  const oobe = page.getByRole("dialog", { name: "欢迎使用 Voxelight" });
  await expect(oobe).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(oobe).toHaveCount(0);
  await page.locator("main").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+k");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
