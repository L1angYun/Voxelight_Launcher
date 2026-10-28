import { expect, test } from "@playwright/test";
import { installLauncherFixture } from "./fixtures";

test("library opens instance details and preserves launch and management flows", async ({ page }) => {
  await installLauncherFixture(page, { launchDelay: 6000 });
  await page.goto("/");
  await page.getByRole("button", { name: "游戏库", exact: true }).click();
  await expect(page.getByRole("heading", { name: "游戏库", exact: true })).toBeVisible();
  const card = page.locator('[data-instance-id="fixture-world"]');
  await expect(card).toBeVisible();
  await card.locator("[data-launch]").click();
  await expect(page.getByText("37%", { exact: true }).first()).toBeVisible({ timeout: 8000 });
  await page.getByRole("button", { name: "取消准备", exact: true }).click();
  await card.locator(".vx-instance-card__select").click();
  await expect(page.getByRole("heading", { name: "合成测试世界", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "内容", exact: true }).click();
  await expect(page.getByText("此分类暂无资源", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "世界", exact: true }).click();
  await expect(page.getByText("此实例暂无世界", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "日志", exact: true }).click();
  await page.getByRole("button", { name: "分析最近错误", exact: true }).click();
  await expect(page.getByText("没有发现需要处理的启动错误。", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "设置", exact: true }).click();
  await expect(page.getByLabel("实例名称", { exact: true })).toHaveValue("合成测试世界");
  await page.setViewportSize({ width: 1050, height: 720 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
