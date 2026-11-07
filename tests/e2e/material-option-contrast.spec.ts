// SPDX-License-Identifier: GPL-3.0-only
import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { installLauncherFixture } from "./fixtures";
import { decodePng } from "./helpers/glass-pixel-probe.mjs";
import { analyzeOptionContrast, type OptionRegion } from "./helpers/material-option-contrast";

test.use({ channel: "chromium", launchOptions: { args: ["--use-angle=d3d11"] },
  viewport: { width: 1440, height: 930 }, deviceScaleFactor: 1 });

for (const theme of ["dark", "light"] as const) {
  test(`R3-2 ${theme}: the solid launch action keeps its real jelly pressure transform`, async ({ page }, info) => {
    await installLauncherFixture(page, { theme, effects: "full" });
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-world-intro", "off");
    const wrap = page.locator(".vx-launch-console__launch-wrap");
    const surface = page.locator(".vx-launch-console__launch");
    await expect(surface).not.toHaveClass(/vx-glass-surface/);
    await expect(surface).toHaveCSS("backdrop-filter", "none");
    const button = page.locator("[data-launch-primary]");
    const bounds = (await button.boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    const initial = await wrap.evaluate(element => getComputedStyle(element).transform);
    await page.mouse.down();
    try {
      await expect.poll(() => wrap.evaluate(element => Number(element.style.getPropertyValue("--jelly-press")))).toBeGreaterThan(.1);
      await expect.poll(() => wrap.evaluate(element => getComputedStyle(element).transform)).not.toBe(initial);
      const pressed = await wrap.evaluate(element => ({ pressure: element.style.getPropertyValue("--jelly-press"),
        transform: getComputedStyle(element).transform }));
      const runtime = await page.evaluate(() => {
        const gl = document.querySelector<HTMLCanvasElement>(".world-scene canvas")!.getContext("webgl2")!;
        const debug = gl.getExtension("WEBGL_debug_renderer_info")!;
        return { renderer: String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)), dpr: devicePixelRatio };
      });
      expect(runtime.renderer).toMatch(/D3D11/);
      expect(runtime.renderer).not.toMatch(/swiftshader|software|llvmpipe/i);
      expect(runtime.dpr).toBe(1);
      await writeFile(info.outputPath("solid-launch-jelly.json"), JSON.stringify({ theme, initial, pressed, runtime }, null, 2));
    } finally {
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height + 30);
      await page.mouse.up();
    }
    await expect.poll(() => wrap.evaluate(element => Number(element.style.getPropertyValue("--jelly-press")))).toBeLessThan(.01);
  });
}

for (const theme of ["dark", "light"] as const) for (const effects of ["full", "lite"] as const) {
  for (const scenario of ["settings", "create", "manage"] as const) {
    test(`R3-2 option contrast ${theme}/${effects}/${scenario}: all actual background samples clear 4.5`, async ({ page }, info) => {
      await installLauncherFixture(page, { theme, effects, instanceCount: 2 });
      await page.addInitScript(() => {
        const host = window as unknown as { __TAURI_INTERNALS__: { invoke: (name: string, args?: unknown) => Promise<unknown> } };
        const original = host.__TAURI_INTERNALS__.invoke;
        host.__TAURI_INTERNALS__.invoke = (name, args) => name === "list_versions"
          ? Promise.resolve({ latestRelease: "1.21.1", latestSnapshot: "", versions: [
            { id: "1.21.1", type: "release", installed: true, launchable: true, javaMajor: 21 },
            { id: "1.20.1", type: "release", installed: false, launchable: false, javaMajor: 17 },
          ] }) : original(name, args);
      });
      await page.goto("/");
      await expect(page.locator("html")).toHaveAttribute("data-world-intro", "off");
      await page.evaluate(() => document.fonts.ready);
      if (scenario === "settings") {
        await page.locator('button[data-page="settings"]').click();
        await page.locator(".vx-settings-nav").getByRole("button", { name: "下载", exact: true }).click();
        await page.locator(".vx-settings-content").getByRole("combobox").first().click();
      } else {
        await page.locator('button[data-page="library"]').click();
        if (scenario === "create") {
          await page.locator(".vx-library-commandbar__actions").getByRole("button", { name: "创建实例", exact: true }).click();
          await page.locator('.vx-create-dialog [id$="-create-game-version"]').click();
        } else {
          await page.locator('.vx-instance-card[data-instance-id="fixture-world"] .vx-instance-card__select').click();
          await expect(page.locator(".vx-detail-workspace")).toHaveCSS("opacity", "1");
          await page.locator(".vx-detail-manage > summary").click();
        }
      }
      const selector = scenario === "manage" ? ".vx-detail-manage__menu" : '.vx-listbox-popover[data-present="true"] > .vx-listbox-surface';
      const surface = page.locator(selector);
      await expect(surface).toBeVisible();
      await expect(surface).toHaveClass(/vx-glass-surface/);
      await expect(surface).toHaveCSS("opacity", "1");
      await expect(surface).toHaveAttribute("data-glass-refraction", effects === "full" ? "curvature" : "none");
      await page.mouse.move(1436, 100);
      await page.waitForTimeout(150);
      const collect = () => surface.evaluate(element => {
          const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
          const context = canvas.getContext("2d")!;
          const bounds = element.getBoundingClientRect(), labels = [];
          for (const option of element.querySelectorAll<HTMLElement>('[role="option"],button')) {
            const box = option.getBoundingClientRect();
            const targets = option.querySelectorAll<HTMLElement>(".vx-select__value,.vx-select__metadata");
            for (const label of targets.length ? targets : [option]) {
              const rect = label.getBoundingClientRect();
              const clip = {
                left: Math.max(0, bounds.left, box.left, rect.left), right: Math.min(innerWidth, bounds.right, box.right, rect.right),
                top: Math.max(0, bounds.top, box.top), bottom: Math.min(innerHeight, bounds.bottom, box.bottom),
              };
              if (clip.right <= clip.left || clip.bottom <= clip.top || rect.bottom <= clip.top || rect.top >= clip.bottom) continue;
              let opacity = 1;
              for (let p: Element | null = label; p; p = p.parentElement) opacity *= Number(getComputedStyle(p).opacity);
              context.clearRect(0, 0, 1, 1); context.fillStyle = getComputedStyle(label).color; context.fillRect(0, 0, 1, 1);
              const range = document.createRange(); range.selectNodeContents(label);
              const boxes = [...range.getClientRects()].filter(r => r.width > 0 && r.height > 0)
                .map(r => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom }));
              labels.push({ text: label.textContent ?? "", rgba: [...context.getImageData(0, 0, 1, 1).data], opacity, boxes, clip });
            }
          }
          const gl = document.querySelector<HTMLCanvasElement>(".world-scene canvas")!.getContext("webgl2")!;
          const debug = gl.getExtension("WEBGL_debug_renderer_info");
          return { labels, renderer: debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : null,
            dpr: devicePixelRatio, theme: document.documentElement.dataset.theme, effects: document.documentElement.dataset.effects };
      });
      const frames = [];
      for (let frame = 0; frame < 3; frame++) {
        if (frame) await page.waitForTimeout(250);
        const measured = await collect();
        expect(measured.renderer).toMatch(/D3D11/);
        expect(measured.renderer).not.toMatch(/swiftshader|software|llvmpipe/i);
        expect(measured.dpr).toBe(1);
        expect(measured.theme).toBe(theme); expect(measured.effects).toBe(effects);
        expect(measured.labels.length).toBeGreaterThan(0);
        expect(measured.labels.every(label => label.opacity >= .999)).toBe(true);
        const path = info.outputPath(`normal-${frame}.png`);
        const image = decodePng(await page.screenshot({ path, scale: "css" }));
        expect((await collect()).labels, "text paint and geometry stay unchanged through the screenshot").toEqual(measured.labels);
        const labels = measured.labels.map(region => analyzeOptionContrast(image, region as OptionRegion));
        frames.push({ frame, path, ...measured, labels });
      }
      const minimum = Math.min(...frames.flatMap(frame => frame.labels.map(label => label.minimum)));
      await writeFile(info.outputPath("option-contrast.json"), JSON.stringify({
        method: "Normal D3D11 compositor PNG; full text Range widths, two integer rows above/below; clip only to real option/surface/viewport geometry. All samples retained; minimum, no RGB or contrast filtering. Foreground alpha and actual ancestor opacity included.",
        theme, effects, scenario, minimum, frames,
      }, null, 2));
      for (const frame of frames) for (const label of frame.labels)
        expect.soft(label.minimum, `${theme}/${effects}/${scenario}, ${label.text}: ${JSON.stringify(label.worst)}`).toBeGreaterThanOrEqual(4.5);
    });
  }
}
