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
