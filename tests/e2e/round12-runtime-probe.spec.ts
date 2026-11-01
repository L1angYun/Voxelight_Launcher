import { expect, test } from "@playwright/test";
import { installLauncherFixture } from "./fixtures";

test("all launcher pages remain reachable with the cube scene behind them", async ({ page }, testInfo) => {
  await installLauncherFixture(page);
  await page.goto("/");

  await expect(page.locator(".vx-home")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("round12-home.png") });
  const scene = page.locator(".vx-global-scene");
  await expect(page.locator(".vx-window-chrome")).toHaveAttribute(
    "data-tauri-drag-region",
    "deep",
  );
  await expect
    .poll(() => scene.evaluate((element) => getComputedStyle(element).pointerEvents))
    .toBe("none");
  await page.mouse.move(760, 650);
  for (let x = 780; x <= 1040; x += 20) {
    await page.mouse.move(x, 650 + Math.sin(x / 42) * 28);
  }
  await expect(scene).toHaveAttribute("data-pointer-active", "true");
  await expect
    .poll(async () => Number(await scene.getAttribute("data-active-flips")))
    .toBeGreaterThan(0);
  await page.screenshot({ path: testInfo.outputPath("round12-pointer.png") });

  for (const [id, selector] of [
    ["library", ".vx-library-page"],
    ["discover", ".vx-discover-page"],
    ["multiplayer", ".vx-multiplayer-page"],
    ["downloads", ".vx-downloads-page"],
    ["accounts", ".vx-accounts-page"],
    ["settings", ".vx-settings-page"],
  ] as const) {
    await page.locator(`[data-page="${id}"]`).click();
    await expect(page.locator(selector)).toBeInViewport();
    await expect
      .poll(async () => Math.round((await page.locator("#main-content").boundingBox())?.y ?? -1))
      .toBe(0);
    await expect(page.locator(".vx-app-body")).toHaveAttribute(
      "data-current-page",
      id,
    );
  }
});
