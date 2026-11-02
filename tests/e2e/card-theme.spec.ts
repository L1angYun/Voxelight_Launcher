import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { installLauncherFixture } from "./fixtures";
import { captureWorld } from "./helpers/world-image";

const evidence = resolve(process.env.VOXELIGHT_E2E_EVIDENCE ?? "test-results", "card-theme");
test.beforeEach(async ({ page }) => {
  await mkdir(evidence, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 930 });
});

test("shared points leave no extra card pool while the selected check persists", async ({ page }) => {
  await installLauncherFixture(page, { worldMaterial: "solid" });
  await page.goto("/");
  await page.locator('button[data-page="library"]').click();
  const selected = page.locator('article[data-instance-id="fixture-world"]');
  const create = page.locator("[data-create-instance]");
  const halo = page.locator("canvas.vx-cursor-halo");
  await expect(halo).toHaveAttribute("data-halo-points", "30");
  await selected.hover();
  await expect(selected).toHaveAttribute("data-halo-owned", "true");
  await expect(selected.locator(":scope > .vx-lattice-frame")).toHaveCSS("visibility", "hidden");
  await expect(selected.locator("svg[data-selected-mark]")).toBeVisible();
  await expect(page.locator(".vx-lattice-frame__dot")).toHaveCount(0);
  await create.hover();
  await expect(create).toHaveAttribute("data-halo-owned", "true");
  await expect(selected).not.toHaveAttribute("data-halo-owned", "true");
  await expect(selected.locator("svg[data-selected-mark]")).toBeVisible();
  await expect(page.locator(".vx-lattice-frame__dot,.vx-lattice-frame.is-dispersing")).toHaveCount(0);
  await page.mouse.move(1390, 885);
  await expect(halo).toHaveAttribute("data-halo-state", "pointer");
  await expect(page.locator(".vx-lattice-frame__dot,.vx-lattice-frame.is-dispersing")).toHaveCount(0);
  await page.screenshot({ path: resolve(evidence, "shared-pool-selected-card.png") });
});

for (const mode of ["lite", "reduced-motion", "forced-colors"] as const) {
  test(`selected card keeps a static keyboard outline under ${mode}`, async ({ page }) => {
    if (mode === "reduced-motion") await page.emulateMedia({ reducedMotion: "reduce" });
    if (mode === "forced-colors") await page.emulateMedia({ forcedColors: "active" });
    await installLauncherFixture(page, { effects: mode === "lite" ? "lite" : "full", worldMaterial: "solid" });
    await page.goto("/");
    await page.locator('button[data-page="library"]').click();
    await page.keyboard.press("Tab");
    const card = page.locator('article[data-instance-id="fixture-world"]');
    await card.locator(".vx-instance-card__select").focus();
    const frame = card.locator(":scope > .vx-lattice-frame");
    await expect(frame).toHaveAttribute("data-focused", "true");
    await expect(frame).toHaveCSS("opacity", "1");
    await expect(frame).toHaveCSS("outline-style", "solid");
    await expect(frame).toHaveCSS("outline-width", "2px");
    await expect(card.locator("svg[data-selected-mark]")).toBeVisible();
    await expect(page.locator("canvas.vx-cursor-halo,.vx-lattice-frame__dot")).toHaveCount(0);
    await page.screenshot({ path: resolve(evidence, `keyboard-selection-${mode}.png`) });
  });
}

test("system light and dark changes update the interface and rendered world together", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await installLauncherFixture(page, { theme: "system", effects: "lite", worldMaterial: "solid" });
  await page.goto("/");
  const scene = page.locator(".world-scene");
  const canvas = await scene.locator("canvas").elementHandle();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(scene).toHaveAttribute("data-world-tier", "static");
  await expect(scene.locator("canvas")).toBeVisible();
  await expect.poll(async () => Number(await scene.getAttribute("data-world-frames"))).toBeGreaterThan(0);
  const darkFrames = Number(await scene.getAttribute("data-world-frames"));
  await expect(scene).toHaveCSS("background-color", "rgb(7, 8, 11)");
  const dark = await captureWorld(page, resolve(evidence, "system-dark-world.png"));
  await page.screenshot({ path: resolve(evidence, "system-dark-ui.png") });
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(scene).toHaveCSS("background-color", "rgb(243, 241, 235)");
  await expect(scene).toHaveAttribute("data-world-tier", "static");
  await expect.poll(async () => Number(await scene.getAttribute("data-world-frames"))).toBeGreaterThan(darkFrames);
  const light = await captureWorld(page, resolve(evidence, "system-light-world.png"));
  await page.screenshot({ path: resolve(evidence, "system-light-ui.png") });
  expect(await scene.locator("canvas").evaluate((element, original) => element === original, canvas)).toBe(true);
  const sky = (image: typeof dark) => {
    let sum = 0, samples = 0;
    for (let y = 160; y < 300; y += 4) for (let x = 800; x < 1400; x += 4) {
      const at = (y * image.width + x) * 4;
      sum += (image.pixels[at] + image.pixels[at + 1] + image.pixels[at + 2]) / 3;
      samples++;
    }
    return sum / samples;
  };
  const measurements = { dark: sky(dark), light: sky(light) };
  expect(measurements.light - measurements.dark).toBeGreaterThan(80);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(scene).toHaveCSS("background-color", "rgb(7, 8, 11)");
  const restored = await captureWorld(page, resolve(evidence, "system-restored-dark-world.png"));
  expect(Math.abs(sky(restored) - measurements.dark)).toBeLessThan(3);
  await writeFile(resolve(evidence, "system-sky-luminance.json"), JSON.stringify(measurements, null, 2));
});
