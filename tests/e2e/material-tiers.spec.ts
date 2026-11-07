// SPDX-License-Identifier: GPL-3.0-only
import { chromium, expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { installLauncherFixture } from "./fixtures";

const nativeTest = test.extend({
  context: async ({ baseURL }, use) => {
    const browser = await chromium.launch({ channel: "chromium", args: ["--use-angle=d3d11"] });
    const context = await browser.newContext({ baseURL, deviceScaleFactor: 1, viewport: { width: 1440, height: 930 } });
    try { await use(context); } finally { await context.close(); await browser.close(); }
  },
});

type Theme = "dark" | "light";
type Effects = "full" | "lite";
const pageIds = ["home", "library", "discover", "multiplayer", "downloads", "accounts", "settings"] as const;
const glassOwners = [
  ".vx-floating-nav__indicator",
  ".vx-launch-console__selector",
  ".vx-home-animation-selector .vx-select__surface",
  ".vx-listbox-popover > .vx-listbox-surface",
  ".vx-detail-manage__popover > .vx-detail-manage__menu",
];

nativeTest.afterEach(async ({ page }, info) => {
  const runtime = await page.evaluate(() => {
    const world = document.querySelector<HTMLElement>(".world-scene");
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2")!;
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : null;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return { renderer, dpr: devicePixelRatio, viewport: { width: innerWidth, height: innerHeight },
      theme: document.documentElement.dataset.theme, effects: document.documentElement.dataset.effects,
      world: { ...world?.dataset } };
  });
  await writeFile(info.outputPath("runtime.json"), JSON.stringify(runtime, null, 2));
  expect(runtime.renderer).toMatch(/Direct3D11|D3D11/);
  expect(runtime.renderer).not.toMatch(/swiftshader|llvmpipe|software|basic render/i);
  expect(runtime.dpr).toBe(1);
});

async function prepare(page: Page, theme: Theme, effects: Effects) {
  await installLauncherFixture(page, { theme, effects, instanceCount: 2 });
  await page.route("https://api.modrinth.com/v2/search?**", route => route.fulfill({
    contentType: "application/json", body: JSON.stringify({ hits: [] }),
  }));
  // Exercise the real LauncherNoticeBridge and ToastProvider through a failed
  // command. The fixture changes only the backend result of this user action.
  await page.addInitScript(() => {
    const host = window as unknown as {
      __TAURI_INTERNALS__: { invoke(name: string, args?: Record<string, unknown>): Promise<unknown> };
    };
    const previous = host.__TAURI_INTERNALS__.invoke;
    host.__TAURI_INTERNALS__.invoke = (name, args) => name === "open_folder"
      ? Promise.reject(new Error("Synthetic material notification")) : previous(name, args);
  });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await expect(page.locator("html")).toHaveAttribute("data-effects", effects);
  await expect(page.locator("html")).toHaveAttribute("data-world-intro", "off");
  await expect(page.locator(".vx-glass-provider")).toHaveAttribute("data-glass-mode", effects);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

async function navigate(page: Page, id: typeof pageIds[number]) {
  await page.locator(`.vx-floating-nav [data-page="${id}"]`).click();
  await expect(page.locator(`[data-page-stage="${id}"]`)).toHaveCSS("opacity", "1");
}

async function materialMatrix(page: Page) {
  return page.evaluate(glassOwners => {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    const colors = new Map<string, number[]>();
    const rgba = (color: string) => {
      const known = colors.get(color); if (known) return known;
      context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1);
      const value = [...context.getImageData(0, 0, 1, 1).data]; colors.set(color, value); return value;
    };
    const selector = (element: Element) => `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}.${[...element.classList].join(".")}`;
    const rootSelector = '[data-page-stage],dialog[open],.vx-toast-host,.vx-listbox-popover,.vx-detail-manage__popover';
    const rows: { selector: string; root: string | null; background: string; rgba: number[]; opacity: number; effectiveOpacity: number;
      backdrop: string; webkitBackdrop: string; glass: boolean; owner: string | null; opaqueAncestor: string | null }[] = [];
    const glassSurfaces: { selector: string; owner: string | null; background: string; rgba: number[];
      opacity: number; effectiveOpacity: number; backdrop: string; refraction: string | null }[] = [];
    const violations: { kind: string; selector: string; value?: string | number[] }[] = [];
    for (const element of document.querySelectorAll<HTMLElement>("*")) {
      const bounds = element.getBoundingClientRect();
      if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true }) || element.closest("[inert]")
        || bounds.width <= 0 || bounds.height <= 0 || bounds.bottom <= 0 || bounds.top >= innerHeight
        || bounds.right <= 0 || bounds.left >= innerWidth || element.closest(".vx-window-chrome,canvas,svg,img")) continue;
      const css = getComputedStyle(element), label = selector(element);
      const glass = element.classList.contains("vx-glass-surface");
      const owner = glassOwners.find(owner => element.closest(owner));
      let effectiveOpacity = 1;
      for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) effectiveOpacity *= Number(getComputedStyle(ancestor).opacity);
      if (glass) {
        const directOwner = glassOwners.find(owner => element.matches(owner));
        if (!directOwner) violations.push({ kind: "unlisted-glass-owner", selector: label });
        glassSurfaces.push({ selector: label, owner: directOwner ?? null, background: css.backgroundColor,
          rgba: rgba(css.backgroundColor), opacity: Number(css.opacity), effectiveOpacity,
          backdrop: css.backdropFilter, refraction: element.getAttribute("data-glass-refraction") });
      }
      if (owner) continue;
      const backdrop = css.backdropFilter, webkitBackdrop = css.getPropertyValue("-webkit-backdrop-filter");
      if (backdrop !== "none" || (webkitBackdrop && webkitBackdrop !== "none"))
        violations.push({ kind: "content-backdrop-filter", selector: label, value: backdrop });
      for (const pseudo of ["::before", "::after"]) {
        const style = getComputedStyle(element, pseudo);
        if (style.content !== "none" && style.display !== "none" && style.backdropFilter !== "none")
          violations.push({ kind: "content-pseudo-backdrop-filter", selector: `${label}${pseudo}`, value: style.backdropFilter });
      }
      const root = element.closest(rootSelector), background = css.backgroundColor, color = rgba(background);
      let opaqueAncestor: Element | null = null;
      if (root && element !== root) for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (rgba(style.backgroundColor)[3] === 255 && Number(style.opacity) === 1) { opaqueAncestor = ancestor; break; }
        if (ancestor === root) break;
      }
      if (root && color[3] / 255 > .12 && color[3] < 255 && !opaqueAncestor)
        violations.push({ kind: "unbacked-translucent-fill", selector: label, value: color });
      if (root || glass || backdrop !== "none") rows.push({ selector: label, root: root ? selector(root) : null,
        background, rgba: color, opacity: Number(css.opacity), effectiveOpacity, backdrop, webkitBackdrop, glass, owner: owner ?? null,
        opaqueAncestor: opaqueAncestor ? selector(opaqueAncestor) : null });
    }
    const tokens = ["--surface-panel", "--surface-card", "--surface-solid", "--selection-fill", "--bg-raised"].map(token => {
      const probe = document.createElement("span"); probe.style.color = `var(${token})`; probe.style.display = "none";
      document.body.append(probe); const color = getComputedStyle(probe).color; probe.remove();
      return { token, color, rgba: rgba(color) };
    });
    return { theme: document.documentElement.dataset.theme, effects: document.documentElement.dataset.effects,
      rows, glassSurfaces, tokens, violations };
  }, glassOwners);
}

async function sample(page: Page, info: TestInfo, name: string) {
  await page.mouse.move(1435, 100);
  const matrix = await materialMatrix(page);
  await writeFile(info.outputPath(`${name}-materials.json`), JSON.stringify(matrix, null, 2));
  expect.soft(matrix.violations, `${name}: material ownership, backdrop and backed alpha`).toEqual([]);
  for (const token of matrix.tokens) expect.soft(token.rgba[3], `${name}/${token.token}: opaque resolved content token`).toBe(255);
  return matrix;
}

async function launchMaterial(page: Page) {
  return page.locator(".vx-launch-console__launch").evaluate(element => {
    const css = getComputedStyle(element);
    const probe = document.createElement("span"); probe.style.color = "var(--accent)"; probe.style.display = "none";
    element.append(probe); const accent = getComputedStyle(probe).color; probe.remove();
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!;
    const rgba = (color: string) => { context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data]; };
    return { classes: element.className, glass: element.classList.contains("vx-glass-surface"),
      lensOwner: Boolean(element.closest('[data-visual-owner="lens"]')), background: css.backgroundColor,
      rgba: rgba(css.backgroundColor), accent, accentRgba: rgba(accent), backdrop: css.backdropFilter };
  });
}

function assertLaunchMaterial(material: Awaited<ReturnType<typeof launchMaterial>>) {
  expect(material.glass).toBe(false);
  expect(material.lensOwner).toBe(false);
  expect(material.rgba).toEqual(material.accentRgba);
  expect(material.rgba[3]).toBe(255);
  expect(material.backdrop).toBe("none");
}

async function assertPopupMaterial(popup: Locator, effects: Effects) {
  await expect(popup).toBeVisible();
  await expect(popup).toHaveCSS("opacity", "1");
  await expect(popup).toHaveClass(/\bvx-glass-surface\b/);
  await expect(popup).toHaveAttribute("data-glass-refraction", effects === "full" ? "curvature" : "none");
  return popup.evaluate(element => {
    const css = getComputedStyle(element);
    let effectiveOpacity = 1;
    for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) effectiveOpacity *= Number(getComputedStyle(ancestor).opacity);
    return { classes: element.className, refraction: element.getAttribute("data-glass-refraction"),
      background: css.backgroundColor, backdrop: css.backdropFilter, effectiveOpacity,
      stageAncestor: element.closest("[data-page-stage]")?.getAttribute("data-page-stage") ?? null,
      parentClasses: element.parentElement?.className };
  });
}

for (const theme of ["dark", "light"] as const) for (const effects of ["full", "lite"] as const) {
  nativeTest(`R3-2 ${theme}/${effects}: seven pages and floating states keep their material tiers`, async ({ page }, info) => {
    nativeTest.setTimeout(180000);
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await prepare(page, theme, effects);
    const states = [];
    const launch = await launchMaterial(page); assertLaunchMaterial(launch);
    for (const id of pageIds) {
      if (id !== "home") await navigate(page, id);
      states.push({ state: id, matrix: await sample(page, info, id) });
      if (["home", "library"].includes(id)) await page.screenshot({ path: info.outputPath(`${id}.png`), scale: "css" });
    }

    await navigate(page, "home");
    await page.locator("#home-instance").click();
    const picker = page.locator(".vx-instance-picker__popover > .vx-listbox-surface");
    const homePopup = await assertPopupMaterial(picker, effects);
    states.push({ state: "home-picker", matrix: await sample(page, info, "home-picker") });
    await page.keyboard.press("Escape");
    await expect(picker).toHaveCount(0);

    await navigate(page, "settings");
    await page.locator(".vx-settings-nav").getByRole("button", { name: "下载", exact: true }).click();
    await expect(page.locator(".vx-settings-content")).toHaveCSS("opacity", "1");
    const settingsTrigger = page.locator(".vx-settings-content .vx-select").first();
    await expect(settingsTrigger.locator(".vx-select__surface")).not.toHaveClass(/\bvx-glass-surface\b/);
    await settingsTrigger.locator(".vx-select__button").click();
    const settingsMenu = page.locator(".vx-listbox-popover > .vx-listbox-surface");
    const settingsPopup = await assertPopupMaterial(settingsMenu, effects);
    states.push({ state: "settings-popup", matrix: await sample(page, info, "settings-popup") });
    await page.screenshot({ path: info.outputPath("settings-popup.png"), scale: "css" });
    await page.keyboard.press("Escape");
    await expect(settingsMenu).toHaveCount(0);

    await navigate(page, "library");
    await page.locator(".vx-library-commandbar__actions .vx-button--primary").click();
    const dialog = page.locator(".vx-create-dialog[open]");
    await expect(dialog).toHaveCSS("opacity", "1");
    const dialogTrigger = dialog.locator(".vx-select").first();
    await expect(dialogTrigger.locator(".vx-select__surface")).not.toHaveClass(/\bvx-glass-surface\b/);
    await dialogTrigger.locator(".vx-select__button").click();
    const dialogMenu = dialog.locator(".vx-listbox-popover > .vx-listbox-surface");
    const createPopup = await assertPopupMaterial(dialogMenu, effects);
    states.push({ state: "create-dialog-popup", matrix: await sample(page, info, "create-dialog-popup") });
    if (effects === "lite") expect(await dialog.evaluate(element => getComputedStyle(element, "::backdrop").backdropFilter)).toBe("none");
    await page.keyboard.press("Escape");
    await expect(dialogMenu).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    await page.locator('.vx-instance-card[data-instance-id="fixture-world"] .vx-instance-card__select').click();
    await expect(page.locator(".vx-detail-workspace")).toHaveCSS("opacity", "1");
    await page.locator(".vx-detail-manage > summary").click();
    const manageMenu = page.locator(".vx-detail-manage__popover > .vx-detail-manage__menu");
    const managePopup = await assertPopupMaterial(manageMenu, effects);
    expect(managePopup.stageAncestor, "management glass is portalled beyond the page Backdrop Root").toBeNull();
    expect(managePopup.effectiveOpacity).toBe(1);
    states.push({ state: "manage-menu", matrix: await sample(page, info, "manage-menu") });
    await page.keyboard.press("Escape");
    await expect(manageMenu).toHaveCount(0);

    await navigate(page, "home");
    await page.locator(".vx-launch-console__instance > .vx-button--icon").click();
    const toast = page.locator(".vx-toast-host .vx-toast");
    await expect(toast).toHaveCSS("opacity", "1");
    states.push({ state: "toast", matrix: await sample(page, info, "toast") });
    const toastMaterial = await toast.evaluate(element => ({ background: getComputedStyle(element).backgroundColor,
      backdrop: getComputedStyle(element).backdropFilter, glass: element.classList.contains("vx-glass-surface") }));
    expect(toastMaterial.glass).toBe(false); expect(toastMaterial.backdrop).toBe("none");
    await writeFile(info.outputPath("material-matrix.json"), JSON.stringify({ theme, effects, launch,
      popups: { homePopup, settingsPopup, createPopup, managePopup }, toastMaterial, states, errors }, null, 2));
    expect(errors).toEqual([]);
  });
}

for (const theme of ["dark", "light"] as const) for (const mode of ["lite", "reduced-transparency", "contrast-more", "forced-colors"] as const) {
  nativeTest(`R3-2 ${theme}/${mode}: dialog scrims remove blur in degraded material modes`, async ({ page }, info) => {
    nativeTest.setTimeout(90000);
    await page.emulateMedia({ reducedMotion: "no-preference", contrast: mode === "contrast-more" ? "more" : "no-preference",
      forcedColors: mode === "forced-colors" ? "active" : "none" });
    const media = mode === "reduced-transparency" ? await page.context().newCDPSession(page) : null;
    try {
      if (media) await media.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: "reduce" }] });
      await installLauncherFixture(page, { theme, effects: mode === "lite" ? "lite" : "full", instanceCount: 2 });
      await page.goto("/");
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.locator("html")).toHaveAttribute("data-reduced-transparency", String(mode === "reduced-transparency"));
      await expect(page.locator("html")).toHaveAttribute("data-high-contrast", String(mode === "contrast-more" || mode === "forced-colors"));
      const launch = mode === "reduced-transparency" ? await launchMaterial(page) : null;
      if (launch) {
        expect(await page.evaluate(() => matchMedia("(prefers-reduced-transparency: reduce)").matches)).toBe(true);
        assertLaunchMaterial(launch);
      }
      await navigate(page, "library");
      await page.locator(".vx-library-commandbar__actions .vx-button--primary").click();
      const dialog = page.locator(".vx-create-dialog[open]");
      await expect(dialog).toHaveCSS("opacity", "1");
      const backdrop = await dialog.evaluate(element => {
        const css = getComputedStyle(element, "::backdrop");
        return { background: css.backgroundColor, backdrop: css.backdropFilter,
          webkitBackdrop: css.getPropertyValue("-webkit-backdrop-filter") };
      });
      await writeFile(info.outputPath("degraded-material.json"), JSON.stringify({ theme, mode, launch, backdrop }, null, 2));
      expect(backdrop.backdrop).toBe("none");
      expect(["", "none"]).toContain(backdrop.webkitBackdrop);
    } finally { await media?.detach(); }
  });
}
