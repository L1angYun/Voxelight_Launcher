import { expect, test, type Page, type Locator } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { installLauncherFixture } from "./fixtures";

test.use({ channel: "chromium", viewport: { width: 1280, height: 930 },
  launchOptions: { args: ["--use-angle=d3d11"], ignoreDefaultArgs: ["--enable-unsafe-swiftshader"] } });

async function tabTo(page: Page, target: Locator) {
  for (let index = 0; index < 55; index++) {
    await page.keyboard.press("Tab");
    if (await target.evaluate(node => node === document.activeElement)) return;
  }
  await expect(target).toBeFocused();
}
async function start(page: Page, mode: "full" | "reduced" | "forced" | "lite") {
  if (mode === "reduced") await page.emulateMedia({ reducedMotion: "reduce" });
  if (mode === "forced") await page.emulateMedia({ forcedColors: "active" });
  await installLauncherFixture(page, { theme: "light", effects: mode === "lite" ? "lite" : "full", instanceCount: 2 });
  await page.addInitScript(() => {
    const host = window as unknown as { __TAURI_INTERNALS__: { invoke(name: string, args?: Record<string, unknown>): Promise<unknown> } };
    const previous = host.__TAURI_INTERNALS__.invoke;
    host.__TAURI_INTERNALS__.invoke = (name, args) => name === "list_loader_versions"
      ? Promise.resolve([{ id: "0.16.9", stable: true, recommended: true }]) : previous(name, args);
  });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-world-intro", "off");
  await page.locator('.vx-floating-nav [data-page="library"]').click();
  await expect(page.locator('[data-page-stage="library"]')).toHaveCSS("opacity", "1");
}

for (const mode of ["full", "lite", "reduced"] as const) test(`create ${mode}: collapsed loader has one field gap and expanded focus is not clipped`, async ({ page }, info) => {
  await start(page, mode);
  await page.locator(".vx-library-commandbar__actions").getByRole("button", { name: "创建实例", exact: true }).click();
  const dialog = page.locator(".vx-create-dialog[open]");
  await expect(dialog).toHaveCSS("opacity", "1");
  const readGap = () => dialog.evaluate(root => {
    const track = root.querySelector('.vx-field:has(button[aria-pressed]) .vx-selection')!;
    const label = root.querySelector('label[for$="-create-instance-name"]')!;
    return label.getBoundingClientRect().top - track.getBoundingClientRect().bottom;
  });
  const collapsedGap = await readGap();
  await page.screenshot({ path: info.outputPath("create-collapsed.png") });
  await dialog.getByRole("button", { name: "Fabric", exact: true }).click();
  const target = dialog.locator('[id$="-create-loader-version"]');
  await expect(target).toBeEnabled();
  await tabTo(page, target);
  await expect(target).toBeFocused();
  await expect.poll(() => dialog.locator(".vx-create-loader-slot").evaluate(node => node.getAnimations().length)).toBe(0);
  const focus = await target.evaluate(node => {
    const owner = node.closest(".vx-select")!, clip = node.closest(".vx-create-loader-slot__content")!;
    const bounds = owner.getBoundingClientRect(), clipBounds = clip.getBoundingClientRect(), style = getComputedStyle(owner);
    const ring = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
    const clippingAncestors = [];
    for (let parent = owner.parentElement; parent; parent = parent.parentElement) {
      const css = getComputedStyle(parent), rect = parent.getBoundingClientRect();
      const clearance = [];
      if (["hidden", "auto", "scroll", "clip"].includes(css.overflowX)) clearance.push(bounds.left - rect.left, rect.right - bounds.right);
      if (["hidden", "auto", "scroll", "clip"].includes(css.overflowY)) clearance.push(bounds.top - rect.top, rect.bottom - bounds.bottom);
      if (clearance.length) clippingAncestors.push({ className: parent.className, clearance });
    }
    return { width: style.outlineWidth, style: style.outlineStyle, ring,
      clippingAncestors,
      clearance: [bounds.left - clipBounds.left, clipBounds.right - bounds.right, bounds.top - clipBounds.top, clipBounds.bottom - bounds.bottom] };
  });
  await page.screenshot({ path: info.outputPath("create-loader-keyboard-focus.png") });
  await writeFile(info.outputPath("field-focus.json"), JSON.stringify({ mode, collapsedGap, focus }, null, 2));
  expect.soft(collapsedGap).toBeGreaterThanOrEqual(18);
  expect.soft(collapsedGap).toBeLessThanOrEqual(22);
  expect.soft(focus.style).toBe("solid");
  expect.soft(focus.width).toBe("2px");
  for (const clearance of focus.clearance) expect.soft(clearance).toBeGreaterThanOrEqual(focus.ring);
  for (const ancestor of focus.clippingAncestors) for (const clearance of ancestor.clearance)
    expect.soft(clearance, `Focus ring clipped by ${ancestor.className}`).toBeGreaterThanOrEqual(focus.ring);
});

for (const mode of ["reduced", "forced"] as const) test(`search ${mode}: library and discover expose matching keyboard focus rings`, async ({ page }, info) => {
  await start(page, mode);
  const results = [];
  for (const name of ["library", "discover"]) {
    if (name === "discover") {
      await page.locator('.vx-floating-nav [data-page="discover"]').click();
      await expect(page.locator('[data-page-stage="discover"]')).toHaveCSS("opacity", "1");
    }
    const container = page.locator(name === "library" ? ".vx-library-page .vx-search" : ".vx-discover-search");
    const input = container.locator("input");
    await tabTo(page, input);
    const style = await container.evaluate(node => { const css = getComputedStyle(node); return { outlineStyle: css.outlineStyle, outlineWidth: css.outlineWidth, outlineColor: css.outlineColor }; });
    results.push({ name, ...style });
    await page.screenshot({ path: info.outputPath(`${name}-search-focus.png`) });
    expect.soft(style.outlineStyle).toBe("solid"); expect.soft(style.outlineWidth).toBe("2px");
  }
  await writeFile(info.outputPath("search-focus.json"), JSON.stringify({ mode, results }, null, 2));
  expect(results[0].outlineColor).toBe(results[1].outlineColor);
});
