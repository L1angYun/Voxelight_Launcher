import { expect, test } from "@playwright/test";
import { installLauncherFixture } from "./fixtures";

test("the default entry is the complete new UI with every navigation owner", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await installLauncherFixture(page);
  await page.goto("/");
  await expect(page.locator(".vx-home__console-name")).toHaveText("合成测试世界");
  await expect(page.locator(".vx-home__console-name")).toBeInViewport();
  for (const id of ["home", "library", "discover", "multiplayer", "downloads", "accounts", "settings"]) {
    await expect(page.locator(`[data-page="${id}"]`)).toHaveCount(1);
  }
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await expect(page.locator(".home-hero")).toHaveCount(0);
  await expect(page.locator(".skin-viewer")).toHaveCount(0);
  await expect(page.locator(".vx-glass-provider")).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("browser preview without native IPC fails honestly and keeps the empty state", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "No instances yet", exact: true })).toBeInViewport();
  await expect(page.locator(".vx-home__empty > p")).toHaveText("Create an instance to start playing.");
  await expect(page.getByText("Use the desktop app for this action.", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Create instance", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("dialog focus stays inside, Escape closes, and the trigger regains focus", async ({ page }) => {
  await installLauncherFixture(page, { noInstances: true });
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "创建实例", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "创建实例", exact: true });
  await expect(dialog).toBeVisible();
  const focusedName = await page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null;
    return element?.getAttribute("aria-label") || element?.textContent || "";
  });
  expect(focusedName.trim()).not.toBe("");
  await page.keyboard.press("Shift+Tab");
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest("dialog")))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
});

test("window controls and settings remain available at the minimum viewport", async ({ page }) => {
  await installLauncherFixture(page);
  await page.setViewportSize({ width: 1050, height: 720 });
  await page.goto("/");
  await expect(page.getByRole("group", { name: "窗口控制" })).toBeVisible();
  await page.locator('[data-page="settings"]').click();
  await page.locator(".vx-settings-nav").getByRole("button", { name: "外观", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "特效级别", exact: true })).toBeVisible();
  const effects = page.getByRole("combobox", { name: "特效级别", exact: true });
  await effects.click();
  await expect(page.getByRole("listbox", { name: "特效级别", exact: true }).getByRole("option")).toHaveCount(2);
  await effects.press("Escape");
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
