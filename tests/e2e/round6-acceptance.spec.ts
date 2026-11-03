import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { installLauncherFixture } from "./fixtures";
import { changedPixels, withWorldView } from "./helpers/world-image";
import { encodePng, probeGlassRefraction } from "./helpers/glass-pixel-probe.mjs";

const evidence = resolve(process.env.VOXELIGHT_E2E_EVIDENCE ?? "test-results/world-regressions", "round6");

async function capture(page: Page, name: string) {
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: resolve(evidence, `${name}.png`) });
}

async function assertOperableBounds(page: Page, control: Locator, parts: string[]) {
  await expect(control).toBeVisible();
  await expect(control).toBeEnabled();
  const box = (await control.boundingBox())!;
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  const hits = await control.evaluate((element, selectors) => [element, ...selectors.map(selector => element.querySelector(selector))].map(part => {
    if (!part) return false;
    const rect = part.getBoundingClientRect();
    return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  }), parts);
  expect(hits.length).toBe(parts.length + 1);
  expect(hits.every(Boolean)).toBe(true);
  await control.click({ trial: true });
}

async function assertControlsAboveCanvas(page: Page) {
  const controls = page.getByRole("group", { name: /动画模式|Animation mode/ });
  const canvas = page.locator(".vx-home__character canvas");
  const groupBox = await controls.boundingBox();
  const canvasBox = await canvas.boundingBox();
  expect(groupBox).not.toBeNull();
  expect(canvasBox).not.toBeNull();
  expect(groupBox!.y + groupBox!.height).toBeLessThanOrEqual(canvasBox!.y);
  expect(groupBox!.y).toBeGreaterThanOrEqual(82);
  const triggers = controls.getByRole("combobox", { name: /动画模式|Animation mode/ });
  await expect(triggers).toHaveCount(1);
  for (const trigger of await triggers.all()) {
    await assertOperableBounds(page, trigger, [".vx-select__value", ":scope > svg", ".vx-select__chevron"]);
  }
}

async function assertCompleteLaunch(page: Page, button: Locator) {
  await expect(button).toBeVisible();
  const box = (await button.boundingBox())!;
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  // Rounded Lens clipping changes IntersectionObserver's area ratio even when
  // every part of the launch operation fits in the window and remains operable.
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  const hits = await button.evaluate(element => [element, element.querySelector(".vx-button__label"), element.querySelector(".vx-button__icon")].map(part => {
    if (!part) return false;
    const rect = part.getBoundingClientRect();
    return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  }));
  expect(hits).toEqual([true, true, true]);
  await button.click({ trial: true });
}

for (const theme of ["dark", "light"] as const) {
  for (const [width, height] of [[1440, 930], [1050, 720]]) {
    test(`round6 ${theme} ${width}: launch dock, character controls and recent selection remain separate`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await installLauncherFixture(page, { theme, instanceCount: 2 });
      await page.goto("/");
      await expect(page.locator(".vx-home__character")).toHaveAttribute("data-character-state", "ready");
      const launch = page.getByRole("button", { name: "启动游戏", exact: true });
      await assertCompleteLaunch(page, launch);
      const dock = (await page.locator(".vx-home__stage").boundingBox())!;
      const character = (await page.locator(".vx-home__char-col").boundingBox())!;
      expect(dock.x + dock.width).toBeLessThan(character.x);
      await expect(page.locator(".vx-recent-card")).toHaveCount(2);
      await expect(page.locator('.vx-recent-card[aria-pressed="true"]')).toHaveCount(1);
      expect(await page.locator(".vx-home").evaluate(el => el.scrollHeight <= el.clientHeight)).toBe(true);
      await capture(page, `after-home-${theme}-${width}`);
      await page.locator(".vx-home__char-col").hover();
      const picker = page.locator(".vx-home-animation-selector");
      const trigger = page.getByRole("combobox", { name: "动画模式", exact: true });
      await expect(picker).toHaveCSS("opacity", "1");
      await assertControlsAboveCanvas(page);
      await trigger.click();
      const menu = page.getByRole("listbox", { name: "动画模式", exact: true });
      await expect(menu.getByRole("option")).toHaveCount(3);
      await expect(menu.getByRole("option")).toHaveText(["站立", "行走", "奔跑"]);
      for (const option of await menu.getByRole("option").all()) {
        await assertOperableBounds(page, option, [".vx-select__value", ":scope > svg"]);
      }
      await trigger.press("Escape");
      await expect(trigger).toBeFocused();
      await capture(page, `after-controls-${theme}-${width}`);
      await page.mouse.move(5, height - 5);
      await trigger.focus();
      await expect(picker).toHaveCSS("opacity", "1");
      await trigger.press("End");
      await expect(menu.getByRole("option", { name: "奔跑", exact: true })).toHaveAttribute("data-active", "true");
      await trigger.press("Enter");
      await expect(trigger).toContainText("奔跑");
      await expect(trigger).toBeFocused();
      await expect(page.locator(".vx-home__character")).toHaveAttribute("data-character-animation", "run");
    });
  }
}

test("round6 English long names at minimum size preserve the entire launch action and keyboard picker", async ({ page }) => {
  await page.setViewportSize({ width: 1050, height: 720 });
  await installLauncherFixture(page, { stress: true });
  await page.goto("/");
  await assertCompleteLaunch(page, page.getByRole("button", { name: "Launch game", exact: true }));
  const trigger = page.getByRole("combobox", { name: "Animation mode", exact: true });
  await trigger.focus();
  await expect(page.locator(".vx-home-animation-selector")).toHaveCSS("opacity", "1");
  await assertControlsAboveCanvas(page);
  await trigger.press("End");
  const menu = page.getByRole("listbox", { name: "Animation mode", exact: true });
  await expect(menu.getByRole("option")).toHaveCount(3);
  await expect(menu.getByRole("option")).toHaveText(["Idle", "Walk", "Run"]);
  await trigger.press("Enter");
  await expect(trigger).toContainText("Run");
  await expect(page.locator(".vx-home__character")).toHaveAttribute("data-character-animation", "run");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await capture(page, "after-home-en-long-1050");
});

test("round6 useful empty and missing-character states keep independent recovery actions", async ({ page }) => {
  await installLauncherFixture(page, { noInstances: true, profileFailure: true });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "暂无实例", exact: true })).toHaveCount(1);
  await expect(page.locator(".vx-character-placeholder")).toContainText("账号外观暂不可用");
  await expect(page.locator(".vx-home__character canvas")).toHaveCount(0);
  await capture(page, "after-empty-and-unavailable");
  await page.getByRole("button", { name: "重试账号外观", exact: true }).click();
  await page.getByRole("button", { name: "创建实例", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("round6 unbroken version-directory names stay inside the launch dock", async ({ page }) => {
  await page.setViewportSize({ width: 1050, height: 720 });
  await installLauncherFixture(page);
  await page.addInitScript(() => {
    const api = (window as unknown as { __TAURI_INTERNALS__: { invoke: (name: string, args?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const original = api.invoke;
    api.invoke = async (name, args) => {
      const result = await original(name, args);
      if (name === "bootstrap") {
        const data = result as { instances: { versionId: string }[]; installedVersions: { id: string }[] };
        data.instances[0].versionId = "CustomVersion".repeat(8);
        data.installedVersions[0].id = data.instances[0].versionId;
      }
      return result;
    };
  });
  await page.goto("/");
  const dock = (await page.locator(".vx-home__stage").boundingBox())!;
  const version = (await page.locator(".vx-home__meta li").first().boundingBox())!;
  expect(version.x + version.width).toBeLessThanOrEqual(dock.x + dock.width);
  await assertCompleteLaunch(page, page.getByRole("button", { name: "启动游戏", exact: true }));
});

test("round6 four recent instances fit the minimum viewport without decorative overflow", async ({ page }) => {
  await page.setViewportSize({ width: 1050, height: 720 });
  await installLauncherFixture(page);
  await page.addInitScript(() => {
    const api = (window as unknown as { __TAURI_INTERNALS__: { invoke: (name: string, args?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const original = api.invoke;
    api.invoke = async (name, args) => {
      const result = await original(name, args);
      if (name === "bootstrap") {
        const data = result as { instances: { id: string; name: string }[] };
        data.instances = Array.from({ length: 4 }, (_, index) => ({ ...data.instances[0], id: `review-world-${index}`, name: `世界 ${index}` }));
      }
      return result;
    };
  });
  await page.goto("/");
  await expect(page.locator(".vx-recent-card")).toHaveCount(4);
  for (const card of await page.locator(".vx-recent-card").all()) await expect(card).toBeInViewport({ ratio: 1 });
  await page.waitForTimeout(1000);
  expect(await page.locator(".vx-home").evaluate(el => el.scrollHeight <= el.clientHeight)).toBe(true);
  await page.locator(".vx-home__char-col").hover();
  await assertControlsAboveCanvas(page);
  await capture(page, "after-four-instances-1050");
});

test("round6 system reduced motion draws one static world frame and preserves its visible pixels", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installLauncherFixture(page, { effects: "full" });
  await page.goto("/");
  const scene = page.locator(".vx-global-scene");
  await expect(scene).toHaveAttribute("data-motion", "reduced");
  await expect(page.locator(".vx-home__character")).toHaveAttribute("data-character-paused", "true");
  await expect(scene.locator(".world-scene__canvas")).toBeVisible();
  await expect(scene).toHaveAttribute("data-world-tier", "static");
  await expect.poll(async () => Number(await scene.getAttribute("data-world-frames"))).toBeGreaterThan(0);
  await mkdir(evidence, { recursive: true });
  await withWorldView(page, async capture => {
    const first = await capture(resolve(evidence, "reduced-world-before.png"));
    const frames = Number(await scene.getAttribute("data-world-frames"));
    await page.waitForTimeout(400);
    await page.mouse.move(720, 350);
    await page.mouse.move(1100, 550);
    const second = await capture(resolve(evidence, "reduced-world-after.png"));
    const afterFrames = Number(await scene.getAttribute("data-world-frames"));
    const changed = changedPixels(first, second, 0);
    let bounds: { left: number; top: number; right: number; bottom: number } | null = null;
    if (changed > 0) {
      const pixels = Buffer.alloc(first.pixels.length);
      bounds = { left: first.width, top: first.height, right: 0, bottom: 0 };
      for (let at = 0; at < pixels.length; at += 4) {
        let delta = 0;
        for (let channel = 0; channel < 3; channel++) {
          delta = Math.max(delta, Math.abs(first.pixels[at + channel] - second.pixels[at + channel]));
          pixels[at + channel] = Math.min(255, Math.abs(first.pixels[at + channel] - second.pixels[at + channel]) * 4);
        }
        pixels[at + 3] = 255;
        if (delta) {
          const x = (at / 4) % first.width, y = Math.floor(at / 4 / first.width);
          bounds.left = Math.min(bounds.left, x); bounds.right = Math.max(bounds.right, x);
          bounds.top = Math.min(bounds.top, y); bounds.bottom = Math.max(bounds.bottom, y);
        }
      }
      await writeFile(resolve(evidence, "reduced-world-difference-4x.png"), encodePng({ ...first, pixels }));
    }
    await writeFile(resolve(evidence, "reduced-world-pixels.json"), JSON.stringify({ frames, afterFrames, changedPixels: changed, bounds }, null, 2));
    expect(afterFrames).toBe(frames);
    expect(changed).toBe(0);
  });
  await capture(page, "after-reduced-motion");
});

test("round6 full world changes visibly over time and keeps rendering through a pointer sweep", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await installLauncherFixture(page, { effects: "full" });
  await page.goto("/");
  const scene = page.locator(".vx-global-scene");
  await expect(scene).toHaveAttribute("data-motion", "full");
  await expect(scene.locator(".world-scene__canvas")).toBeVisible();
  await expect(scene).toHaveAttribute("data-world-tier", "animated");
  await expect(scene).toHaveAttribute("data-paused", "false");
  await withWorldView(page, async capture => {
    const first = await capture();
    const frames = Number(await scene.getAttribute("data-world-frames"));
    await page.waitForTimeout(1200);
    const second = await capture();
    expect(Number(await scene.getAttribute("data-world-frames"))).toBeGreaterThan(frames);
    expect(changedPixels(first, second)).toBeGreaterThan(100);
  });
  await page.mouse.move(120, 400);
  await page.mouse.move(1320, 400, { steps: 1 });
  const sweepFrames = Number(await scene.getAttribute("data-world-frames"));
  await expect.poll(async () => Number(await scene.getAttribute("data-world-frames"))).toBeGreaterThan(sweepFrames);
  await capture(page, "after-fast-sweep");
});

test("round6 real backdrop stripes bend only at curvature and follow live background movement", async ({ page }) => {
  await installLauncherFixture(page, { effects: "full" });
  await page.goto("/");
  await expect(page.locator(".vx-floating-nav")).toHaveAttribute("data-motion-settled", "true");
  await expect.poll(async () => (await page.locator(".vx-floating-nav__indicator").boundingBox())?.width ?? 0).toBeGreaterThan(60);
  await expect.poll(async () => (await page.locator(".vx-floating-nav__indicator").boundingBox())?.height ?? 0).toBeGreaterThan(30);
  const result = await probeGlassRefraction(page, evidence);
  expect(result.maxEdgeShift).toBeGreaterThanOrEqual(2);
  expect(result.maxCenterShift).toBeLessThanOrEqual(1);
  expect(result.liveShift).toBeGreaterThanOrEqual(6);
  expect(result.liveShift).toBeLessThanOrEqual(8);
  expect(result.maxUniformDelta).toBeLessThanOrEqual(1);
  expect(result.pass).toBe(true);
});

for (const mode of ["lite", "reduced-transparency", "high-contrast"] as const) {
  test(`round6 ${mode} preserves readable controls at minimum size`, async ({ page }) => {
    await page.setViewportSize({ width: 1050, height: 720 });
    await installLauncherFixture(page, { effects: mode === "lite" ? "lite" : "full" });
    if (mode === "high-contrast") await page.emulateMedia({ forcedColors: "active" });
    if (mode === "reduced-transparency") {
      await page.addInitScript(() => {
        const original = window.matchMedia.bind(window);
        window.matchMedia = (query: string) => {
          const media = original(query);
          if (query !== "(prefers-reduced-transparency: reduce)") return media;
          return new Proxy(media, {
            get(target, property) {
              if (property === "matches") return true;
              const value = Reflect.get(target, property);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        };
      });
    }
    await page.goto("/");
    await assertCompleteLaunch(page, page.getByRole("button", { name: "启动游戏", exact: true }));
    await expect(page.locator(".vx-glass-provider")).toHaveAttribute("data-glass-mode", mode === "lite" ? "lite" : "fallback");
    if (mode === "lite") {
      await expect(page.locator(".vx-global-scene")).toHaveAttribute("data-motion", "reduced");
      await expect(page.locator(".vx-home__character")).toHaveAttribute("data-character-paused", "true");
    } else {
      await expect(page.locator(".vx-window-chrome__bar")).toHaveCSS("backdrop-filter", "none");
    }
    await capture(page, `after-${mode}-1050`);
  });
}

test("round6 preparation and running states expose real progress and their actions", async ({ page }) => {
  await page.setViewportSize({ width: 1050, height: 720 });
  await installLauncherFixture(page, { launchDelay: 3000 });
  await page.goto("/");
  await page.getByRole("button", { name: "启动游戏", exact: true }).click();
  await expect(page.getByText("37%", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "取消准备", exact: true })).toBeInViewport({ ratio: 1 });
  await capture(page, "after-preparing-1050");
  await expect(page.getByRole("button", { name: "停止", exact: true })).toBeInViewport({ ratio: 1 });
  await expect(page.locator(".vx-launch-console__running")).toContainText("正在运行");
  await capture(page, "after-running-1050");
});
