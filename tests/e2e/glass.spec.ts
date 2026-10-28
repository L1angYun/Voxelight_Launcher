import { expect, test } from "@playwright/test";
import { installLauncherFixture } from "./fixtures";

test("glass falls back without WebGL2 while keeping the launch action", async ({ page }) => {
  await installLauncherFixture(page);
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: unknown[]) {
      if (type === "webgl2") return null;
      return original.call(this, type, ...args);
    } as typeof original;
  });
  await page.goto("/?next-ui");
  await expect(page.locator(".vx-glass-provider").first()).toHaveAttribute("data-glass-mode", "fallback");
  await expect(page.getByRole("button", { name: "启动游戏", exact: true })).toBeVisible();
});

test("glass reports context loss and restores its original quality", async ({ page }) => {
  await installLauncherFixture(page);
  await page.goto("/?next-ui");
  const root = page.locator(".vx-glass-provider").first();
  await expect(root).toHaveAttribute("data-glass-mode", "full");
  await page.evaluate(() => {
    document.querySelector(".vx-glass-canvas")!.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
  });
  await expect(root).toHaveAttribute("data-glass-mode", "fallback");
  await page.evaluate(() => {
    document.querySelector(".vx-glass-canvas")!.dispatchEvent(new Event("webglcontextrestored"));
  });
  await expect(root).toHaveAttribute("data-glass-mode", "full");
});
