import { expect, test, type Page, type Locator } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { installLauncherFixture } from "./fixtures";

test.use({ channel: "chromium", viewport: { width: 1280, height: 930 },
  launchOptions: { args: ["--use-angle=d3d11"], ignoreDefaultArgs: ["--enable-unsafe-swiftshader"] } });

test.afterEach(async ({ page }, info) => {
  const runtime = await page.evaluate(() => {
    const world = document.querySelector<HTMLElement>(".world-scene");
    const gl = world?.querySelector("canvas")?.getContext("webgl2");
    const debug = gl?.getExtension("WEBGL_debug_renderer_info");
    return { renderer: debug ? String(gl!.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : null,
      dpr: devicePixelRatio, theme: document.documentElement.dataset.theme,
      effects: document.documentElement.dataset.effects, forcedColors: matchMedia("(forced-colors: active)").matches };
  });
  await writeFile(info.outputPath("browser-runtime.json"), JSON.stringify(runtime, null, 2));
  expect(runtime.renderer).toMatch(/Direct3D11|D3D11/);
  expect(runtime.renderer).not.toMatch(/swiftshader|llvmpipe|software|basic render/i);
  expect(runtime.dpr).toBe(1);
  expect(runtime.theme).toBe("light");
});

async function tabTo(page: Page, target: Locator) {
  for (let index = 0; index < 55; index++) {
    await page.keyboard.press("Tab");
    if (await target.evaluate(node => node === document.activeElement)) return;
  }
  await expect(target).toBeFocused();
}
async function start(page: Page, mode: "full" | "reduced" | "forced" | "lite", holdLoader = false) {
  if (mode === "reduced") await page.emulateMedia({ reducedMotion: "reduce" });
  if (mode === "forced") await page.emulateMedia({ forcedColors: "active" });
  await installLauncherFixture(page, { theme: "light", effects: mode === "lite" ? "lite" : "full", instanceCount: 2 });
  await page.addInitScript(holdLoader => {
    const host = window as unknown as { __TAURI_INTERNALS__: { invoke(name: string, args?: Record<string, unknown>): Promise<unknown> }; __releaseLoader?: () => void };
    let release = () => {};
    const pending = new Promise<void>(resolve => { release = resolve; });
    host.__releaseLoader = release;
    const previous = host.__TAURI_INTERNALS__.invoke;
    host.__TAURI_INTERNALS__.invoke = (name, args) => name === "list_loader_versions"
      ? (holdLoader ? pending : Promise.resolve()).then(() => [{ id: "0.16.9", stable: true, recommended: true }]) : previous(name, args);
  }, holdLoader);
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
  const expectedColor = await page.evaluate(mode => {
    const probe = document.createElement("span");
    probe.style.color = mode === "forced" ? "Highlight" : "var(--accent-indicator)";
    document.body.append(probe);
    try { return getComputedStyle(probe).color; } finally { probe.remove(); }
  }, mode);
  expect(expectedColor).not.toBe("");
  expect(expectedColor).not.toBe("rgba(0, 0, 0, 0)");
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
    expect.soft(style.outlineColor, `${name} must resolve the actual ${mode === "forced" ? "system Highlight" : "indicator"} color`).toBe(expectedColor);
  }
  let lattice = null;
  if (mode === "forced") {
    await page.locator('.vx-floating-nav [data-page="library"]').click();
    await expect(page.locator('[data-page-stage="library"]')).toHaveCSS("opacity", "1");
    const card = page.locator('.vx-instance-card[data-instance-id="fixture-world"]');
    await tabTo(page, card.locator(".vx-instance-card__select"));
    const frame = card.locator(":scope > .vx-lattice-frame");
    await expect(frame).toHaveAttribute("data-focused", "true");
    await expect(frame).toHaveAttribute("data-selected", "true");
    lattice = await frame.evaluate(element => ({ outlineColor: getComputedStyle(element).outlineColor,
      outlineStyle: getComputedStyle(element).outlineStyle, outlineWidth: getComputedStyle(element).outlineWidth,
      visible: (element as HTMLElement).checkVisibility({ opacityProperty: true, visibilityProperty: true }) }));
    expect.soft(lattice.visible).toBe(true);
    expect.soft(lattice.outlineStyle).toBe("solid");
    expect.soft(lattice.outlineWidth).toBe("2px");
    expect.soft(lattice.outlineColor).toBe(expectedColor);
    await page.screenshot({ path: info.outputPath("library-lattice-system-focus.png"), scale: "css" });
  }
  await writeFile(info.outputPath("search-focus.json"), JSON.stringify({ mode, expectedColor, results, lattice }, null, 2));
  expect(results[0].outlineColor).toBe(results[1].outlineColor);
});

test("M4 loading status keeps its twelve-pixel inset inside the loader Select", async ({ page }, info) => {
  await start(page, "full", true);
  await page.locator(".vx-library-commandbar__actions").getByRole("button", { name: "创建实例", exact: true }).click();
  const dialog = page.locator(".vx-create-dialog[open]");
  await expect(dialog).toHaveCSS("opacity", "1");
  await dialog.getByRole("button", { name: "Fabric", exact: true }).click();
  const status = dialog.locator(".vx-create-loader-status");
  await expect(status).toHaveText(/加载/);
  await expect(status).not.toHaveClass(/sr-only/);
  await expect.poll(() => dialog.locator(".vx-create-loader-slot").evaluate(node => node.getAnimations().length)).toBe(0);
  const geometry = await status.evaluate(node => {
    const select = node.parentElement!.querySelector(".vx-select")!;
    const label = node.parentElement!.querySelector("label")!;
    const bounds = node.getBoundingClientRect(), selectBounds = select.getBoundingClientRect();
    return { status: bounds.toJSON(), select: selectBounds.toJSON(), label: label.getBoundingClientRect().toJSON(),
      insetLeft: bounds.left - selectBounds.left, insetBottom: selectBounds.bottom - bounds.bottom };
  });
  await writeFile(info.outputPath("loader-status-inset.json"), JSON.stringify(geometry, null, 2));
  await page.screenshot({ path: info.outputPath("loader-status-pending.png"), scale: "css" });
  expect.soft(geometry.insetLeft).toBeCloseTo(12, 1);
  expect.soft(geometry.insetBottom).toBeCloseTo(12, 1);
  expect.soft(geometry.status.top).toBeGreaterThanOrEqual(geometry.label.bottom);
  await page.evaluate(() => (window as unknown as { __releaseLoader: () => void }).__releaseLoader());
  await expect(dialog.locator('[id$="-create-loader-version"]')).toBeEnabled();
  await expect(status).toHaveClass(/sr-only/);
});
