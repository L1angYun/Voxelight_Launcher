// SPDX-License-Identifier: GPL-3.0-only
import { expect, test, type Page } from "@playwright/test";
import { installLauncherFixture } from "./fixtures";
import { changedPixels, withWorldView, worldStructure } from "./helpers/world-image";
import { selectValue } from "./select-helpers";

test.use({ viewport: { width: 1280, height: 720 } });

async function openAppearance(page: Page) {
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "设置", exact: true }).click();
  await page.locator(".vx-settings-nav").getByRole("button", { name: "外观", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "世界材质", exact: true })).toBeVisible();
}

async function makeFixtureLaunchCancellable(page: Page) {
  await page.addInitScript(() => {
    const api = (window as unknown as {
      __TAURI_INTERNALS__: { invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown> };
    }).__TAURI_INTERNALS__;
    const original = api.invoke;
    let generation = 0;
    let cancel: (() => void) | null = null;
    api.invoke = async (name, args) => {
      if (name === "cancel_download_task") {
        generation++;
        cancel?.();
      }
      if (name !== "launch_game") return original(name, args);
      const token = ++generation;
      const cancelled = new Promise<never>((_, reject) => {
        cancel = () => reject(new Error("任务已取消，已校验文件保留供下次复用"));
      });
      try {
        const result = await Promise.race([original(name, args), cancelled]);
        if (token !== generation) throw new Error("任务已取消，已校验文件保留供下次复用");
        return result;
      } finally {
        cancel = null;
      }
    };
  });
}

test("default lattice renders real animated terrain and continues through pointer movement", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await installLauncherFixture(page);
  await page.goto("/");
  const scene = page.locator(".vx-global-scene");
  await expect(scene.locator(".world-scene__canvas")).toBeVisible();
  await expect(scene).toHaveAttribute("data-world-material", "lattice");
  await expect(scene).toHaveAttribute("data-world-tier", "animated");
  await expect.poll(async () => Number(await scene.getAttribute("data-world-frames"))).toBeGreaterThan(0);
  await withWorldView(page, async capture => {
    const before = await capture(testInfo.outputPath("lattice-before.png"));
    const structure = worldStructure(before);
    expect(structure.range).toBeGreaterThanOrEqual(16);
    expect(structure.edges).toBeGreaterThan(100);
    const frames = Number(await scene.getAttribute("data-world-frames"));
    for (let x = 620; x <= 1040; x += 35) await page.mouse.move(x, 650 + Math.sin(x / 50) * 50);
    await page.waitForTimeout(900);
    const after = await capture(testInfo.outputPath("lattice-after.png"));
    expect(Number(await scene.getAttribute("data-world-frames"))).toBeGreaterThan(frames);
    expect(changedPixels(before, after)).toBeGreaterThan(100);
  });
  await expect(page.getByRole("button", { name: "启动游戏", exact: true })).toBeEnabled();
  expect(errors).toEqual([]);
});

test("no float targets uses solid while preserving the requested lattice preference and localized explanation", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await installLauncherFixture(page);
  await page.addInitScript(() => {
    const getExtension = WebGL2RenderingContext.prototype.getExtension as (this: WebGL2RenderingContext, name: string) => unknown;
    WebGL2RenderingContext.prototype.getExtension = function (this: WebGL2RenderingContext, name: string) {
      return name === "EXT_color_buffer_float" ? null : getExtension.call(this, name);
    } as typeof WebGL2RenderingContext.prototype.getExtension;
  });
  await page.goto("/");
  const scene = page.locator(".vx-global-scene");
  await expect(scene).toHaveAttribute("data-world-material", "solid");
  await expect(scene).toHaveAttribute("data-world-tier", "animated");
  await openAppearance(page);
  await expect(page.getByRole("combobox", { name: "世界材质", exact: true })).toContainText("点阵");
  const chineseExplanation = page.getByRole("status").filter({ hasText: "当前设备无法使用浮点粒子渲染" });
  await expect(chineseExplanation).toBeVisible();
  await expect(chineseExplanation).toContainText("已暂用实体材质");
  await expect(chineseExplanation).toContainText("点阵选择仍会保留");
  await selectValue(page, "界面语言", "en-US");
  const englishExplanation = page.getByRole("status").filter({ hasText: "Floating-point particle rendering is unavailable on this device." });
  await expect(englishExplanation).toBeVisible();
  await expect(englishExplanation).toContainText("Solid is used temporarily");
  await expect(englishExplanation).toContainText("your Lattice preference is preserved");
  await expect(page.getByRole("combobox", { name: "World material", exact: true })).toContainText("Lattice");
  await page.getByRole("button", { name: "Save settings", exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    const fixture = (window as unknown as {
      __appearanceFixtures: { calls: { name: string; args?: { config?: { worldMaterial?: string; language?: string } } }[] };
    }).__appearanceFixtures;
    return fixture.calls.filter(call => call.name === "save_config").at(-1)?.args?.config;
  })).toMatchObject({ worldMaterial: "lattice", language: "en-US" });
  await expect(page.getByRole("button", { name: "Save settings", exact: true })).toBeDisabled();
  await expect(scene).toHaveAttribute("data-world-material", "solid");
  expect(errors).toEqual([]);
});

test("appearance switches world material and scene without replacing its canvas or WebGL context", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await installLauncherFixture(page);
  await page.goto("/");
  const scene = page.locator(".vx-global-scene");
  const canvas = scene.locator(".world-scene__canvas");
  await expect(scene).toHaveAttribute("data-world-material", "lattice");
  const originalCanvas = await canvas.elementHandle();
  const originalContext = await canvas.evaluateHandle(node => (node as HTMLCanvasElement).getContext("webgl2"));
  expect(await originalContext.evaluate(context => context !== null)).toBe(true);
  await openAppearance(page);
  await page.getByRole("checkbox", { name: "声音效果", exact: true }).check();
  const before = await withWorldView(page, capture => capture(testInfo.outputPath("settings-lattice-horizon.png")));
  const frames = Number(await scene.getAttribute("data-world-frames"));
  await selectValue(page, "世界材质", "solid");
  await expect(scene).toHaveAttribute("data-world-material", "solid");
  await selectValue(page, "世界场景", "massif");
  await expect(page.getByRole("combobox", { name: "世界场景", exact: true })).toContainText("山体");
  await expect(page.getByRole("checkbox", { name: "声音效果", exact: true })).toBeChecked();
  await expect(page.getByRole("heading", { name: "设置", exact: true })).toBeVisible();
  await page.waitForTimeout(1200);
  const after = await withWorldView(page, capture => capture(testInfo.outputPath("settings-solid-massif.png")));
  expect(changedPixels(before, after)).toBeGreaterThan(100);
  await expect.poll(async () => Number(await scene.getAttribute("data-world-frames"))).toBeGreaterThan(frames);
  expect(await canvas.evaluate((node, previous) => node === previous, originalCanvas)).toBe(true);
  expect(await canvas.evaluate((node, previous) => (node as HTMLCanvasElement).getContext("webgl2") === previous, originalContext)).toBe(true);
  expect(await originalContext.evaluate(context => context?.isContextLost())).toBe(false);
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    const fixture = (window as unknown as {
      __appearanceFixtures: { calls: { name: string; args?: { config?: Record<string, unknown> } }[] };
    }).__appearanceFixtures;
    return fixture.calls.filter(call => call.name === "save_config").at(-1)?.args?.config;
  })).toMatchObject({ worldMaterial: "solid", worldScene: "massif", soundEnabled: true });
  await expect(page.getByRole("button", { name: "保存设置", exact: true })).toBeDisabled();
  expect(errors).toEqual([]);
});

test("runtime accent changes keep real lattice pixels updating without a context restart", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await installLauncherFixture(page);
  await page.goto("/");
  const scene = page.locator(".vx-global-scene");
  const canvas = scene.locator(".world-scene__canvas");
  await expect(scene).toHaveAttribute("data-world-material", "lattice");
  const originalContext = await canvas.evaluateHandle(node => (node as HTMLCanvasElement).getContext("webgl2"));
  await withWorldView(page, async capture => {
    const before = await capture(testInfo.outputPath("accent-before.png"));
    const frames = Number(await scene.getAttribute("data-world-frames"));
    await page.evaluate(() => document.documentElement.style.setProperty("--accent", "#ff2b83"));
    for (let x = 540; x <= 1020; x += 40) await page.mouse.move(x, 580 + Math.sin(x / 60) * 40);
    await page.waitForTimeout(700);
    const after = await capture(testInfo.outputPath("accent-after.png"));
    expect(changedPixels(before, after)).toBeGreaterThan(100);
    expect(Number(await scene.getAttribute("data-world-frames"))).toBeGreaterThan(frames);
  });
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim())).toBe("#ff2b83");
  expect(await canvas.evaluate((node, previous) => (node as HTMLCanvasElement).getContext("webgl2") === previous, originalContext)).toBe(true);
  await expect(scene).toHaveAttribute("data-world-tier", "animated");
  expect(errors).toEqual([]);
});

test("holding and dragging the home title preserves native text selection", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await installLauncherFixture(page);
  await page.goto("/");
  const scene = page.locator(".vx-global-scene");
  await expect(scene).toHaveAttribute("data-world-material", "lattice");
  await expect(scene).toHaveCSS("pointer-events", "none");
  const title = page.locator(".vx-home__console-name");
  await expect(title).toHaveText("合成测试世界");
  const text = await title.innerText();
  const bounds = await title.evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const rect = range.getBoundingClientRect();
    return { left: rect.left, right: rect.right, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(bounds.left + 1, bounds.y);
  await page.mouse.down();
  await page.waitForTimeout(400);
  await page.mouse.move(bounds.right - 1, bounds.y, { steps: 16 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(text);
  await expect(page.getByRole("button", { name: "启动游戏", exact: true })).toBeEnabled();
  expect(errors).toEqual([]);
});

for (const mode of ["lite effects", "system reduced motion", "high contrast"] as const) {
  test(`${mode} keeps a real static world unchanged during pointer activity`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.emulateMedia({
      reducedMotion: mode === "system reduced motion" ? "reduce" : "no-preference",
      contrast: mode === "high contrast" ? "more" : "no-preference",
    });
    await installLauncherFixture(page, { effects: mode === "lite effects" ? "lite" : "full" });
    await page.goto("/");
    const scene = page.locator(".vx-global-scene");
    await expect(scene.locator(".world-scene__canvas")).toBeVisible();
    await expect(scene).toHaveAttribute("data-world-tier", "static");
    await expect(page.locator(".vx-home__console-name")).toHaveText("合成测试世界");
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await expect(page.locator("html")).toHaveAttribute("data-high-contrast", String(mode === "high contrast"));
    await expect.poll(async () => Number(await scene.getAttribute("data-world-frames"))).toBeGreaterThan(0);
    // Bootstrap, media policy, and the home anchor may each request an initial static redraw.
    await expect.poll(async () => {
      const frames = Number(await scene.getAttribute("data-world-frames"));
      await page.waitForTimeout(400);
      return Number(await scene.getAttribute("data-world-frames")) - frames;
    }).toBe(0);
    await withWorldView(page, async capture => {
      const before = await capture(testInfo.outputPath("static-before.png"));
      const structure = worldStructure(before);
      expect(structure.range).toBeGreaterThanOrEqual(16);
      expect(structure.edges).toBeGreaterThan(100);
      const frames = Number(await scene.getAttribute("data-world-frames"));
      await page.mouse.move(840, 610);
      await page.mouse.down();
      await page.waitForTimeout(400);
      await page.mouse.move(1020, 620, { steps: 4 });
      await page.mouse.up();
      const after = await capture(testInfo.outputPath("static-after.png"));
      expect(Number(await scene.getAttribute("data-world-frames"))).toBe(frames);
      expect(changedPixels(before, after, 0)).toBe(0);
    });
    expect(errors).toEqual([]);
  });
}

test("launch state: home preparation follows real 37% progress and cancellation restores idle", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await installLauncherFixture(page, { launchDelay: 10_000 });
  await makeFixtureLaunchCancellable(page);
  await page.goto("/");
  const scene = page.locator(".vx-global-scene");
  await expect(scene).toHaveAttribute("data-world-phase", "idle");
  await page.getByRole("button", { name: "启动游戏", exact: true }).click();
  await expect(page.getByText("37%", { exact: true })).toBeVisible();
  await expect(scene).toHaveAttribute("data-world-phase", "preparing");
  await expect.poll(async () => Number(await scene.getAttribute("data-world-front"))).toBeGreaterThan(0);
  await expect.poll(async () => Number(await scene.getAttribute("data-world-front")), { timeout: 8000 }).toBe(61);
  await page.getByRole("button", { name: "取消准备", exact: true }).click();
  await expect(scene).toHaveAttribute("data-world-phase", "idle", { timeout: 3000 });
  await expect(scene).toHaveAttribute("data-world-front", "0", { timeout: 3000 });
  await expect(page.getByRole("button", { name: "启动游戏", exact: true })).toBeEnabled();
  // The original fixture timer still resolves. Its stale success must not revive a cancelled launch.
  await page.waitForTimeout(10_100);
  await expect(scene).toHaveAttribute("data-world-phase", "idle");
  await expect(scene).toHaveAttribute("data-world-front", "0");
  await expect(page.getByRole("button", { name: "停止", exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("launch state: success fills the world, freezes its rendered frames, and Stop restores idle", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await installLauncherFixture(page, { launchDelay: 3000 });
  await page.goto("/");
  const scene = page.locator(".vx-global-scene");
  await expect(scene).toHaveAttribute("data-world-phase", "idle");
  await expect(scene).toHaveAttribute("data-world-front", "0");
  const idle = await withWorldView(page, capture => capture(testInfo.outputPath("launch-idle.png")));
  await page.getByRole("button", { name: "启动游戏", exact: true }).click();
  await expect(page.getByText("37%", { exact: true })).toBeVisible();
  await expect(scene).toHaveAttribute("data-world-phase", "preparing");
  await expect.poll(async () => Number(await scene.getAttribute("data-world-front"))).toBeGreaterThan(0);
  await expect(scene).toHaveAttribute("data-world-phase", "running");
  // The director unit test checks the 600 ms logical duration; this software-rendered E2E observes its completed result.
  await expect(scene).toHaveAttribute("data-world-front", "165");
  await expect(page.getByRole("button", { name: "停止", exact: true })).toBeEnabled();
  // Exclude the legacy 830 ms Overture pause from the settled-world observation.
  await page.waitForTimeout(1000);
  await expect(scene).toHaveAttribute("data-paused", "false");
  await expect.poll(async () => {
    const before = Number(await scene.getAttribute("data-world-frames"));
    await page.waitForTimeout(700);
    return Number(await scene.getAttribute("data-world-frames")) - before;
  }, { timeout: 15_000 }).toBe(0);
  await withWorldView(page, async capture => {
    const before = await capture(testInfo.outputPath("launch-running-frozen.png"));
    const frames = Number(await scene.getAttribute("data-world-frames"));
    await page.waitForTimeout(1000);
    const after = await capture(testInfo.outputPath("launch-running-still.png"));
    expect(Number(await scene.getAttribute("data-world-frames"))).toBe(frames);
    expect(changedPixels(before, after, 0)).toBe(0);
    expect(changedPixels(idle, before)).toBeGreaterThan(100);
  });
  const stoppedFrames = Number(await scene.getAttribute("data-world-frames"));
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await expect(scene).toHaveAttribute("data-world-phase", "idle");
  await expect(scene).toHaveAttribute("data-world-front", "0");
  await expect.poll(async () => Number(await scene.getAttribute("data-world-frames"))).toBeGreaterThan(stoppedFrames);
  await expect(page.getByRole("button", { name: "启动游戏", exact: true })).toBeEnabled();
  expect(errors).toEqual([]);
});

test("launch state: launching from the library drives the shared world across navigation", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await installLauncherFixture(page, { launchDelay: 5000 });
  await page.goto("/");
  const scene = page.locator(".vx-global-scene");
  const canvas = scene.locator(".world-scene__canvas");
  const originalCanvas = await canvas.elementHandle();
  await page.locator('button[data-page="library"]').click();
  await expect(page.locator(".vx-library-page")).toBeVisible();
  await page.locator('[data-instance-id="fixture-world"]').getByRole("button", { name: "启动游戏", exact: true }).click();
  await expect(page.locator(".vx-launch-status")).toContainText("37%");
  await expect(scene).toHaveAttribute("data-world-phase", "preparing");
  await expect.poll(async () => Number(await scene.getAttribute("data-world-front"))).toBeGreaterThan(0);
  await page.locator('button[data-page="downloads"]').click();
  await expect(page.locator(".vx-downloads-page")).toBeVisible();
  await expect(scene).toHaveAttribute("data-world-phase", "preparing");
  await expect(scene).toHaveAttribute("data-world-phase", "running", { timeout: 8000 });
  await expect(scene).toHaveAttribute("data-world-front", "165");
  await page.locator('button[data-page="home"]').click();
  await expect(page.getByRole("button", { name: "停止", exact: true })).toBeEnabled();
  await expect(scene).toHaveAttribute("data-world-phase", "running");
  expect(await canvas.evaluate((node, previous) => node === previous, originalCanvas)).toBe(true);
  expect(errors).toEqual([]);
});
