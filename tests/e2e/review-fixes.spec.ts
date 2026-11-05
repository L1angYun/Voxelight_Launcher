// SPDX-License-Identifier: GPL-3.0-only
import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { installLauncherFixture } from "./fixtures";
import { decodePng } from "./helpers/glass-pixel-probe.mjs";
import { captureGlassInterior, installGlassFrameFreeze } from "./helpers/glass-interior-probe";

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
          cancelOpacity: cancel ? Number(getComputedStyle(cancel).opacity) : null,
          cancelDisabled: cancel ? cancel.getAttribute("aria-disabled") === "true" : null });
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

test("S2 picker keeps the title covered until pointer exit ends and restores it immediately for keyboard closure", async ({ page }, info) => {
  await prepareHome(page);
  const picker = page.locator("#home-instance"), identity = page.locator(".vx-home__identity");
  const results = [];
  for (const mode of ["pointer", "Escape", "Tab", "Enter"] as const) {
    await picker.click();
    await expect(identity).toHaveCSS("opacity", "0");
    await expect(page.locator(".vx-instance-picker__popover .vx-listbox-surface")).toHaveCSS("opacity", "1");
    await page.evaluate(mode => {
      type Frame = { at: number; menuOpacity: number; identityOpacity: number; menuPresent: boolean };
      const host = window as unknown as { __pickerCloseFrames: Promise<Frame[]> };
      host.__pickerCloseFrames = new Promise(resolve => {
        document.addEventListener(mode === "pointer" ? "pointerdown" : "keydown", () => {
          const start = performance.now(), rows: Frame[] = [];
          const frame = () => {
            const menu = document.querySelector<HTMLElement>(".vx-instance-picker__popover .vx-listbox-surface");
            const title = document.querySelector<HTMLElement>(".vx-home__identity")!;
            rows.push({ at: performance.now() - start, menuOpacity: menu ? Number(getComputedStyle(menu).opacity) : 0,
              identityOpacity: Number(getComputedStyle(title).opacity), menuPresent: Boolean(menu) });
            if (performance.now() - start < 300) requestAnimationFrame(frame); else resolve(rows);
          };
          requestAnimationFrame(frame);
        }, { once: true, capture: true });
      });
    }, mode);
    if (mode === "pointer") await page.mouse.click(1100, 180);
    else await page.keyboard.press(mode);
    const rows = await page.evaluate(() => (window as unknown as { __pickerCloseFrames: Promise<{ at: number; menuOpacity: number; identityOpacity: number; menuPresent: boolean }[]> }).__pickerCloseFrames);
    results.push({ mode, rows });
    expect(rows.length).toBeGreaterThan(1);
    await page.screenshot({ path: info.outputPath(`picker-closed-${mode}.png`), scale: "css" });
    if (mode === "pointer") {
      expect.soft(rows.some(row => row.menuOpacity > .05 && row.menuOpacity < .95)).toBe(true);
      expect.soft(rows.filter(row => row.menuOpacity > .05).every(row => row.identityOpacity < .05)).toBe(true);
    } else expect.soft(rows.filter(row => row.menuOpacity <= .05).every(row => row.identityOpacity > .05), "keyboard close must not leave a blank presentation frame").toBe(true);
    await expect(identity).toHaveCSS("opacity", "1");
    if (mode === "Escape" || mode === "Enter") await expect(picker).toBeFocused();
    if (mode === "Tab") await expect(picker).not.toBeFocused();
  }
  await writeFile(info.outputPath("picker-exit-frames.json"), JSON.stringify(results, null, 2));
});

test("R2-10 light lens selector has a readable left boundary against its adjacent background", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 930 });
  await installLauncherFixture(page, { theme: "light" });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-world-intro", "off");
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const selector = page.locator(".vx-launch-console__selector");
  await expect(selector).toHaveAttribute("data-glass-refraction", "curvature");
  await page.mouse.move(1420, 910);
  const geometry = await selector.evaluate(element => {
    const matchedRules: { selector: string; shadow: string; groups: string[]; source: string | null }[] = [];
    for (const sheet of document.styleSheets) {
      const visit = (rules: CSSRuleList, groups: string[] = []) => {
        for (const rule of rules) {
          if (rule instanceof CSSStyleRule && rule.style.getPropertyValue("box-shadow") && element.matches(rule.selectorText))
            matchedRules.push({ selector: rule.selectorText, shadow: rule.style.getPropertyValue("box-shadow"), groups,
              source: (sheet.ownerNode as Element | null)?.getAttribute?.("data-vite-dev-id") ?? sheet.href });
          if ("cssRules" in rule) visit((rule as CSSGroupingRule).cssRules, [...groups, "name" in rule ? String(rule.name) : rule.cssText.split("{")[0]]);
        }
      };
      visit(sheet.cssRules);
    }
    const css = getComputedStyle(element);
    return { bounds: element.getBoundingClientRect().toJSON(), clip: (element as HTMLElement).style.clipPath,
      shadow: css.boxShadow, inline: element.getAttribute("style"), matchedRules,
      secondary: css.getPropertyValue("--text-secondary"), raised: css.getPropertyValue("--shadow-raised"),
      variant: element.getAttribute("data-glass-variant"), backdrop: css.backdropFilter,
      dispersion: Number(css.getPropertyValue("--vx-lens-dispersion")),
      refraction: Number(css.getPropertyValue("--vx-lens-refraction")),
      boundary: css.getPropertyValue("--vx-lens-boundary"),
      boundaryStrokeWidth: element.querySelector("[data-vx-boundary]")?.getAttribute("stroke-width") };
  });
  const image = decodePng(await page.screenshot({ path: info.outputPath("light-selector-boundary.png"), scale: "css" }));
  const pixel = (x: number, y: number) => {
    const offset = (y * image.width + x) * 4; return [...image.pixels.subarray(offset, offset + 3)];
  };
  const luminance = (rgb: number[]) => rgb.map(value => {
    const s = value / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4;
  }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  const contrast = (a: number[], b: number[]) => {
    const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
  };
  const r = geometry.bounds, radius = (r.height - 6) / 2, rows = [];
  // The current material silhouette has a 3px inset. Inspect the fixed middle
  // nine rows of its left arc, away from icons/text; retain every edge pixel.
  for (let dy = -4; dy <= 4; dy++) {
    const y = Math.round(r.y + r.height / 2 + dy);
    const edgeX = r.x + 3 + radius - Math.sqrt(radius ** 2 - dy ** 2);
    const background = { x: Math.floor(edgeX) - 3, y, rgb: pixel(Math.floor(edgeX) - 3, y) };
    const strip = [];
    for (let x = Math.floor(edgeX) - 1; x <= Math.ceil(edgeX) + 2; x++) {
      const rgb = pixel(x, y); strip.push({ x, y, rgb, contrast: contrast(rgb, background.rgb) });
    }
    rows.push({ dy, edgeX, background, strip, maximumContrast: Math.max(...strip.map(sample => sample.contrast)) });
  }
  await writeFile(info.outputPath("light-selector-boundary.json"), JSON.stringify({ geometry, rows }, null, 2));
  expect(geometry.variant).toBe("control");
  expect(geometry.backdrop).toMatch(/url\(/);
  expect(geometry.refraction).toBe(.9);
  expect(geometry.dispersion).toBe(.65);
  expect(geometry.boundaryStrokeWidth).toBe("2");
  for (const row of rows) expect.soft(row.maximumContrast, `left edge row ${row.dy}`).toBeGreaterThanOrEqual(2.5);
});

for (const theme of ["dark", "light"] as const) for (const section of ["home", "library"] as const) {
  test(`S4 ${theme} ${section}: actual lens interior stays clear with real refraction`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1440, height: 930 });
    await installGlassFrameFreeze(page);
    await installLauncherFixture(page, { theme, instanceCount: 2 });
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-world-intro", "off");
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    if (section === "library") await page.locator('.vx-floating-nav [data-page="library"]').click();
    await expect(page.locator(`[data-page-stage="${section}"]`)).toHaveCSS("opacity", "1");
    await page.mouse.move(1420, 910);
    await expect(page.locator(".vx-floating-nav")).toHaveAttribute("data-motion-settled", "true");
    await page.waitForTimeout(350);
    const result = await captureGlassInterior(page, info.outputPath("glass-interior"));
    expect(result.geometry.theme).toBe(theme);
    expect(result.measurements.interior4WithoutContent.fraction).toBeLessThan(.005);
    // The whole silhouette includes the intended curved edge and is record-only.
  });
}

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

test("review C: light selected sections remain visibly distinct without losing forced-color outlines", async ({ page }, info) => {
  await installLauncherFixture(page, { theme: "light" });
  await page.goto("/");
  await page.locator('.vx-floating-nav [data-page="settings"]').click();
  await expect(page.locator('[data-page-stage="settings"]')).toHaveCSS("opacity", "1");
  const buttons = page.locator(".vx-settings-nav button");
  await expect(buttons.first()).toHaveAttribute("aria-current", "page");
  await page.mouse.move(1100, 680);
  const selected = await buttons.first().boundingBox(), inactive = await buttons.nth(1).boundingBox();
  const image = decodePng(await page.screenshot({ path: info.outputPath("light-section-selection.png"), scale: "css" }));
  const median = (rect: NonNullable<typeof selected>) => {
    const values = [];
    for (let y = Math.floor(rect.y + rect.height / 2) - 4; y < Math.floor(rect.y + rect.height / 2) + 4; y++)
      for (let x = Math.floor(rect.x + rect.width) - 28; x < Math.floor(rect.x + rect.width) - 20; x++) {
        const at = (y * image.width + x) * 4;
        values.push((image.pixels[at] + image.pixels[at + 1] + image.pixels[at + 2]) / 3);
      }
    return values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  };
  const measured = { selected: median(selected!), inactive: median(inactive!) };
  await writeFile(info.outputPath("selection-contrast.json"), JSON.stringify(measured, null, 2));
  expect(Math.abs(measured.selected - measured.inactive)).toBeGreaterThanOrEqual(10);
  await page.emulateMedia({ forcedColors: "active" });
  await expect(page.locator(".vx-settings-nav .vx-selection__mark")).toHaveCSS("outline-style", "solid");
  await expect(page.locator(".vx-settings-nav .vx-selection__mark")).toHaveCSS("outline-width", "2px");
});

test("review C: the real cursor canvas fades over a lens and restores keyboard feedback", async ({ page }, info) => {
  await prepareHome(page);
  const nav = await page.locator('.vx-floating-nav [data-page="home"]').boundingBox();
  const x = nav!.x + nav!.width / 2, y = nav!.y + nav!.height / 2;
  await page.mouse.move(x, 110);
  await expect(page.locator(".vx-cursor-halo")).toHaveAttribute("data-halo-state", "pointer");
  await page.evaluate((x) => {
    const host = window as unknown as { __lensFade: Promise<{ at: number; alpha: number; state: string | undefined }[]> };
    host.__lensFade = new Promise(resolve => {
      document.addEventListener("pointermove", () => {
        const start = performance.now(), rows: { at: number; alpha: number; state: string | undefined }[] = [];
        const canvas = document.querySelector<HTMLCanvasElement>(".vx-cursor-halo")!, context = canvas.getContext("2d")!;
        const ratio = canvas.width / innerWidth;
        const sample = (now: number) => {
          const pixels = context.getImageData(Math.floor((x - 40) * ratio), 0, Math.ceil(80 * ratio), Math.ceil(180 * ratio)).data;
          let alpha = 0;
          for (let index = 3; index < pixels.length; index += 4) alpha = Math.max(alpha, pixels[index]);
          rows.push({ at: Math.max(0, now - start), alpha, state: canvas.dataset.haloState });
          if (now - start < 260) requestAnimationFrame(sample); else resolve(rows);
        };
        sample(start);
      }, { once: true, capture: true });
    });
  }, x);
  await page.mouse.move(x, y);
  const rows = await page.evaluate(() => (window as unknown as { __lensFade: Promise<{ at: number; alpha: number; state: string | undefined }[]> }).__lensFade);
  await writeFile(info.outputPath("lens-cursor-alpha.json"), JSON.stringify(rows, null, 2));
  expect(rows[0].alpha).toBeGreaterThan(200);
  expect(rows.some(row => row.alpha > 0 && row.alpha < 200)).toBe(true);
  const invisible = rows.find(row => row.alpha === 0 && row.state === "lens");
  expect(invisible).toBeTruthy();
  const largestGap = Math.max(...rows.slice(1).map((row, index) => row.at - rows[index].at));
  // This reader can run before the canvas writer in a RAF batch. Account for
  // that observation frame and the deadline's next actual presentation frame.
  expect(invisible!.at).toBeLessThanOrEqual(120 + 2 * largestGap + 1);
  expect(rows.at(-1)!.alpha).toBe(0);
  await page.keyboard.press("Tab");
  await expect(page.locator(".vx-cursor-halo")).toHaveAttribute("data-halo-state", "focus");
  await page.mouse.move(x, 110);
  await expect(page.locator(".vx-cursor-halo")).toHaveAttribute("data-halo-state", "pointer");
  await page.screenshot({ path: info.outputPath("cursor-after-lens.png") });
});

test("review D: detail identity gains a readable plate while card artwork stays unchanged", async ({ page }, info) => {
  await prepareHome(page);
  await page.locator('.vx-floating-nav [data-page="library"]').click();
  await expect(page.locator('[data-page-stage="library"]')).toHaveCSS("opacity", "1");
  await expect(page.locator(".vx-instance-card .vx-instance-identity__plane").first()).toHaveCSS("opacity", "0.35");
  await page.locator(".vx-instance-card__select").first().click();
  const identity = page.locator(".vx-detail-header .vx-instance-identity");
  await expect(identity).toBeVisible();
  await expect.soft(identity).toHaveCSS("background-color", "rgb(13, 15, 20)");
  await expect.soft(identity).toHaveCSS("border-top-width", "1px");
  await expect.soft(identity).toHaveCSS("border-radius", "6px");
  await expect.soft(identity.locator(".vx-instance-identity__plane")).toHaveCSS("opacity", "0.7");
  await page.screenshot({ path: info.outputPath("detail-identity-plate.png") });
});
