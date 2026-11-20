import { expect, test, type Page } from "@playwright/test";
import { installLauncherFixture } from "./fixtures";

// Lite and reduced motion paint one static scene, so the home character is kept
// as a plain 2D still and its WebGL viewer is released (memory, TODO §2).
const character = (page: Page) => page.locator(".vx-home__character");
const webglCanvases = (page: Page) => page.evaluate(() =>
  [...document.querySelectorAll<HTMLCanvasElement>(".vx-home__character canvas")]
    .map(canvas => ({ still: canvas.dataset.characterStill === "true", width: canvas.width, height: canvas.height })));

test("Lite keeps the home character as a 2D still with no live viewer", async ({ page }) => {
  await installLauncherFixture(page, { effects: "lite" });
  await page.goto("/");
  await expect(character(page)).toHaveAttribute("data-character-state", "ready");
  await expect(character(page)).toHaveAttribute("data-character-frozen", "true");
  const canvases = await webglCanvases(page);
  expect(canvases).toHaveLength(1);
  expect(canvases[0].still).toBe(true);
  expect(canvases[0].width).toBeGreaterThan(100);
  await expect(page.locator(".vx-home__character canvas")).toHaveAttribute("role", "img");
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
