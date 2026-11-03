import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { installLauncherFixture } from "./fixtures";
import { selectValue } from "./select-helpers";

const evidence = resolve(process.env.VOXELIGHT_E2E_EVIDENCE ?? "test-results/reference-alignment");

for (const [width, height] of [[1440, 930], [1050, 720]]) {
  test(`settings navigation height stays constant through all six sections at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await installLauncherFixture(page);
    await page.goto("/");
    await page.locator('button[data-page="settings"]').click();
    // This compares section geometry in the settled page. During entry,
    // locator.click() may scroll its moving target before dispatching input.
    const stage = page.locator('.vx-page-stage[data-page-stage="settings"][data-exiting="false"]');
    await expect(stage).toHaveCSS("opacity", "1");
    await expect(stage).toHaveCSS("transform", "none");
    await page.evaluate(() => document.fonts.ready);
    const main = page.locator("#main-content");
    await expect.poll(() => main.evaluate(element => element.scrollTop)).toBe(0);
    const tabs = page.locator(".vx-settings-nav button");
    const measurements: Array<{ section: string; settingsHeight: number; globalHeight: number; settingsY: number; scrollTop: number }> = [];
    await mkdir(evidence, { recursive: true });
    for (let index = 0; index < 6; index++) {
      const tab = tabs.nth(index);
      await tab.click();
      await expect(tab).toHaveAttribute("aria-current", "page");
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const settings = (await page.locator(".vx-settings-nav").boundingBox())!;
      const chrome = (await page.locator(".vx-window-chrome__bar").boundingBox())!;
      measurements.push({ section: (await tab.textContent())!.trim(), settingsHeight: settings.height, globalHeight: chrome.height,
        settingsY: settings.y, scrollTop: await main.evaluate(element => element.scrollTop) });
      await page.screenshot({ path: resolve(evidence, `settings-section-${index}-${width}.png`) });
    }
    await writeFile(resolve(evidence, `settings-heights-${width}.json`), JSON.stringify(measurements, null, 2));
    expect(Math.max(...measurements.map(row => row.settingsHeight)) - Math.min(...measurements.map(row => row.settingsHeight))).toBeLessThan(1);
    expect(Math.max(...measurements.map(row => row.globalHeight)) - Math.min(...measurements.map(row => row.globalHeight))).toBeLessThan(1);
    expect(Math.max(...measurements.map(row => row.settingsY)) - Math.min(...measurements.map(row => row.settingsY))).toBeLessThan(1);
  });
}

for (const theme of ["dark", "light"] as const) {
  test(`download source uses the shared visible Lens menu in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1050, height: 720 });
    await installLauncherFixture(page, { theme });
    await page.goto("/");
    await page.locator('button[data-page="settings"]').click();
    await page.locator(".vx-settings-nav").getByRole("button", { name: "下载", exact: true }).click();
    const trigger = page.getByRole("combobox", { name: "游戏下载源", exact: true });
    await trigger.click();
    const list = page.getByRole("listbox", { name: "游戏下载源", exact: true });
    await expect(list.getByRole("option")).toHaveCount(3);
    await expect(list.getByRole("option", { selected: true })).toContainText("仅官方源");
    await expect(list.getByRole("option", { selected: true }).locator("[data-selected-mark]")).toBeVisible();
    expect(await list.evaluate(element => element.closest(".vx-listbox-popover")?.matches(":popover-open"))).toBe(true);
    const rect = (await list.boundingBox())!;
    expect(rect.x).toBeGreaterThanOrEqual(16);
    expect(rect.y).toBeGreaterThanOrEqual(16);
    expect(rect.x + rect.width).toBeLessThanOrEqual(1034);
    expect(rect.y + rect.height).toBeLessThanOrEqual(704);
    await page.screenshot({ path: resolve(evidence, `download-source-${theme}-1050.png`) });
    await trigger.press("End");
    await trigger.press("Enter");
    await expect(trigger).toContainText("BMCLAPI");
    await expect(trigger).toBeFocused();
    await expect(list).toHaveCount(0);
    await expect(page.locator("select")).toHaveCount(0);
    await page.locator(".vx-settings-nav").getByRole("button", { name: "外观", exact: true }).click();
    await selectValue(page, "界面语言", "en-US");
    await page.locator(".vx-settings-nav").getByRole("button", { name: "Downloads", exact: true }).click();
    await page.getByRole("combobox", { name: "Download source", exact: true }).click();
    await expect(page.getByRole("listbox", { name: "Download source", exact: true })).toBeVisible();
    await page.screenshot({ path: resolve(evidence, `download-source-${theme}-en-1050.png`) });
  });
}

test("one real cursor point pool migrates from pointer onto the whole card and back", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 930 });
  await installLauncherFixture(page);
  await page.addInitScript(() => {
    const originalClear = CanvasRenderingContext2D.prototype.clearRect;
    const originalArc = CanvasRenderingContext2D.prototype.arc;
    const originalFrame = window.requestAnimationFrame;
    let frameTime: number | null = null;
    window.requestAnimationFrame = callback => originalFrame.call(window, time => {
      const previous = frameTime;
      frameTime = time;
      try { callback(time); } finally { frameTime = previous; }
    });
    const probe = window as unknown as { __haloArcs: number[][]; __haloFrames: {
      rafTime: number | null; drawAt: number; haloState: string | undefined; owned: string | undefined;
      bounds: { x: number; y: number; width: number; height: number } | null;
    }[] };
    probe.__haloArcs = [];
    probe.__haloFrames = [];
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      if (this.canvas.classList.contains("vx-cursor-halo")) {
        probe.__haloArcs = [];
        const card = document.querySelector<HTMLElement>('article[data-instance-id="fixture-world"]');
        const box = card?.getBoundingClientRect();
        probe.__haloFrames.push({ rafTime: frameTime, drawAt: performance.now(), haloState: this.canvas.dataset.haloState,
          owned: card?.dataset.haloOwned, bounds: box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null });
      }
      return originalClear.apply(this, args);
    };
    CanvasRenderingContext2D.prototype.arc = function (...args) {
      if (this.canvas.classList.contains("vx-cursor-halo")) probe.__haloArcs.push([args[0], args[1], args[2], this.globalAlpha]);
      return originalArc.apply(this, args);
    };
  });
  await page.goto("/");
  // The initial important-event animation owns the finite entrance interval.
  await expect(page.locator('.vx-overture-root[data-overture-playing="true"]')).toHaveCount(0);
  const halo = page.locator("canvas.vx-cursor-halo");
  await expect(halo).toHaveCount(1);
  const canvas = await halo.elementHandle();
  const arcs = () => page.evaluate(() => (window as unknown as { __haloArcs: number[][] }).__haloArcs);
  await page.mouse.move(1390, 885);
  await expect(halo).toHaveAttribute("data-halo-state", "pointer");
  await expect.poll(async () => (await arcs()).length).toBe(31);
  await page.screenshot({ path: resolve(evidence, "cursor-01-free-home.png") });
  await page.locator('button[data-page="library"]').click();
  const card = page.locator('article[data-instance-id="fixture-world"]');
  await expect(card).toBeVisible();
  await page.mouse.move(1390, 885);
  await expect(halo).toHaveAttribute("data-halo-state", "pointer");
  const prior = await arcs();
  await card.locator(".vx-instance-card__select").hover();
  await expect(card).toHaveAttribute("data-halo-owned", "true");
  await page.waitForTimeout(100);
  const moving = await arcs();
  await page.screenshot({ path: resolve(evidence, "cursor-02-migrating-card.png") });
  expect(moving).toHaveLength(30);
  expect(moving.some((point, index) => Math.hypot(point[0] - prior[index][0], point[1] - prior[index][1]) > 2)).toBe(true);
  await page.waitForTimeout(1100);
  const bounds = (await card.boundingBox())!;
  const snapshot = await page.evaluate(() => {
    const probe = window as unknown as { __haloArcs: number[][]; __haloFrames: unknown[] };
    return { settled: probe.__haloArcs, frames: probe.__haloFrames };
  });
  const { settled, frames } = snapshot;
  await writeFile(resolve(evidence, "cursor-real-geometry.json"), JSON.stringify({ prior, moving, settled, bounds, frames }, null, 2));
  expect(settled).toHaveLength(30);
  const left = bounds.x - 6, right = bounds.x + bounds.width + 6;
  const top = bounds.y - 6, bottom = bounds.y + bounds.height + 6;
  for (const edgeDistance of [
    settled.map(point => Math.abs(point[0] - left)), settled.map(point => Math.abs(point[0] - right)),
    settled.map(point => Math.abs(point[1] - top)), settled.map(point => Math.abs(point[1] - bottom)),
  ]) expect(Math.min(...edgeDistance)).toBeLessThan(8);
  for (const point of settled) {
    expect(point[3]).toBeGreaterThan(.8);
    expect(Math.min(Math.abs(point[0] - left), Math.abs(point[0] - right), Math.abs(point[1] - top), Math.abs(point[1] - bottom))).toBeLessThan(12);
  }
  await expect(card.locator(":scope > .vx-lattice-frame")).toHaveCSS("visibility", "hidden");
  await page.screenshot({ path: resolve(evidence, "cursor-03-card-outline.png") });
  await page.mouse.move(1390, 885);
  await expect(halo).toHaveAttribute("data-halo-state", "pointer");
  await expect(card).not.toHaveAttribute("data-halo-owned", "true");
  await expect(card.locator(":scope > .vx-lattice-frame")).toHaveCSS("visibility", "visible");
  await expect.poll(async () => (await arcs()).length).toBe(31);
  expect(await halo.evaluate((element, original) => element === original, canvas)).toBe(true);
  await page.screenshot({ path: resolve(evidence, "cursor-04-leave-restored.png") });
});

for (const preference of ["lite", "reduced-motion", "forced-colors"] as const) {
  test(`cursor keeps native card feedback under ${preference}`, async ({ page }) => {
    if (preference === "reduced-motion") await page.emulateMedia({ reducedMotion: "reduce" });
    if (preference === "forced-colors") await page.emulateMedia({ forcedColors: "active" });
    await installLauncherFixture(page, { effects: preference === "lite" ? "lite" : "full" });
    await page.goto("/");
    await page.locator('button[data-page="library"]').click();
    const card = page.locator('article[data-instance-id="fixture-world"]');
    await card.hover();
    await expect(page.locator("canvas.vx-cursor-halo")).toHaveCount(0);
    await expect(card).not.toHaveAttribute("data-halo-owned", "true");
    await expect(card.locator(":scope > .vx-lattice-frame")).toHaveCSS("visibility", "visible");
  });
}
