// SPDX-License-Identifier: GPL-3.0-only
import { chromium, expect, test, type Locator, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { installLauncherFixture } from "./fixtures";
import { captureReadingSurface, readLargeReadingFills } from "./helpers/reading-surface-probe";

const nativeTest = test.extend({
  context: async ({ baseURL }, use) => {
    const browser = await chromium.launch({ channel: "chromium", args: ["--use-angle=d3d11"] });
    const context = await browser.newContext({ baseURL, deviceScaleFactor: 1 });
    try { await use(context); } finally { await context.close(); await browser.close(); }
  },
});

nativeTest.afterEach(async ({ page }, info) => {
  const runtime = await page.evaluate(() => {
    const world = document.querySelector<HTMLElement>(".world-scene");
    const gl = world?.querySelector("canvas")?.getContext("webgl2");
    const debug = gl?.getExtension("WEBGL_debug_renderer_info");
    return { renderer: debug ? String(gl!.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : null,
      dpr: devicePixelRatio, viewport: { width: innerWidth, height: innerHeight },
      theme: document.documentElement.dataset.theme, world: { ...world?.dataset } };
  });
  await writeFile(info.outputPath("runtime.json"), JSON.stringify(runtime, null, 2));
  expect(runtime.renderer).toMatch(/Direct3D11|D3D11/);
  expect(runtime.renderer).not.toMatch(/swiftshader|llvmpipe|software|basic render/i);
  expect(runtime.dpr).toBe(1);
});

const project = { project_id: "design-fixture", slug: "design-fixture", title: "Design fixture",
  description: "A local resource fixture for layout verification.", icon_url: null, downloads: 1200,
  author: "Fixture", project_type: "mod", versions: ["1.21.1"] };

async function prepare(page: Page, theme: "dark" | "light", stress = true) {
  await installLauncherFixture(page, { theme, stress, instanceCount: 2 });
  await page.route("https://api.modrinth.com/v2/search?**", route => route.fulfill({
    contentType: "application/json", body: JSON.stringify({ hits: [project] }),
  }));
  await page.addInitScript(project => {
    type Api = { invoke(name: string, args?: Record<string, unknown>): Promise<unknown> };
    const host = window as unknown as { __TAURI_INTERNALS__?: Api };
    const wrapped = new WeakSet<Api>();
    function attach(api: Api) {
      if (wrapped.has(api)) return; wrapped.add(api);
      const previous = api.invoke;
      api.invoke = (name, args) => name === "get_modrinth_project_details"
        ? Promise.resolve({ project, versions: [], dependencies: [] }) : previous(name, args);
    }
    let api = host.__TAURI_INTERNALS__;
    Object.defineProperty(host, "__TAURI_INTERNALS__", { configurable: true, enumerable: true,
      get: () => api, set(value: Api) { api = value; attach(value); } });
    if (api) attach(api);
  }, project);
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await expect(page.locator("html")).toHaveAttribute("data-world-intro", "off");
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

/** Viewport-visible interactive controls and reading surfaces, with no page-specific exemptions. */
async function readDesign(page: Page, pageId: string) {
  return page.evaluate(pageId => {
    const shown = (element: HTMLElement) => {
      const bounds = element.getBoundingClientRect();
      return element.checkVisibility({ opacityProperty: true, visibilityProperty: true })
        && !element.closest('[inert],[aria-hidden="true"]')
        && bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.top < innerHeight
        && bounds.right > 0 && bounds.left < innerWidth;
    };
    const stage = document.querySelector<HTMLElement>(`[data-page-stage="${pageId}"]`)!;
    const heading = stage.querySelector<HTMLElement>("h1")!;
    const bounds = heading.getBoundingClientRect();
    const readingPlane = heading.closest<HTMLElement>(".vx-page-shell");
    const planeBounds = readingPlane?.getBoundingClientRect();
    const buttons = [...stage.querySelectorAll<HTMLElement>(".vx-button")].filter(shown).map(element => {
      const css = getComputedStyle(element), rect = element.getBoundingClientRect();
      const icon = element.querySelector<HTMLElement>(".vx-button__icon svg")?.getBoundingClientRect();
      return { text: element.textContent?.trim(), classes: element.className,
        size: (element.classList.contains("vx-button--sm") ? "sm" : element.classList.contains("vx-button--lg") ? "lg" : "md") as "sm" | "md" | "lg",
        height: rect.height, radius: css.borderRadius, x: rect.x, right: rect.right,
        icon: icon ? { width: icon.width, height: icon.height } : null };
    });
    const surfaces = [...stage.querySelectorAll<HTMLElement>(".vx-panel,.vx-card,.vx-appearance-preview")].filter(shown).map(element => {
      const css = getComputedStyle(element);
      return { classes: element.className, radius: css.borderRadius, background: css.backgroundColor,
        border: css.borderTopWidth, borderStyle: css.borderTopStyle };
    });
    return { page: pageId, heading: { x: bounds.x, y: bounds.y, text: heading.textContent,
      planeX: planeBounds?.x ?? null, planeWidth: planeBounds?.width ?? null,
      inset: planeBounds ? bounds.x - planeBounds.x : null }, buttons, surfaces,
      scrollWidth: document.documentElement.scrollWidth, viewport: innerWidth };
  }, pageId);
}

function checkDesign(row: Awaited<ReturnType<typeof readDesign>>) {
  for (const button of row.buttons) {
    const label = `${row.page}: ${button.classes} '${button.text}'`;
    expect.soft(button.height, label).toBe({ sm: 32, md: 38, lg: 56 }[button.size]);
    expect.soft(button.radius, label).toBe("999px");
    if (button.icon) expect.soft(button.icon, label).toEqual({
      width: { sm: 14, md: 16, lg: 18 }[button.size], height: { sm: 14, md: 16, lg: 18 }[button.size],
    });
  }
  for (const surface of row.surfaces) {
    expect.soft(["6px", "12px"], `${row.page}: ${surface.classes}`).toContain(surface.radius);
    expect.soft(surface.border, `${row.page}: ${surface.classes} hairline`).toBe("1px");
    expect.soft(surface.borderStyle, `${row.page}: ${surface.classes} hairline`).toBe("solid");
  }
  expect.soft(row.scrollWidth, `${row.page}: horizontal page overflow`).toBeLessThanOrEqual(row.viewport);
}

const pages = ["home", "library", "discover", "multiplayer", "downloads", "accounts", "settings"] as const;

async function selectionAppearance(target: Locator) {
  return target.evaluate(element => {
    const root = element as HTMLElement;
    const mark = root.querySelector<HTMLElement>(":scope > .vx-selection__mark");
    const surface = mark ?? root, css = getComputedStyle(surface), bounds = root.getBoundingClientRect();
    const resolve = (color: string) => {
      const probe = document.createElement("span"); probe.style.color = color; probe.style.display = "none"; root.append(probe);
      const resolved = getComputedStyle(probe).color; probe.remove(); return resolved;
    };
    const pseudo = ["::before", "::after"].map(name => {
      const style = getComputedStyle(root, name);
      return { name, content: style.content, display: style.display, width: style.width, height: style.height, background: style.backgroundColor };
    });
    return { classes: root.className, background: css.backgroundColor, selection: resolve("var(--selection-fill)"),
      accentSoft: resolve("var(--accent-soft)"), bounds: bounds.toJSON(), mark: mark?.getBoundingClientRect().toJSON() ?? null,
      borderLeft: getComputedStyle(root).borderLeftWidth, shadow: getComputedStyle(root).boxShadow, pseudo };
  });
}

function checkSelection(row: Awaited<ReturnType<typeof selectionAppearance>>, label: string) {
  expect.soft(row.background, `${label}: resolved selection fill`).toBe(row.selection);
  expect.soft(row.background, `${label}: no accent-soft selection`).not.toBe(row.accentSoft);
  expect.soft(row.borderLeft, `${label}: no 3px side border`).not.toBe("3px");
  if (row.mark) {
    expect.soft(Math.abs(row.mark.width - row.bounds.width), `${label}: mark fills button width`).toBeLessThanOrEqual(1);
    expect.soft(Math.abs(row.mark.height - row.bounds.height), `${label}: mark fills button height`).toBeLessThanOrEqual(1);
  }
  for (const pseudo of row.pseudo) if (pseudo.content !== "none" && pseudo.display !== "none")
    expect.soft(pseudo.width, `${label}: no 3px ${pseudo.name} side stripe`).not.toBe("3px");
}

for (const theme of ["dark", "light"] as const) {
  nativeTest(`R2-04 ${theme}: selected rows tabs sidebars and menu options retain selection fill on hover`, async ({ page }, info) => {
    nativeTest.setTimeout(90000);
    await page.setViewportSize({ width: 1440, height: 930 });
    await prepare(page, theme, false);
    const rows: { label: string; resting: Awaited<ReturnType<typeof selectionAppearance>>; hovered: Awaited<ReturnType<typeof selectionAppearance>> }[] = [];
    const inspect = async (label: string, target: Locator) => {
      await expect(target).toBeVisible();
      await page.mouse.move(1435, 100);
      const resting = await selectionAppearance(target);
      await target.hover();
      const hovered = await selectionAppearance(target);
      rows.push({ label, resting, hovered });
      checkSelection(resting, `${label} resting`); checkSelection(hovered, `${label} hovered`);
    };
    await page.locator("#home-instance").click();
    const glassMenu = page.locator(".vx-instance-picker__popover .vx-listbox-surface");
    await expect(glassMenu).toHaveCSS("opacity", "1");
    await inspect("glass menu option", glassMenu.locator('[role="option"][aria-selected="true"]'));
    await page.keyboard.press("Escape");
    await navigate(page, "accounts");
    await inspect("current account row", page.locator('.vx-account-row[data-selected="true"]'));
    await navigate(page, "settings");
    await inspect("settings sidebar", page.locator('.vx-settings-nav > button[data-selected]'));
    await page.locator(".vx-settings-nav").getByRole("button", { name: "下载", exact: true }).click();
    await expect(page.locator(".vx-settings-content")).toHaveCSS("opacity", "1");
    const field = page.locator(".vx-settings-content .vx-select__button").first();
    await field.click();
    const flatMenu = page.locator(".vx-listbox-surface.vx-select-flat-surface");
    await expect(flatMenu).toHaveCSS("opacity", "1");
    await inspect("flat menu option", flatMenu.locator('[role="option"][aria-selected="true"]'));
    await page.keyboard.press("Escape");
    await navigate(page, "library");
    await page.locator('.vx-instance-card[data-instance-id="fixture-world"] .vx-instance-card__select').click();
    await expect(page.locator(".vx-detail-workspace")).toHaveCSS("opacity", "1");
    await inspect("instance detail tab", page.locator('.vx-detail-selection > button[aria-selected="true"]'));
    await page.screenshot({ path: info.outputPath(`${theme}-selected-detail.png`), scale: "css" });
    await writeFile(info.outputPath("selection-fills.json"), JSON.stringify({ theme, rows }, null, 2));
  });
}
for (const theme of ["dark", "light"] as const) for (const width of [1050, 1440, 1920]) {
  nativeTest(`design matrix ${theme} ${width}: seven pages share buttons surfaces and content heading alignment`, async ({ page }, info) => {
    nativeTest.setTimeout(120000);
    await page.setViewportSize({ width, height: width === 1050 ? 720 : width === 1440 ? 930 : 1080 });
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await prepare(page, theme);
    const rows = [], fills = [];
    for (const id of pages) {
      if (id !== "home") await navigate(page, id);
      await page.mouse.move(width - 4, 100);
      const row = await readDesign(page, id); rows.push(row);
      await page.screenshot({ path: info.outputPath(`${theme}-${width}-${id}.png`), scale: "css" });
      checkDesign(row);
      if (theme === "dark" && id !== "home") {
        const reading = await readLargeReadingFills(page); fills.push({ page: id, ...reading });
        for (const surface of reading.rows)
          expect.soft(surface.allowedTokens.length, `${id}/${surface.classes}: page, panel, card or selection fill`).toBeGreaterThan(0);
      }
    }
    await writeFile(info.outputPath("design-audit.json"), JSON.stringify({ theme, width, rows, fills, errors }, null, 2));
    const headingXs = rows.filter(row => row.page !== "home").map(row => row.heading.x);
    expect(headingXs).toHaveLength(6);
    expect(Math.max(...headingXs) - Math.min(...headingXs)).toBeLessThanOrEqual(.01);
    expect(errors).toEqual([]);
  });
}

nativeTest("R2-07 discovery details keeps its 720px width at 1440", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 930 });
  await prepare(page, "light", false);
  await navigate(page, "discover");
  await page.locator('.vx-project-card[data-project-id="design-fixture"] .vx-project-card__actions .vx-button--ghost').click();
  const dialog = page.locator(".vx-dialog.vx-project-details[open]");
  await expect(dialog).toHaveCSS("opacity", "1");
  const geometry = await dialog.evaluate(element => ({ bounds: element.getBoundingClientRect().toJSON(),
    cssWidth: getComputedStyle(element).width, radius: getComputedStyle(element).borderRadius }));
  await page.screenshot({ path: info.outputPath("discover-details-1440.png"), scale: "css" });
  await writeFile(info.outputPath("discover-details-geometry.json"), JSON.stringify(geometry, null, 2));
  expect(geometry.bounds.width).toBe(720);
});

for (const theme of ["dark", "light"] as const) {
  nativeTest(`R2-06 ${theme}: composited reading surfaces include both library detail pages`, async ({ page }, info) => {
    nativeTest.setTimeout(90000);
    await page.setViewportSize({ width: 1440, height: 930 });
    await prepare(page, theme, false);
    const rows: { name: string; pixels: Awaited<ReturnType<typeof captureReadingSurface>>; fills: Awaited<ReturnType<typeof readLargeReadingFills>> }[] = [];
    const capture = async (name: string, selector: string) => {
      await expect(page.locator(selector).first()).toBeVisible();
      await page.mouse.move(1435, 100);
      const pixels = await captureReadingSurface(page, selector, info.outputPath(`${theme}-${name}.png`));
      const fills = await readLargeReadingFills(page);
      expect(fills.rows.length, `${name}: real reading surfaces`).toBeGreaterThan(0);
      if (theme === "dark") for (const surface of fills.rows)
        expect.soft(surface.allowedTokens.length, `${name}/${surface.classes}: allowed reading fill`).toBeGreaterThan(0);
      const result = { name, pixels, fills }; rows.push(result); return result;
    };
    await navigate(page, "library");
    const card = await capture("library-card", '.vx-instance-card[data-instance-id="fixture-world"]');
    await navigate(page, "settings");
    const panel = await capture("settings-panel", ".vx-settings-content.vx-panel");
    await navigate(page, "accounts");
    await expect(page.locator(".vx-appearance-preview canvas, .vx-appearance-preview .vx-appearance-placeholder").first()).toBeVisible();
    const preview = await capture("character-preview", ".vx-appearance-preview");
    expect.soft(preview.pixels.surface.medianBrightness - preview.pixels.page.medianBrightness, "preview is brighter than its page").toBeGreaterThan(0);
    if (theme === "light") {
      expect.soft(panel.pixels.surface.medianBrightness - panel.pixels.page.medianBrightness, "light panel minus page").toBeGreaterThanOrEqual(4);
      expect.soft(card.pixels.surface.medianBrightness - panel.pixels.surface.medianBrightness, "light card minus panel").toBeGreaterThanOrEqual(4);
      expect.soft(preview.pixels.surface.medianBrightness - panel.pixels.surface.medianBrightness, "light preview minus panel").toBeGreaterThanOrEqual(4);
    }
    await navigate(page, "library");
    await page.locator('.vx-instance-card[data-instance-id="fixture-world"] .vx-instance-card__select').click();
    await expect(page.locator(".vx-detail-workspace")).toHaveCSS("opacity", "1");
    await capture("instance-detail", ".vx-detail-workspace");
    await page.locator(".vx-detail-header > button").first().click();
    await expect(page.locator(".vx-library-page")).toBeVisible();
    await page.getByRole("button", { name: "版本目录", exact: true }).click();
    await page.locator('.vx-version-card[data-version-directory="1.21.1"] [data-version-id="1.21.1"], .vx-instance-card[data-version-directory="1.21.1"] [data-version-id="1.21.1"]').click();
    await expect(page.locator("#version-detail-panel")).toHaveCSS("opacity", "1");
    await capture("version-directory-detail", "#version-detail-panel");
    await writeFile(info.outputPath("reading-surfaces.json"), JSON.stringify({ theme, rows,
      method: "Fixed 6x6 geometric patches; reject text/control/media overlap and DOM occlusion before reading pixels. No brightness-based candidate selection, recoloring or hidden content.",
      scope: "Visible explicit reading surfaces across the matrix and default InstanceDetailPage/VersionDirectoryDetailPage; controls, icons, badges and unopened detail tabs are not large reading surfaces in this check." }, null, 2));
  });
}

async function keyboardReach(page: Page, selector: string) {
  const target = page.locator(selector);
  await expect(target).toBeVisible();
  for (let index = 0; index < 70; index++) {
    await page.keyboard.press("Tab");
    if (await target.evaluate(element => element === document.activeElement)) return;
  }
  await expect(target).toBeFocused();
}

nativeTest("R2-04 current accounts and selected instances expose their state on keyboard targets", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 930 });
  await prepare(page, "light", false);
  const recent = page.locator('.vx-recent-card[data-instance-id="fixture-world"]');
  await recent.click();
  await expect(recent).toHaveAttribute("aria-current", "true");
  await expect(recent).not.toHaveAttribute("aria-pressed", /.+/);
  await navigate(page, "library");
  const card = '.vx-instance-card[data-instance-id="fixture-world"] .vx-instance-card__select';
  await keyboardReach(page, card);
  await expect(page.locator(card)).toHaveAttribute("aria-current", "true");
  await expect(page.locator('.vx-instance-card[data-instance-id="fixture-world"]')).not.toHaveAttribute("aria-current", /.+/);
  await page.screenshot({ path: info.outputPath("library-current-keyboard.png"), scale: "css" });
  await navigate(page, "accounts");
  const accountSelector = '.vx-account-choice[aria-current="true"]';
  await expect(page.locator(accountSelector)).toBeEnabled();
  await keyboardReach(page, accountSelector);
  await expect(page.locator(accountSelector)).toHaveAccessibleName(/当前/);
  const countCalls = () => page.evaluate(() => (window as unknown as {
    __appearanceFixtures: { calls: { name: string }[] };
  }).__appearanceFixtures.calls.filter(call => call.name === "select_account").length);
  const before = await countCalls();
  await page.keyboard.press("Enter");
  expect(await countCalls()).toBe(before);
  await expect(page.locator(accountSelector)).toBeFocused();
  const current = await page.locator(accountSelector).evaluate(element => ({
    label: element.getAttribute("aria-label"), current: element.getAttribute("aria-current"),
    selectedFill: getComputedStyle(element.closest(".vx-account-row")!).backgroundColor,
    token: getComputedStyle(document.documentElement).getPropertyValue("--selection-fill"),
  }));
  await page.screenshot({ path: info.outputPath("account-current-keyboard.png"), scale: "css" });
  await writeFile(info.outputPath("current-semantics.json"), JSON.stringify({ current, selectionCallsBefore: before, selectionCallsAfter: await countCalls() }, null, 2));
});

for (const theme of ["dark", "light"] as const) for (const mode of ["forced-colors", "contrast-more", "reduced-transparency"] as const) {
  nativeTest(`R2-07 ${theme} ${mode}: layers retain geometry and opaque unblurred materials`, async ({ page }, info) => {
    nativeTest.setTimeout(120000);
    await page.setViewportSize({ width: 1440, height: 930 });
    await prepare(page, theme);
    const pageIds = ["library", "discover", "accounts"] as const;
    const baseline = [];
    for (const id of pageIds) { await navigate(page, id); baseline.push(await readDesign(page, id)); }
    if (mode === "forced-colors") await page.emulateMedia({ forcedColors: "active" });
    if (mode === "contrast-more") await page.emulateMedia({ contrast: "more" });
    // Keep the CDP session alive: a matchMedia-only shim does not activate CSS
    // media rules, and detaching the session clears the emulation override.
    const media = mode === "reduced-transparency" ? await page.context().newCDPSession(page) : null;
    if (media) await media.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: "reduce" }] });
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute(mode === "reduced-transparency" ? "data-reduced-transparency" : "data-high-contrast", "true");
    const query = mode === "forced-colors" ? "(forced-colors: active)" : mode === "contrast-more" ? "(prefers-contrast: more)" : "(prefers-reduced-transparency: reduce)";
    expect(await page.evaluate(query => matchMedia(query).matches, query)).toBe(true);
    await expect(page.locator(".vx-glass-provider")).toHaveAttribute("data-glass-mode", "fallback");
    await expect(page.locator("html")).toHaveAttribute("data-world-intro", "off");
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const degraded = [], materials = [];
    for (const id of pageIds) {
      await navigate(page, id);
      const row = await readDesign(page, id); degraded.push(row); checkDesign(row);
      const material = await page.evaluate(({ id, mode }) => {
        const rgba = (color: string) => {
          const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
          const context = canvas.getContext("2d")!;
          context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1);
          return [...context.getImageData(0, 0, 1, 1).data];
        };
        const probe = document.createElement("span"); probe.style.display = "none";
        probe.style.color = mode === "forced-colors" ? "Canvas" : "var(--surface-solid)"; document.body.append(probe);
        const expected = rgba(getComputedStyle(probe).color); probe.remove();
        const read = (element: Element) => {
          const css = getComputedStyle(element);
          return { classes: element.className, background: css.backgroundColor, rgba: rgba(css.backgroundColor),
            backdrop: css.backdropFilter, webkitBackdrop: css.getPropertyValue("-webkit-backdrop-filter"),
            bounds: element.getBoundingClientRect().toJSON() };
        };
        const glass = [...document.querySelectorAll<HTMLElement>(".vx-glass-surface")].filter(element => {
          const rect = element.getBoundingClientRect();
          return element.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && rect.width > 0 && rect.height > 0;
        }).map(read);
        const chrome = read(document.querySelector(".vx-window-chrome__bar")!);
        const panels = [...document.querySelectorAll(`[data-page-stage="${id}"] .vx-panel`)].map(read);
        return { page: id, expected, glass, chrome, panels };
      }, { id, mode });
      materials.push(material);
      expect.soft(material.glass.length, `${mode}/${id}: actual visible glass`).toBeGreaterThan(0);
      for (const surface of [...material.glass, material.chrome, ...material.panels]) {
        expect.soft(surface.rgba, `${mode}/${id}/${surface.classes}: opaque resolved fallback`).toEqual(material.expected);
        expect.soft(surface.rgba[3], `${mode}/${id}/${surface.classes}: opaque alpha`).toBe(255);
        expect.soft(surface.backdrop, `${mode}/${id}/${surface.classes}: no backdrop blur or refraction`).toBe("none");
      }
      await page.screenshot({ path: info.outputPath(`${mode}-${id}.png`), scale: "css" });
      const previous = baseline.find(value => value.page === id)!;
      // Forced colors uses the system scrollbar rather than the custom one.
      // Its viewport width can recenter the reading plane; preserve its inset.
      expect.soft(row.heading.inset, `${id} heading inset`).toBe(previous.heading.inset);
      expect.soft(row.heading.planeWidth, `${id} reading width`).toBe(previous.heading.planeWidth);
      expect.soft(row.heading.y, `${id} heading y`).toBe(previous.heading.y);
      expect.soft(row.buttons.map(button => ({ text: button.text, height: button.height, radius: button.radius, icon: button.icon })), `${id} button geometry`)
        .toEqual(previous.buttons.map(button => ({ text: button.text, height: button.height, radius: button.radius, icon: button.icon })));
    }
    const headingXs = degraded.map(row => row.heading.x);
    expect(Math.max(...headingXs) - Math.min(...headingXs)).toBeLessThanOrEqual(.01);
    await writeFile(info.outputPath("degraded-geometry.json"), JSON.stringify({ theme, mode, query, baseline, degraded, materials }, null, 2));
    await media?.detach();
  });
}

async function navigate(page: Page, id: string) {
  await page.locator(`.vx-floating-nav [data-page="${id}"]`).click();
  await expect(page.locator(`[data-page-stage="${id}"]`)).toHaveCSS("opacity", "1");
}

nativeTest("R2-05 library primary controls are 38px pills with 16px icons", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 930 });
  await installLauncherFixture(page, { theme: "light", instanceCount: 2 });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-world-intro", "off");
  await navigate(page, "library");
  const controls = await page.locator(".vx-library-commandbar__actions .vx-button").evaluateAll(elements => elements.map(element => {
    const style = getComputedStyle(element), bounds = element.getBoundingClientRect();
    const icon = element.querySelector(".vx-button__icon svg")?.getBoundingClientRect();
    return { text: element.textContent, height: bounds.height, radius: style.borderRadius, icon: icon ? { width: icon.width, height: icon.height } : null };
  }));
  await writeFile(info.outputPath("library-primary-controls.json"), JSON.stringify(controls, null, 2));
  await page.screenshot({ path: info.outputPath("library-primary-controls.png"), scale: "css" });
  expect(controls).toHaveLength(2);
  for (const control of controls) {
    expect.soft(control.height).toBe(38);
    expect.soft(control.radius).toBe("999px");
    expect.soft(control.icon).toEqual({ width: 16, height: 16 });
  }
});
