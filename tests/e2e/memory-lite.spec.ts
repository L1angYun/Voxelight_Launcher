import { expect, test, type Page } from "@playwright/test";
import { installLauncherFixture } from "./fixtures";

// Lite and reduced motion paint one static scene, so the home character is kept
// as a plain 2D still and its WebGL viewer is released (memory, TODO §2).
const character = (page: Page) => page.locator(".vx-home__character");
const webglCanvases = (page: Page) => page.evaluate(() =>
  [...document.querySelectorAll<HTMLCanvasElement>(".vx-home__character canvas")]
    .map(canvas => ({ still: canvas.dataset.characterStill === "true", width: canvas.width, height: canvas.height })));

test("Lite unloads the 3D world and glass WebGL contexts and keeps the home character as a 2D still", async ({ page }) => {
  await installLauncherFixture(page, { effects: "lite" });
  await page.goto("/");
  await expect(character(page)).toHaveAttribute("data-character-state", "ready");
  await expect(character(page)).toHaveAttribute("data-character-frozen", "true");
  const canvases = await webglCanvases(page);
  expect(canvases).toHaveLength(1);
  expect(canvases[0].still).toBe(true);
  expect(canvases[0].width).toBeGreaterThan(100);
  await expect(page.locator(".vx-home__character canvas")).toHaveAttribute("role", "img");
  // The 3D world and glass capability canvases hold no active WebGL backbuffer in Lite mode,
  // and the ambient light layer falls back to frozen CSS gradients with zero canvases.
  await expect(page.locator(".vx-ambient")).toBeVisible();
  await expect(page.locator(".vx-ambient")).toHaveAttribute("data-ambient-mode", "static");
  await expect(page.locator(".vx-ambient-canvas")).toHaveCount(0);
  await expect(page.locator(".vx-global-scene")).toHaveAttribute("data-world-tier", "css");
  await expect(page.locator(".vx-global-scene")).toHaveAttribute("data-world-frames", "0");
  await expect(page.locator(".vx-glass-provider")).toHaveAttribute("data-glass-mode", "lite");
  expect(await page.locator(".world-scene__canvas").evaluate((node: HTMLCanvasElement) => [node.width, node.height])).toEqual([0, 0]);
  expect(await page.locator(".vx-glass-canvas").evaluate((node: HTMLCanvasElement) => [node.width, node.height])).toEqual([0, 0]);
});

test("reduced motion freezes the home character the same way", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installLauncherFixture(page, { effects: "full" });
  await page.goto("/");
  await expect(character(page)).toHaveAttribute("data-character-state", "ready");
  await expect(character(page)).toHaveAttribute("data-character-frozen", "true");
});

test("Full keeps the live interactive viewer", async ({ page }) => {
  await installLauncherFixture(page, { effects: "full" });
  await page.goto("/");
  await expect(character(page)).toHaveAttribute("data-character-state", "ready");
  await expect(character(page)).toHaveAttribute("data-character-frozen", "false");
  const canvases = await webglCanvases(page);
  expect(canvases).toHaveLength(1);
  expect(canvases[0].still).toBe(false);
});

test("switching Full to Lite unloads the 3D world and switching back restores it", async ({ page }) => {
  await installLauncherFixture(page, { effects: "full" });
  await page.goto("/");
  await expect(page.locator(".vx-global-scene")).toHaveAttribute("data-world-tier", "animated");
  await page.locator('button[data-page="settings"]').click();
  await page.locator(".vx-settings-nav").getByRole("button", { name: "外观", exact: true }).click();
  const effectsSelect = page.getByRole("combobox", { name: "特效级别", exact: true });
  await effectsSelect.click();
  await page.getByRole("option", { name: /精简/ }).click();
  await expect(page.locator(".vx-global-scene")).toHaveAttribute("data-world-tier", "css");
  await expect(page.locator(".vx-global-scene")).toHaveAttribute("data-world-frames", "0");
  await expect(page.locator(".vx-glass-provider")).toHaveAttribute("data-glass-mode", "lite");
  await effectsSelect.click();
  await page.getByRole("option", { name: /完全/ }).click();
  await expect(page.locator(".vx-global-scene")).toHaveAttribute("data-world-tier", "animated");
  await expect.poll(async () => Number(await page.locator(".vx-global-scene").getAttribute("data-world-frames"))).toBeGreaterThan(0);
  await expect(page.locator(".vx-glass-provider")).toHaveAttribute("data-glass-mode", "full");
});
