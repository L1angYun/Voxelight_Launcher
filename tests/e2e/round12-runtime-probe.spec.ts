import { expect, test } from "@playwright/test";
import { installLauncherFixture } from "./fixtures";

test("all launcher pages remain reachable with a single crystal world behind them", async ({ page }, testInfo) => {
  await installLauncherFixture(page);
  await page.goto("/");

  await expect(page.locator(".vx-home")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("round12-home.png") });
  const scene = page.locator(".vx-global-scene");
  const canvas = scene.locator(".world-scene__canvas");
  await expect(canvas).toBeVisible();
  const originalCanvas = await canvas.elementHandle();
  await expect(scene).toHaveAttribute("data-paused", "false");
  await expect(page.locator(".vx-window-chrome")).toHaveAttribute(
    "data-tauri-drag-region",
    "deep",
  );
  await expect
    .poll(() => scene.evaluate((element) => getComputedStyle(element).pointerEvents))
    .toBe("none");
  const frames = Number(await scene.getAttribute("data-world-frames"));
  await page.mouse.move(760, 650);
  for (let x = 780; x <= 1040; x += 20) {
    await page.mouse.move(x, 650 + Math.sin(x / 42) * 28);
  }
  await expect.poll(async () => Number(await scene.getAttribute("data-world-frames"))).toBeGreaterThan(frames);
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
    await expect(scene.locator("canvas")).toHaveCount(1);
    expect(await canvas.evaluate((element, original) => element === original, originalCanvas)).toBe(true);
    const chrome = (await page.locator(".vx-window-chrome").boundingBox())!;
    await expect
      .poll(async () => Math.round((await page.locator("#main-content").boundingBox())?.y ?? -1))
      .toBe(Math.round(chrome.y + chrome.height));
    await expect(page.locator(".vx-app-body")).toHaveAttribute(
      "data-current-page",
      id,
    );
  }
});
