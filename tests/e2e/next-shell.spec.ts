import { expect, test } from "@playwright/test";
import { installLauncherFixture } from "./fixtures";

test("new home keeps launch, preparation, cancellation and the minimum viewport usable", async ({ page }) => {
  await installLauncherFixture(page, { launchDelay: 6000 });
  await page.goto("/?next-ui");
  await expect(page.locator(".vx-home__console-name")).toHaveText("合成测试世界");
  await expect(page.locator(".vx-home__console-name")).toBeInViewport();
  await expect(page.getByRole("button", { name: "启动游戏", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "启动游戏", exact: true }).click();
  await expect(page.getByText("37%", { exact: true }).first()).toBeVisible({ timeout: 8000 });
  await page.getByRole("button", { name: "取消准备", exact: true }).click();
  const calls = await page.evaluate(() => (window as unknown as { __appearanceFixtures: { calls: { name: string }[] } }).__appearanceFixtures.calls);
  expect(calls.some((call) => call.name === "cancel_download_task")).toBe(true);
  await page.setViewportSize({ width: 1050, height: 720 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const sceneHeight = await page.locator(".vx-home").evaluate((element) => element.getBoundingClientRect().height);
  expect(sceneHeight).toBeLessThan(700);
  expect(await page.locator(".vx-home__console-name", { hasText: "合成测试世界" }).count()).toBe(1);
});

test("reduced motion is respected on initial render", async ({ page }) => {
  await installLauncherFixture(page);
  await page.addInitScript(() => {
    const original = window.matchMedia;
    window.matchMedia = (query: string) => {
      const media = original(query);
      if (query !== "(prefers-reduced-motion: reduce)") return media;
      return new Proxy(media, {
        get(target, property, receiver) {
          if (property === "matches") return true;
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
  });
  await page.goto("/?next-ui");
  await expect(page.locator("html")).toHaveAttribute("data-reduced-motion", "true");
  await expect(page.getByRole("button", { name: "启动游戏", exact: true })).toBeVisible();
});

test("empty state opens the create dialog without duplicating its message", async ({ page }) => {
  await installLauncherFixture(page, { noInstances: true });
  await page.goto("/?next-ui");
  await expect(page.locator(".vx-empty")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "暂无实例", exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "创建实例", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("heading", { name: "创建实例", exact: true })).toBeVisible();
});
