// SPDX-License-Identifier: GPL-3.0-only
import { chromium, expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { installLauncherFixture } from "./fixtures";

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
for (const theme of ["dark", "light"] as const) for (const width of [1050, 1440, 1920]) {
  nativeTest(`design matrix ${theme} ${width}: seven pages share buttons surfaces and content heading alignment`, async ({ page }, info) => {
    nativeTest.setTimeout(120000);
    await page.setViewportSize({ width, height: width === 1050 ? 720 : width === 1440 ? 930 : 1080 });
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await prepare(page, theme);
    const rows = [];
    for (const id of pages) {
      if (id !== "home") await navigate(page, id);
      await page.mouse.move(width - 4, 100);
      const row = await readDesign(page, id); rows.push(row);
      await page.screenshot({ path: info.outputPath(`${theme}-${width}-${id}.png`), scale: "css" });
      checkDesign(row);
    }
    await writeFile(info.outputPath("design-audit.json"), JSON.stringify({ theme, width, rows, errors }, null, 2));
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

for (const mode of ["forced-colors", "contrast-more", "reduced-transparency"] as const) {
  nativeTest(`R2-07 ${mode}: layers retain control and heading geometry`, async ({ page }, info) => {
    nativeTest.setTimeout(120000);
    await page.setViewportSize({ width: 1440, height: 930 });
    await prepare(page, "light");
    const pageIds = ["library", "discover", "accounts"] as const;
    const baseline = [];
    for (const id of pageIds) { await navigate(page, id); baseline.push(await readDesign(page, id)); }
    if (mode === "forced-colors") await page.emulateMedia({ forcedColors: "active" });
    if (mode === "contrast-more") await page.emulateMedia({ contrast: "more" });
    if (mode === "reduced-transparency") await page.addInitScript(() => {
      const original = window.matchMedia;
      window.matchMedia = query => {
        const media = original.call(window, query);
        if (query !== "(prefers-reduced-transparency: reduce)") return media;
        return new Proxy(media, { get(target, property) {
          if (property === "matches") return true;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        } });
      };
    });
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute(mode === "reduced-transparency" ? "data-reduced-transparency" : "data-high-contrast", "true");
    await expect(page.locator("html")).toHaveAttribute("data-world-intro", "off");
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const degraded = [];
    for (const id of pageIds) {
      await navigate(page, id);
      const row = await readDesign(page, id); degraded.push(row); checkDesign(row);
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
    await writeFile(info.outputPath("degraded-geometry.json"), JSON.stringify({ mode, baseline, degraded }, null, 2));
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
