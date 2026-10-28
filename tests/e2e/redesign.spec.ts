import { expect, test } from "@playwright/test";
import { installLauncherFixture } from "./fixtures";

test("floating navigation labels and native window actions remain visible at both desktop sizes", async ({ page }) => {
  await installLauncherFixture(page);
  await page.goto("/");
  for (const width of [1050, 1440]) {
    await page.setViewportSize({ width, height: width === 1050 ? 720 : 930 });
    for (const id of ["home", "library", "discover", "multiplayer", "downloads", "accounts", "settings"]) {
      const item = page.locator(`button[data-page="${id}"]`);
      await expect(item).toBeVisible();
      await expect(item.locator(".vx-floating-nav__label")).toBeVisible();
    }
    for (const label of ["最小化", "最大化", "关闭"]) {
      const control = page.locator(".vx-window-chrome__controls").getByRole("button", { name: label, exact: true });
      await expect(control).toBeVisible();
      const bounds = await control.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    }
    await expect(page.getByRole("button", { name: "启动游戏", exact: true })).toBeInViewport();
  }
});

test("reduced motion keeps a usable scene and launch action across page changes", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installLauncherFixture(page);
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-reduced-motion", "true");
  await page.locator('button[data-page="settings"]').click();
  await page.locator('button[data-page="home"]').click();
  await expect(page.getByRole("button", { name: "启动游戏", exact: true })).toBeVisible();
  const moving = await page.locator(".vx-home").evaluate((root) => root.getAnimations({ subtree: true })
    .filter((animation) => animation.playState === "running" && animation.effect?.getTiming().iterations === Infinity).length);
  expect(moving).toBe(0);
});
