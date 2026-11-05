// SPDX-License-Identifier: GPL-3.0-only
import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { installLauncherFixture } from "./fixtures";

test.use({ viewport: { width: 1280, height: 720 }, channel: "chromium",
  launchOptions: { args: ["--enable-automation", "--use-angle=d3d11"], ignoreDefaultArgs: ["--enable-unsafe-swiftshader"] } });

test.afterEach(async ({ page, browser }, info) => {
  const session = await browser.newBrowserCDPSession();
  const commandLine = await session.send("Browser.getBrowserCommandLine");
  await session.detach();
  const renderer = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(".world-scene__canvas");
    const gl = canvas?.getContext("webgl2");
    const extension = gl?.getExtension("WEBGL_debug_renderer_info");
    return extension ? String(gl!.getParameter(extension.UNMASKED_RENDERER_WEBGL)) : null;
  }).catch(() => null);
  await writeFile(info.outputPath("browser-runtime.json"), JSON.stringify({ renderer, version: browser.version(),
    channel: "chromium", actualArguments: commandLine.arguments }, null, 2));
});

async function prepareLibrary(page: Page, mode: "full" | "lite" | "reduced" = "full") {
  if (mode === "reduced") await page.emulateMedia({ reducedMotion: "reduce" });
  await installLauncherFixture(page, { effects: mode === "lite" ? "lite" : "full", instanceCount: 2 });
  await page.addInitScript(() => {
    const host = window as unknown as { __TAURI_INTERNALS__: { invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown> } };
    const original = host.__TAURI_INTERNALS__.invoke;
    host.__TAURI_INTERNALS__.invoke = async (name, args) => name === "list_loader_versions"
      ? [{ id: "0.16.9", stable: true, recommended: true }, { id: "0.16.8", stable: true, recommended: false }]
      : original(name, args);
  });
  await page.goto("/");
  await expect(page.locator(".vx-home")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-world-intro", "off");
  await page.locator('.vx-floating-nav [data-page="library"]').click();
  await expect(page.locator('[data-page-stage="library"]')).toHaveCSS("opacity", "1");
}

async function openCreate(page: Page) {
  await page.locator(".vx-library-commandbar__actions").getByRole("button", { name: "创建实例", exact: true }).click();
  const dialog = page.locator(".vx-create-dialog[open]");
  await expect(dialog).toHaveCSS("opacity", "1");
  return dialog;
}

type LoaderFrame = { at: number; height: number; dialogHeight: number; expanded: boolean; inert: boolean;
  disabled: boolean; transitionMs: number | null };

async function sampleLoaderClick(page: Page, name: "Fabric" | "原版") {
  await page.evaluate(() => {
    const host = window as unknown as { __loaderFrames: Promise<LoaderFrame[]> };
    host.__loaderFrames = new Promise(resolve => {
      document.addEventListener("click", () => {
        const start = performance.now(), rows: LoaderFrame[] = [];
        const sample = () => {
          const slot = document.querySelector<HTMLElement>(".vx-create-dialog[open] .vx-create-loader-slot")!;
          const choice = slot.querySelector<HTMLButtonElement>('[role="combobox"]')!;
          const animation = slot.getAnimations().find(item => item instanceof CSSTransition);
          const duration = animation?.effect?.getTiming().duration;
          rows.push({ at: performance.now() - start, height: slot.getBoundingClientRect().height,
            dialogHeight: slot.closest("dialog")!.getBoundingClientRect().height,
            expanded: slot.dataset.expanded === "true", inert: slot.inert, disabled: choice.disabled,
            transitionMs: typeof duration === "number" ? duration : null });
        };
        sample();
        const frame = () => { sample(); if (performance.now() - start < 330) requestAnimationFrame(frame); else resolve(rows); };
        requestAnimationFrame(frame);
      }, { once: true, capture: true });
    });
  });
  await page.locator(".vx-create-dialog[open]").getByRole("button", { name, exact: true }).click();
  return page.evaluate(() => (window as unknown as { __loaderFrames: Promise<LoaderFrame[]> }).__loaderFrames);
}

test("review D3: create tabs use the smaller natural minimum and loader height animates both ways", async ({ page }, info) => {
  await prepareLibrary(page);
  const dialog = await openCreate(page);
  const panel = dialog.locator(".vx-create-panel"), slot = dialog.locator(".vx-create-loader-slot");
  const choice = slot.locator('[role="combobox"]');
  await expect(panel).toHaveCSS("min-block-size", "197px");
  expect((await slot.boundingBox())!.height).toBe(0);
  await expect(choice).toBeDisabled();
  await expect(slot).toHaveAttribute("inert", "");
  await expect(slot).toHaveAttribute("aria-hidden", "true");
  const vanilla = await dialog.boundingBox();
  await page.screenshot({ path: info.outputPath("create-vanilla.png") });
  await dialog.getByRole("tab").nth(1).click();
  const imported = await dialog.boundingBox(), importPanel = await panel.boundingBox();
  expect(importPanel!.height).toBe(197);
  expect(imported!.height).toBeLessThan(vanilla!.height - 80);
  await page.screenshot({ path: info.outputPath("create-import.png") });
  await dialog.getByRole("tab").first().click();
  const expanding = await sampleLoaderClick(page, "Fabric");
  const expanded = await dialog.boundingBox(), expandedHeight = expanding.at(-1)!.height;
  expect(expandedHeight).toBeGreaterThan(60);
  expect(expanding.filter(row => row.height > 1 && row.height < expandedHeight - 1).length).toBeGreaterThan(1);
  expect(expanding.some(row => row.transitionMs === 180)).toBe(true);
  await expect(choice).toBeEnabled();
  await expect(choice).toContainText("0.16.9");
  await page.screenshot({ path: info.outputPath("create-fabric.png") });
  await choice.click();
  await expect(page.getByRole("listbox", { name: "加载器版本", exact: true })).toBeVisible();
  const collapsing = await sampleLoaderClick(page, "原版");
  await writeFile(info.outputPath("create-geometry.json"), JSON.stringify({ vanilla, imported, importPanel,
    expanded, expanding, collapsing }, null, 2));
  expect(collapsing[0].height).toBe(expandedHeight);
  expect(collapsing.at(-1)!.height).toBe(0);
  expect(collapsing.filter(row => row.height > 1 && row.height < expandedHeight - 1).length).toBeGreaterThan(1);
  expect(collapsing.some(row => row.transitionMs === 180)).toBe(true);
  expect(collapsing.filter(row => !row.expanded).every(row => row.disabled && row.inert)).toBe(true);
  await expect(choice).toContainText("0.16.9");
  await expect(choice).toBeDisabled();
  await expect(page.locator(".vx-listbox-popover:popover-open")).toHaveCount(0);
  await dialog.getByRole("button", { name: "NeoForge", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(dialog.locator('[id$="-create-instance-name"]')).toBeFocused();
  await choice.evaluate(element => (element as HTMLElement).focus());
  await expect(dialog.locator('[id$="-create-instance-name"]')).toBeFocused();
  await page.screenshot({ path: info.outputPath("create-collapsed.png") });

  await sampleLoaderClick(page, "Fabric");
  await choice.click();
  await expect(page.locator(".vx-listbox-popover:popover-open")).toHaveCount(1);
  // A native dialog cancel can arrive while its portalled menu is still open.
  await dialog.evaluate(element => element.dispatchEvent(new Event("cancel", { cancelable: true })));
  const closedChoice = page.locator('.vx-create-dialog [id$="-create-loader-version"]');
  await expect(closedChoice).toBeDisabled();
  await expect(page.locator(".vx-create-dialog .vx-create-loader-slot")).toHaveAttribute("inert", "");
  await expect(page.locator(".vx-listbox-popover:popover-open")).toHaveCount(0);
  await expect(page.locator(".vx-create-dialog:has(.vx-create-loader-slot)")).not.toBeVisible();
  await page.screenshot({ path: info.outputPath("create-closed-no-popup.png") });
});

for (const mode of ["lite", "reduced"] as const) test(`review D3: ${mode} changes loader height immediately`, async ({ page }, info) => {
  await prepareLibrary(page, mode);
  await openCreate(page);
  const expanding = await sampleLoaderClick(page, "Fabric");
  const collapsing = await sampleLoaderClick(page, "原版");
  await writeFile(info.outputPath("loader-immediate.json"), JSON.stringify({ expanding, collapsing }, null, 2));
  const expandedHeight = expanding.at(-1)!.height;
  expect(expandedHeight).toBeGreaterThan(60);
  expect(collapsing.at(-1)!.height).toBe(0);
  expect(expanding.filter(row => row.expanded).every(row => row.height === expandedHeight && row.transitionMs === null)).toBe(true);
  expect(collapsing.filter(row => !row.expanded).every(row => row.height === 0 && row.transitionMs === null && row.inert && row.disabled)).toBe(true);
  await page.screenshot({ path: info.outputPath(`create-${mode}-collapsed.png`) });
});

for (const width of [1280, 1050]) test(`library commandbar: 38px fields keep 12px corners and actions use pills at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 720 });
  await prepareLibrary(page);
  const measured = await page.locator(".vx-library-commandbar").evaluate(root => {
    const read = (element: Element) => { const bounds = element.getBoundingClientRect(), style = getComputedStyle(element);
      return { className: element.className, text: element.textContent, x: bounds.x, right: bounds.right,
        y: bounds.y, height: bounds.height, radius: style.borderRadius, padding: style.padding }; };
    return { controls: [...root.querySelectorAll(".vx-search, .vx-select__surface, .vx-select__button, .vx-library-view, .vx-button")].map(read),
      inner: [...root.querySelectorAll(".vx-library-view > button")].map(read) };
  });
  await writeFile(info.outputPath("toolbar-geometry.json"), JSON.stringify(measured, null, 2));
  expect(measured.controls).toHaveLength(6);
  for (const control of measured.controls) {
    expect(control.height, control.className).toBe(38);
    expect(control.radius, control.className).toBe(control.className.split(" ").includes("vx-button") ? "999px" : "12px");
    expect(control.x).toBeGreaterThanOrEqual(0);
    expect(control.right).toBeLessThanOrEqual(width);
  }
  expect(measured.controls.find(control => control.className.includes("vx-library-view"))!.padding).toBe("2px");
  expect(measured.inner).toHaveLength(2);
  expect(measured.inner.every(control => control.height === 32 && control.radius === "12px")).toBe(true);
  await page.screenshot({ path: info.outputPath(`library-toolbar-${width}.png`) });
});
