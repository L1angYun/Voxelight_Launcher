import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { installLauncherFixture } from "./fixtures";
import { decodePng, probeGlassRefraction } from "./helpers/glass-pixel-probe.mjs";
import { captureWorld, worldStructure } from "./helpers/world-image";

const evidence = resolve(process.env.VOXELIGHT_E2E_EVIDENCE ?? "test-results/world-regressions", "global-glass");
const pages = [
  ["home", ".vx-home"], ["library", ".vx-library-page"],
  ["discover", ".vx-discover-page"], ["multiplayer", ".vx-multiplayer-page"],
  ["downloads", ".vx-downloads-page"], ["accounts", ".vx-accounts-page"],
  ["settings", ".vx-settings-page"],
] as const;

for (const theme of ["dark", "light"] as const) {
  for (const [width, height] of [[1440, 930], [1050, 720]]) {
    test(`global ${theme} ${width}: crystal world contributes visible structure on every page`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await installLauncherFixture(page, { theme });
      await page.goto("/");
      const scene = page.locator(".vx-global-scene");
      await expect(scene.locator(".world-scene__canvas")).toBeVisible();
      await expect(scene).toHaveAttribute("data-world-tier", "static");
      await expect.poll(async () => Number(await scene.getAttribute("data-world-frames"))).toBeGreaterThan(0);
      await mkdir(evidence, { recursive: true });
      const measurements: Array<{ page: string; region: string; changedPixels: number; range: number; edges: number }> = [];
      for (const [id, selector] of pages) {
        await page.locator(`button[data-page="${id}"]`).click();
        await expect(page.locator(selector)).toBeInViewport();
        const structure = worldStructure(await captureWorld(page, resolve(evidence, `world-${theme}-${id}-${width}.png`)));
        // An opaque CSS fill, a smooth sky gradient, or a blank WebGL draw cannot
        // satisfy these real terrain-structure assertions by changing base color.
        expect(structure.range, `${id}: terrain must have a visible tonal range`).toBeGreaterThanOrEqual(16);
        expect(structure.edges, `${id}: terrain must contain actual spatial structure`).toBeGreaterThan(100);
        // Capture the real page once, then cover only the background plane.
        // Repeated visibility toggles can retain stale composited canvas tiles.
        const visible = decodePng(await page.screenshot({ path: resolve(evidence, `global-${theme}-${id}-${width}.png`) }));
        await page.locator(".vx-app-body").evaluate(host => {
          const cover = document.createElement("div");
          cover.dataset.backgroundComparison = "";
          cover.setAttribute("aria-hidden", "true");
          Object.assign(cover.style, { position: "absolute", inset: "0", zIndex: "0", background: "var(--bg-base)", pointerEvents: "none" });
          host.append(cover);
        });
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        const hidden = decodePng(await page.screenshot());
        await page.locator("[data-background-comparison]").evaluate(el => el.remove());
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        // The confirmed horizon intentionally leaves the upper sky quiet.
        for (const [region, y] of [["terrain", Math.round(height * .65)], ["foreground", Math.round(height * .85)]] as const) {
          let changedPixels = 0;
          for (let row = y; row < y + 18; row++) for (let column = 24; column < width - 24; column++) {
            const at = (row * visible.width + column) * 4;
            if (Math.max(...[0, 1, 2].map(c => Math.abs(visible.pixels[at + c] - hidden.pixels[at + c]))) > 3) changedPixels++;
          }
          expect(changedPixels, `${id}/${region}: the shared scene must remain visible`).toBeGreaterThan(200);
          measurements.push({ page: id, region, changedPixels, ...structure });
        }
      }
      await writeFile(resolve(evidence, `background-pixels-${theme}-${width}.json`), JSON.stringify(measurements, null, 2));
    });
  }
}

test("the selected navigation slider refracts the real backdrop outside the entire bar", async ({ page }) => {
  await installLauncherFixture(page);
  await page.goto("/");
  const bar = page.locator(".vx-window-chrome__bar");
  await expect(bar).not.toHaveClass(/vx-glass-surface/);
  await expect(bar).toHaveCSS("backdrop-filter", "none");
  const slider = page.locator(".vx-floating-nav__indicator");
  await expect(slider).toHaveAttribute("data-glass-refraction", "curvature");
  await expect(page.locator(".vx-floating-nav")).toHaveAttribute("data-motion-settled", "true");
  const result = await probeGlassRefraction(page, resolve(evidence, "slider"));
  expect(result.initial.sourceParentClass).toContain("vx-app-body");
  expect(result.initial.ancestorBackdropFilters).toEqual([]);
  expect(result.maxEdgeShift).toBeGreaterThanOrEqual(2);
  expect(result.maxCenterShift).toBeLessThanOrEqual(1);
  expect(result.liveShift).toBeGreaterThanOrEqual(6);
  expect(result.liveShift).toBeLessThanOrEqual(8);
  expect(result.maxUniformDelta).toBeLessThanOrEqual(1);
  expect(result.pass).toBe(true);
});

for (const theme of ["dark", "light"] as const) {
  for (const [width, height] of [[1440, 930], [1050, 720]]) {
    test(`picker ${theme} ${width}: themed instance menu opens above the dock and selects a real context`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await installLauncherFixture(page, { theme });
      await page.goto("/");
      const trigger = page.getByRole("combobox", { name: "当前实例", exact: true });
      await trigger.click();
      const menu = page.getByRole("listbox", { name: "当前实例", exact: true });
      await expect(menu).toBeVisible();
      const popover = page.locator(".vx-instance-picker__popover");
      const material = popover.locator(":scope > .vx-listbox-surface");
      await expect(material).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      const menuBlur = await material.evaluate(element => getComputedStyle(element).getPropertyValue("--vx-lens-menu-blur").trim());
      await expect(material).toHaveCSS("backdrop-filter", new RegExp(`blur\\(${menuBlur}\\).*vx-liquid-refraction`));
      await expect(material).toHaveCSS("opacity", "1");
      await expect(popover).toHaveAttribute("data-placement", "top");
      const menuBox = (await popover.boundingBox())!;
      await expect(popover).toHaveCSS("opacity", "1");
      const triggerBox = (await trigger.boundingBox())!;
      expect(menuBox.x).toBeGreaterThanOrEqual(16);
      expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(width - 16);
      expect(menuBox.y).toBeGreaterThanOrEqual(16);
      expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(triggerBox.y);
      expect(await popover.evaluate(el => el.parentElement?.classList.contains("vx-glass-provider"))).toBe(true);
      await expect(menu.locator('[data-instance-id="fixture-world"]')).toHaveAttribute("aria-selected", "true");
      await expect(menu.locator('[data-instance-id="fixture-world"] [data-selected-mark]')).toBeVisible();
      await expect(page.locator(".vx-launch-console select")).toHaveCount(0);
      await page.screenshot({ path: resolve(evidence, `picker-${theme}-${width}.png`) });
      await menu.locator("[data-version-directory]").click();
      await expect(trigger).toContainText("使用版本目录");
      await expect(page.locator(".vx-home__console-name")).toHaveText("1.21.1");
      await trigger.press("ArrowUp");
      await trigger.press("Home");
      await trigger.press("Enter");
      await expect(page.locator(".vx-home__console-name")).toHaveText("合成测试世界");
      await expect(trigger).toBeFocused();
    });
  }
}

test("picker keyboard exploration, cancellation, Tab and outside click keep focus and context", async ({ page }) => {
  await installLauncherFixture(page, { stress: true });
  await page.goto("/");
  const trigger = page.getByRole("combobox", { name: "Current instance", exact: true });
  await trigger.focus();
  await trigger.press("j");
  await expect(page.locator('[role="option"][data-instance-id="short-instance"]')).toHaveAttribute("data-active", "true");
  await trigger.press("Escape");
  await expect(trigger).toContainText("Christopher");
  await expect(trigger).toBeFocused();
  await trigger.press("j");
  await trigger.press("Enter");
  await expect(page.locator(".vx-home__console-name")).toHaveText("Jo");
  await trigger.press("End");
  await trigger.press("Tab");
  await expect(trigger).toContainText("Use version directory");
  await expect(page.getByRole("button", { name: "Open folder", exact: true })).toBeFocused();
  await trigger.click();
  const settings = page.locator('button[data-page="settings"]');
  await settings.click();
  await expect(settings).toBeFocused();
  await expect(page.locator(".vx-instance-picker__popover")).toHaveCount(0);
});

test("picker long instance collections scroll within the menu and expose the last option", async ({ page }) => {
  await page.setViewportSize({ width: 1050, height: 720 });
  await installLauncherFixture(page);
  await page.addInitScript(() => {
    const api = (window as unknown as { __TAURI_INTERNALS__: { invoke: (name: string, args?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const original = api.invoke;
    api.invoke = async (name, args) => {
      const result = await original(name, args);
      if (name === "bootstrap") {
        const data = result as { instances: { id: string; name: string }[] };
        data.instances = Array.from({ length: 60 }, (_, index) => ({ ...data.instances[0], id: `menu-world-${index}`, name: `世界 ${index} ${"A".repeat(80)}` }));
      }
      return result;
    };
  });
  await page.goto("/");
  const trigger = page.getByRole("combobox", { name: "当前实例", exact: true });
  await trigger.press("ArrowDown");
  const menu = page.getByRole("listbox", { name: "当前实例", exact: true });
  expect(await menu.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await trigger.press("End");
  await expect(menu.locator("[data-version-directory]")).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: resolve(evidence, "picker-long-collection-1050.png") });
  await trigger.press("Enter");
  await expect(trigger).toContainText("使用版本目录");
});

test("one world canvas serves full and lite modes while real data points remain independent", async ({ page }) => {
  for (const effects of ["full", "lite"] as const) {
    const context = await page.context().browser()!.newContext();
    const current = await context.newPage();
    await installLauncherFixture(current, { effects, instanceCount: 2 });
    await current.addInitScript(() => {
      const api = (window as unknown as { __TAURI_INTERNALS__: { invoke: (name: string, args?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
      const original = api.invoke;
      api.invoke = async (name, args) => name === "list_download_tasks" ? [{
        id: "point-regression", kind: "install", target: "1.21.1", label: "1.21.1", status: "running", stage: "download",
        completed: 65, total: 130, bytesCompleted: 1024, bytesTotal: 2048, message: "",
        createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:01Z",
      }] : original(name, args);
    });
    await current.goto("http://127.0.0.1:1420/");
    await expect(current.locator(".vx-global-scene canvas")).toHaveCount(1);
    await expect(current.locator(".world-scene__canvas")).toBeVisible();
    await expect(current.locator(".vx-global-scene")).toHaveAttribute("data-world-tier", effects === "full" ? "animated" : "static");
    await expect(current.locator(".vx-recent-card .vx-lattice-frame")).toHaveCount(2);
    await expect(current.locator(".vx-lattice-frame__dot")).toHaveCount(0);
    await expect(current.locator('.vx-recent-card[aria-current="true"] .vx-lattice-frame[data-selected="true"]')).toBeVisible();
    await current.locator('button[data-page="downloads"]').click();
    const progress = current.locator('[data-task-id="point-regression"] canvas.vx-lattice-progress');
    await expect(progress).toBeVisible();
    await expect(progress).toHaveAttribute("aria-valuenow", "1024");
    await expect(progress).toHaveAttribute("aria-valuemax", "2048");
    await expect(progress).toHaveAttribute("aria-valuetext", "50%");
    await expect.poll(() => progress.evaluate((canvas: HTMLCanvasElement) => {
      const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
      return pixels.some((value, index) => index % 4 === 3 && value > 0);
    })).toBe(true);
    await context.close();
  }
});

test("the liquid navigation slider keeps pressure and edge lag while dragging across groups", async ({ page }) => {
  await installLauncherFixture(page);
  await page.goto("/");
  const nav = page.locator(".vx-floating-nav");
  await expect(nav).toHaveAttribute("data-motion-settled", "true");
  const home = (await page.locator('button[data-page="home"]').boundingBox())!;
  const settings = (await page.locator('button[data-page="settings"]').boundingBox())!;
  await page.mouse.move(home.x + home.width / 2, home.y + home.height / 2);
  await page.mouse.down();
  await page.mouse.move(settings.x + settings.width / 2, settings.y + settings.height / 2, { steps: 15 });
  await expect(nav).toHaveAttribute("data-dragging", "true");
  const indicator = page.locator(".vx-floating-nav__indicator-slot");
  await expect.poll(async () => indicator.evaluate(el => Number(el.style.getPropertyValue("--jelly-press")))).toBeGreaterThan(.1);
  await page.locator(".vx-window-chrome").screenshot({ path: resolve(evidence, "bar-slider-drag.png") });
  await page.mouse.up();
  await expect(page.locator(".vx-settings-page")).toBeInViewport();
  await expect(nav).toHaveAttribute("data-motion-settled", "true");
  await page.screenshot({ path: resolve(evidence, "bar-slider-settings.png") });
});

for (const mode of ["lite", "reduced-motion", "reduced-transparency", "high-contrast"] as const) {
  test(`picker ${mode}: system preferences keep the menu immediate and usable`, async ({ page }) => {
    await page.setViewportSize({ width: 1050, height: 720 });
    if (mode === "reduced-motion") await page.emulateMedia({ reducedMotion: "reduce" });
    if (mode === "high-contrast") await page.emulateMedia({ forcedColors: "active" });
    await installLauncherFixture(page, { effects: mode === "lite" ? "lite" : "full" });
    if (mode === "reduced-transparency") await page.addInitScript(() => {
      const api = (window as unknown as { __TAURI_INTERNALS__: { invoke: (name: string, args?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
      const original = api.invoke;
      api.invoke = async (name, args) => name === "get_system_appearance"
        ? { accentColor: "#b4f17a", animationsEnabled: true, advancedEffectsEnabled: false, locale: "zh-CN" }
        : original(name, args);
    });
    await page.goto("/");
    const trigger = page.getByRole("combobox", { name: "当前实例", exact: true });
    await trigger.click();
    await expect(page.getByRole("listbox")).toBeVisible();
    await expect(page.locator(".vx-instance-picker__popover")).toHaveAttribute("data-animate", "false");
    if (mode === "reduced-transparency" || mode === "high-contrast") {
      const material = page.locator(".vx-instance-picker__popover > .vx-listbox-surface");
      await expect(material).toHaveCSS("backdrop-filter", "none");
      await expect(material).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    }
    await page.screenshot({ path: resolve(evidence, `picker-${mode}-1050.png`) });
    await trigger.press("Escape");
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
}
