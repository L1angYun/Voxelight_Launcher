// SPDX-License-Identifier: GPL-3.0-only
import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { installLauncherFixture } from "./fixtures";

test.use({ viewport: { width: 1280, height: 720 }, channel: "chromium", launchOptions: { args: ["--use-angle=d3d11"] } });

test.afterEach(async ({ page }, info) => {
  const runtime = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(".world-scene__canvas");
    const gl = canvas?.getContext("webgl2");
    const extension = gl?.getExtension("WEBGL_debug_renderer_info");
    return { renderer: extension ? String(gl!.getParameter(extension.UNMASKED_RENDERER_WEBGL)) : null,
      world: { ...(document.querySelector<HTMLElement>(".world-scene")?.dataset ?? {}) } };
  }).catch(() => ({ renderer: null, world: {} }));
  await writeFile(info.outputPath("runtime.json"), JSON.stringify(runtime, null, 2));
});

type HomeSample = { at: number; identityY: number | null; selectorY: number | null; stageOpacity: number | null;
  titleOpacity: number | null; statusOpacity: number | null; cancelOpacity: number | null; cancelDisabled: boolean | null };

async function prepareHome(page: Page, effects: "full" | "lite" = "full", reduced = false) {
  if (reduced) await page.emulateMedia({ reducedMotion: "reduce" });
  await installLauncherFixture(page, { effects, instanceCount: 2, launchDelay: 3000 });
  await page.goto("/");
  await expect(page.locator(".vx-home")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-world-intro", "off");
  await expect(page.locator(".vx-home__identity")).toHaveCSS("opacity", "1");
}

async function sampleHomeClick(page: Page, trigger: string, duration = 750): Promise<HomeSample[]> {
  await page.evaluate(({ trigger, duration }) => {
    const host = window as unknown as { __reviewHomeTrace: Promise<HomeSample[]> };
    host.__reviewHomeTrace = new Promise(resolve => {
      const rows: HomeSample[] = [];
      const sample = (start: number) => {
        const identity = document.querySelector(".vx-home__identity");
        const selector = document.querySelector(".vx-launch-console__context");
        const stage = document.querySelector('[data-page-stage="home"]');
        const title = identity?.querySelector("h1");
        const status = document.querySelector(".vx-launch-console__status");
        const cancel = [...document.querySelectorAll<HTMLButtonElement>(".vx-launch-console__launch-wrap button")].find(button => button.textContent?.includes("取消准备"));
        rows.push({ at: performance.now() - start, identityY: identity?.getBoundingClientRect().y ?? null,
          selectorY: selector?.getBoundingClientRect().y ?? null, stageOpacity: stage ? Number(getComputedStyle(stage).opacity) : null,
          titleOpacity: title ? Number(getComputedStyle(title).opacity) : null, statusOpacity: status ? Number(getComputedStyle(status).opacity) : null,
          cancelOpacity: cancel ? Number(getComputedStyle(cancel).opacity) : null, cancelDisabled: cancel?.disabled ?? null });
      };
      const clicked = (event: Event) => {
        if (!(event.target instanceof Element) || !event.target.closest(trigger)) return;
        document.removeEventListener("click", clicked, true);
        const start = performance.now(); sample(start);
        const frame = () => { sample(start); if (performance.now() - start < duration) requestAnimationFrame(frame); else resolve(rows); };
        requestAnimationFrame(frame);
      };
      document.addEventListener("click", clicked, true);
    });
  }, { trigger, duration });
  await page.locator(trigger).click();
  return page.evaluate(() => (window as unknown as { __reviewHomeTrace: Promise<HomeSample[]> }).__reviewHomeTrace);
}

test("review B: launch title and selector move together while status and cancel appear smoothly", async ({ page }, info) => {
  await prepareHome(page);
  const rows = await sampleHomeClick(page, "button[data-launch-primary]");
  await writeFile(info.outputPath("launch-motion.json"), JSON.stringify(rows, null, 2));
  const first = rows[0], last = rows.at(-1)!;
  expect(Math.abs(last.identityY! - first.identityY!)).toBeGreaterThan(50);
  const lower = Math.min(first.identityY!, last.identityY!), upper = Math.max(first.identityY!, last.identityY!);
  expect.soft(rows.some(row => row.identityY! > lower + 1 && row.identityY! < upper - 1), "title must have actual intermediate positions").toBe(true);
  const drift = rows.filter(row => row.identityY !== null && row.selectorY !== null)
    .map(row => Math.abs((row.identityY! - first.identityY!) - (row.selectorY! - first.selectorY!)));
  expect.soft(Math.max(...drift), "title and selector must share their layout movement").toBeLessThan(2);
  expect.soft(rows.some(row => row.statusOpacity !== null && row.statusOpacity > .01 && row.statusOpacity < .99), "status has an opacity intermediate").toBe(true);
  expect(rows.some(row => row.cancelDisabled === true)).toBe(true);
  expect(rows.some(row => row.cancelDisabled === false)).toBe(true);
  expect.soft(rows.some(row => row.cancelDisabled === false && row.cancelOpacity! > .56 && row.cancelOpacity! < .99), "enabling cancel fades its own opacity").toBe(true);
  await page.screenshot({ path: info.outputPath("launch-preparing.png") });
});

test("review B: returning home keeps glass ancestors opaque and reveals non-glass text", async ({ page }, info) => {
  await prepareHome(page);
  await page.locator('.vx-floating-nav [data-page="library"]').click();
  await expect(page.locator('[data-page-stage="library"]')).toHaveCSS("opacity", "1");
  const rows = await sampleHomeClick(page, '.vx-floating-nav [data-page="home"]');
  await writeFile(info.outputPath("home-return.json"), JSON.stringify(rows, null, 2));
  const visible = rows.filter(row => row.stageOpacity !== null);
  expect(visible.length).toBeGreaterThan(5);
  expect.soft(visible.every(row => row.stageOpacity === 1), "home stage must never form a fading backdrop root").toBe(true);
  expect.soft(visible.some(row => row.titleOpacity !== null && row.titleOpacity > .01 && row.titleOpacity < .99), "return reveal belongs to text").toBe(true);
});

test("review B: a returned-home picker hides the title and restores it on every close path", async ({ page }, info) => {
  await prepareHome(page);
  await page.locator('.vx-floating-nav [data-page="library"]').click();
  await expect(page.locator('[data-page-stage="library"]')).toHaveCSS("opacity", "1");
  await page.locator('.vx-floating-nav [data-page="home"]').click();
  const identity = page.locator(".vx-home__identity"), picker = page.locator("#home-instance");
  await expect(identity).toHaveCSS("opacity", "1");
  for (const close of ["escape", "outside", "select"] as const) {
    await picker.click();
    await expect(page.getByRole("listbox", { name: "当前实例", exact: true })).toBeVisible();
    await expect.soft(identity).toHaveCSS("opacity", "0");
    const title = await identity.boundingBox(), surface = await page.locator(".vx-instance-picker__popover .vx-listbox-surface").boundingBox();
    expect.soft(surface!.x, "menu covers the left edge of the title").toBeLessThanOrEqual(title!.x + .1);
    if (close === "escape") { await page.screenshot({ path: info.outputPath("picker-returned-home.png") }); await picker.press("Escape"); }
    else if (close === "outside") await page.mouse.click(1100, 180);
    else await page.locator('.vx-instance-picker__popover [role="option"]').nth(1).click();
    await expect(picker).toHaveAttribute("aria-expanded", "false");
    await expect(identity).toHaveCSS("opacity", "1");
  }
});

test("review B: home metadata contains supplemental Java information without repeating the picker", async ({ page }) => {
  await prepareHome(page);
  const metadata = page.locator(".vx-home__meta");
  await expect(metadata).toContainText("Java 21");
  await expect(metadata).not.toContainText("1.21.1");
  await expect(metadata).not.toContainText("原版");
  await expect(page.getByRole("heading", { name: "合成测试世界", exact: true })).toBeVisible();
});

for (const mode of ["lite", "reduced"] as const) test(`review B: ${mode} keeps cancel guarding without an opacity animation`, async ({ page }, info) => {
  await prepareHome(page, mode === "lite" ? "lite" : "full", mode === "reduced");
  const rows = await sampleHomeClick(page, "button[data-launch-primary]", 550);
  await writeFile(info.outputPath("static-cancel.json"), JSON.stringify(rows, null, 2));
  expect(rows.some(row => row.cancelDisabled === true)).toBe(true);
  expect(rows.some(row => row.cancelDisabled === false)).toBe(true);
  expect(rows.filter(row => row.cancelDisabled === false).every(row => row.cancelOpacity === 1)).toBe(true);
});
