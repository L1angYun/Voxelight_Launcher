// SPDX-License-Identifier: GPL-3.0-only
import { chromium, expect, test, type Page, type TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { installLauncherFixture } from "./fixtures";
import { decodePng, probeGlassRefraction } from "./helpers/glass-pixel-probe.mjs";

const nativeTest = test.extend({
  context: async ({ baseURL }, use) => {
    const browser = await chromium.launch({ channel: "chromium", args: ["--use-angle=d3d11"] });
    const context = await browser.newContext({ baseURL, deviceScaleFactor: 1 });
    try { await use(context); } finally { await context.close(); await browser.close(); }
  },
});

nativeTest("cascade layer registration gives system overrides the highest priority", async ({ page }, info) => {
  await prepare(page);
  const registration = await page.evaluate(() => {
    const names: string[] = [];
    for (const sheet of document.styleSheets) for (const rule of sheet.cssRules) {
      const match = /^@layer\s+([^;{]+)[;{]/.exec(rule.cssText);
      if (match) for (const name of match[1].split(",").map(value => value.trim())) if (!names.includes(name)) names.push(name);
    }
    return names;
  });
  await writeFile(info.outputPath("layer-order.json"), JSON.stringify(registration, null, 2));
  expect(registration).toEqual(["tokens", "base", "primitives", "features", "overrides"]);
});

for (const theme of ["dark", "light"] as const) nativeTest(`curvature ${theme}: navigation keeps real refraction across cascade layers`, async ({ page }, info) => {
  await prepare(page, { theme });
  const indicator = page.locator(".vx-floating-nav__indicator");
  await expect(page.locator(".vx-floating-nav")).toHaveAttribute("data-motion-settled", "true");
  await expect(indicator).toHaveAttribute("data-glass-refraction", "curvature");
  await expect(indicator).toHaveCSS("backdrop-filter", /url\(/);
  const result = await probeGlassRefraction(page, info.outputPath("refraction"));
  expect(result.maxEdgeShift).toBeGreaterThanOrEqual(2);
  expect(result.maxCenterShift).toBeLessThanOrEqual(1);
  expect(result.liveShift).toBeGreaterThanOrEqual(6);
  expect(result.liveShift).toBeLessThanOrEqual(8);
  expect(result.maxUniformDelta).toBeLessThanOrEqual(1);
  expect(result.pass).toBe(true);
});
nativeTest.setTimeout(120000);
const failures = new WeakMap<Page, string[]>();
nativeTest.beforeEach(async ({ page }) => {
  const errors: string[] = []; failures.set(page, errors);
  page.on("pageerror", error => errors.push(error.message));
});
nativeTest.afterEach(async ({ page }, info) => {
  const runtime = await page.evaluate(() => {
    const element = document.querySelector<HTMLElement>(".world-scene");
    const gl = element?.querySelector("canvas")?.getContext("webgl2");
    const debug = gl?.getExtension("WEBGL_debug_renderer_info");
    return { renderer: debug ? String(gl!.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : null,
      theme: document.documentElement.dataset.theme, dpr: devicePixelRatio, world: { ...element?.dataset } };
  });
  await writeFile(info.outputPath("runtime.json"), JSON.stringify({ ...runtime, errors: failures.get(page) }, null, 2));
  expect(runtime.renderer).toMatch(/Direct3D11|D3D11/);
  expect(runtime.renderer).not.toMatch(/swiftshader|llvmpipe|software|basic render/i);
  expect(runtime.dpr).toBe(1); expect(failures.get(page)).toEqual([]);
});

type FixtureOptions = NonNullable<Parameters<typeof installLauncherFixture>[1]>;
async function prepare(page: Page, options: FixtureOptions & { locale?: "zh-CN" | "en-US"; login?: boolean; emptyServers?: boolean; libraryDirectory?: string } = {}) {
  const { locale = "en-US", login = false, emptyServers = false, libraryDirectory, ...fixture } = options;
  await installLauncherFixture(page, { theme: "light", instanceCount: 2, ...fixture });
  await page.route("https://api.modrinth.com/v2/search?**", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ hits: [] }) }));
  await page.addInitScript(({ locale, login, emptyServers, libraryDirectory }) => {
    type Api = { invoke(name: string, args?: Record<string, unknown>): Promise<unknown> };
    const host = window as unknown as { __TAURI_INTERNALS__?: Api; __appearanceFixtures?: { calls: { name: string; args?: Record<string, unknown> }[] } };
    const wrapped = new WeakSet<Api>();
    function attach(api: Api) {
      if (wrapped.has(api)) return; wrapped.add(api);
      const original = api.invoke;
      api.invoke = async (name, args) => {
        if (name === "bootstrap") {
          const data = await original(name, args) as { config: Record<string, unknown>; instances: Record<string, unknown>[] };
          return { ...data, config: { ...data.config, language: locale, ...(login ? { microsoftClientId: "fixture-client-id" } : {}) },
            instances: libraryDirectory ? data.instances.map((instance, index) => index === 0 ? { ...instance, gameDirectory: libraryDirectory } : instance) : data.instances };
        }
        if (name === "list_servers" && emptyServers) { await original(name, args); return []; }
        if (login && (name === "begin_microsoft_login" || name === "poll_microsoft_login")) {
          host.__appearanceFixtures?.calls.push({ name, args });
          return name === "begin_microsoft_login" ? { sessionId: "interface-device-fixture", userCode: "INTERFACE-CODE",
            verificationUri: "https://microsoft.com/devicelogin", expiresIn: 300, interval: 5, message: "Synthetic authorization" }
            : { status: "pending", retryAfterSeconds: 5, account: null };
        }
        return original(name, args);
      };
    }
    let api = host.__TAURI_INTERNALS__;
    Object.defineProperty(host, "__TAURI_INTERNALS__", { configurable: true, enumerable: true,
      get: () => api, set(value: Api) { api = value; attach(value); } });
    if (api) attach(api);
  }, { locale, login, emptyServers, libraryDirectory });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", fixture.theme ?? "light");
  await expect(page.locator("html")).toHaveAttribute("data-world-intro", "off");
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}
async function navigate(page: Page, id: string) {
  await page.locator(`.vx-floating-nav [data-page="${id}"]`).click();
  await expect(page.locator(`[data-page-stage="${id}"]`)).toHaveCSS("opacity", "1");
}
async function evidence(page: Page, info: TestInfo, name: string, metrics: unknown) {
  await writeFile(info.outputPath(`${name}.json`), JSON.stringify(metrics, null, 2));
  await page.screenshot({ path: info.outputPath(`${name}.png`), scale: "css" });
}

nativeTest("R2-08 login tabs automatically activate until a device session requires explicit activation", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 930 }); await prepare(page, { login: true });
  await navigate(page, "accounts"); await page.getByRole("button", { name: "Add account", exact: true }).click();
  const dialog = page.locator(".vx-login-dialog[open]");
  const microsoft = dialog.getByRole("tab", { name: "Microsoft", exact: true }), offline = dialog.getByRole("tab", { name: "Offline", exact: true });
  await microsoft.focus(); await page.keyboard.press("ArrowRight");
  await expect(offline).toBeFocused(); await expect(offline).toHaveAttribute("aria-selected", "true");
  await expect(dialog.locator('[role="tabpanel"]')).toHaveAttribute("aria-labelledby", "login-method-offline");
  await page.keyboard.press("ArrowLeft"); await expect(microsoft).toHaveAttribute("aria-selected", "true");
  await dialog.getByRole("button", { name: "Start Microsoft login", exact: true }).click();
  await expect(dialog.getByText("INTERFACE-CODE", { exact: true })).toBeVisible();
  await microsoft.focus(); await page.keyboard.press("ArrowRight");
  await expect(offline).toBeFocused(); await expect(microsoft).toHaveAttribute("aria-selected", "true");
  const cancelled = () => page.evaluate(() => (window as unknown as { __appearanceFixtures: { calls: { name: string }[] } }).__appearanceFixtures.calls.filter(call => call.name === "cancel_auth_login").length);
  expect(await cancelled()).toBe(0);
  await page.keyboard.press("ArrowLeft"); await expect(microsoft).toBeFocused();
  await page.keyboard.press("Enter"); await page.keyboard.press("Space");
  await expect(dialog.getByText("INTERFACE-CODE", { exact: true })).toBeVisible();
  expect(await cancelled()).toBe(0);
  await page.keyboard.press("ArrowRight"); await expect(offline).toBeFocused();
  await evidence(page, info, "login-manual-focus", { cancelled: await cancelled(), selected: await microsoft.getAttribute("aria-selected"), focused: await offline.evaluate(e => e === document.activeElement) });
  await page.keyboard.press("Enter"); await expect(offline).toHaveAttribute("aria-selected", "true");
  expect(await cancelled()).toBe(1);
});

for (const theme of ["dark", "light"] as const) nativeTest(`R2-11 ${theme} profile failure retains a standard retry outside its live region`, async ({ page }, info) => {
  await page.setViewportSize({ width: 1050, height: 720 }); await prepare(page, { theme, profileFailure: true });
  const fallback = page.locator(".vx-character-placeholder"), retry = fallback.getByRole("button");
  await expect(retry).toBeVisible();
  const result = await fallback.evaluate(element => {
    const button = element.querySelector<HTMLButtonElement>("button")!, live = element.querySelector('[role="status"]');
    return { height: button.getBoundingClientRect().height, font: parseFloat(getComputedStyle(button).fontSize),
      radius: getComputedStyle(element).borderRadius, statusText: live?.textContent, buttonText: button.textContent,
      statusContainsButton: Boolean(button.closest('[role="status"]')) };
  });
  await evidence(page, info, "profile-failure", result);
  expect(result.height).toBe(38); expect(result.font).toBeGreaterThanOrEqual(13);
  expect(result.radius).toBe("12px"); expect(result.statusContainsButton).toBe(false);
  expect(result.statusText).not.toContain(result.buttonText!.trim());
});

for (const width of [1050, 1440]) nativeTest(`R2-13 empty home ${width} keeps explanation close and actions on one row`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: width === 1050 ? 720 : 930 });
  await prepare(page, { noInstances: true, versionDirectoryCount: 0 });
  const result = await page.locator(".vx-home").evaluate(element => {
    const title = element.querySelector("h1")!.getBoundingClientRect(), copy = element.querySelector(".vx-home__empty > p")!.getBoundingClientRect();
    const buttons = [...element.querySelectorAll(".vx-empty__actions .vx-button")].map(node => ({ bounds: node.getBoundingClientRect().toJSON(), variant: node.getAttribute("data-variant") }));
    return { gap: copy.top - title.bottom, buttons };
  });
  await evidence(page, info, "empty-home", result);
  expect(result.gap).toBeGreaterThanOrEqual(0); expect(result.gap).toBeLessThanOrEqual(20);
  expect(result.buttons).toHaveLength(2); expect(result.buttons[0].bounds.top).toBe(result.buttons[1].bounds.top);
  expect(result.buttons[1].variant).toBe("secondary");
});

nativeTest("R2-14 English 1050 server details use a two-line title and the shared rail position", async ({ page }, info) => {
  await page.setViewportSize({ width: 1050, height: 720 }); await prepare(page, { stress: true, theme: "dark" }); await navigate(page, "multiplayer");
  const result = await page.locator(".vx-server-row").evaluate(element => {
    const heading = element.querySelector("h2")!, css = getComputedStyle(heading), title = heading.getBoundingClientRect();
    const address = element.querySelector(".vx-server-row__copy p")!;
    return { x: element.getBoundingClientRect().x, title: { text: heading.textContent, title: heading.getAttribute("title"), height: title.height, lineHeight: parseFloat(css.lineHeight), font: css.fontSize }, addressBreaks: address.querySelectorAll("wbr").length };
  });
  await evidence(page, info, "server-1050", result);
  expect(result.x).toBe(296); expect(result.title.height).toBeLessThanOrEqual(result.title.lineHeight * 2 + .01);
  expect(result.title.title).toBe(result.title.text); expect(result.addressBreaks).toBeGreaterThan(1);
});

const sections = { library: ".vx-library-commandbar", discover: ".vx-discover-workspace", multiplayer: ".vx-multiplayer-tabs",
  downloads: ".vx-task-center", accounts: ".vx-accounts-layout", settings: ".vx-settings-layout" } as const;
for (const locale of ["zh-CN", "en-US"] as const) for (const width of [1050, 1440]) nativeTest(`R2-15 ${locale} ${width} six content pages begin together`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: width === 1050 ? 720 : 930 }); await prepare(page, { locale, stress: true });
  const rows = [];
  for (const [id, selector] of Object.entries(sections)) {
    await navigate(page, id); await expect(page.locator(selector)).toBeVisible();
    const result = await page.locator(selector).evaluate(element => ({ top: element.getBoundingClientRect().top,
      description: document.querySelector('[data-page-stage]:not([inert]) .vx-page-header__text p')?.textContent }));
    let accountHeadings: number[] | undefined;
    if (id === "accounts") accountHeadings = await page.locator("#account-list-title,#appearance-panel-title").evaluateAll(elements => elements.map(element => element.getBoundingClientRect().y));
    rows.push({ id, selector, ...result, accountHeadings });
    await page.screenshot({ path: info.outputPath(`${locale}-${width}-${id}.png`), scale: "css" });
  }
  await writeFile(info.outputPath("content-origins.json"), JSON.stringify(rows, null, 2));
  for (const row of rows) expect.soft(row.description, `${row.id} description`).toBeTruthy();
  const positions = rows.map(row => row.top);
  expect(Math.max(...positions) - Math.min(...positions)).toBeLessThanOrEqual(2);
  const accountHeadings = rows.find(row => row.id === "accounts")!.accountHeadings!;
  expect(accountHeadings).toHaveLength(2); expect(accountHeadings[0]).toBe(accountHeadings[1]);
});

nativeTest("R2-18 two hundred real fixture tasks retain counts in compact paged history", async ({ page }, info) => {
  await page.setViewportSize({ width: 1920, height: 1080 }); await prepare(page, { stress: true }); await navigate(page, "downloads");
  const history = page.locator(".vx-task-section--history"), rows = history.locator("[data-task-id]");
  await expect(rows).toHaveCount(30); await expect(page.getByLabel("199 in history", { exact: true })).toBeVisible();
  const result = await page.evaluate(() => {
    const rows = [...document.querySelectorAll<HTMLElement>(".vx-task-section--history [data-task-id]")].map(element => element.getBoundingClientRect().toJSON());
    const active = document.querySelector("#downloads-active")!.getBoundingClientRect(), history = document.querySelector("#downloads-history")!.getBoundingClientRect();
    return { rows, fullyVisible: rows.filter(row => row.top >= 0 && row.bottom <= innerHeight).length,
      pageHeight: document.querySelector<HTMLElement>(".vx-downloads-page")!.scrollHeight, headingX: [active.x, history.x] };
  });
  await evidence(page, info, "downloads-200", result);
  expect(result.fullyVisible).toBeGreaterThanOrEqual(8); expect(result.pageHeight).toBeLessThan(4000);
  for (const row of result.rows) expect.soft(row.height).toBe(56);
  expect(result.headingX[0]).toBe(result.headingX[1]); await expect(history.locator(".vx-lattice-progress")).toHaveCount(0);
  await history.getByRole("button", { name: "Show more", exact: true }).click(); await expect(rows).toHaveCount(60);
  await history.getByRole("button", { name: "Failed", exact: true }).click(); await expect(rows).toHaveCount(1);
  await expect(rows).not.toContainText("Size pending"); await expect(rows).toHaveAttribute("data-status", "failed");
  await history.getByRole("button", { name: "Completed", exact: true }).click(); await expect(rows).toHaveCount(30);
});

for (const width of [1050, 1280, 1920]) nativeTest(`R2-19 home ${width} records its feet anchor and responsive controls`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: width === 1920 ? 1080 : 720 }); await prepare(page, { stress: true });
  const result = await page.evaluate(() => ({
    feet: document.querySelector(".vx-home__feet[data-world-anchor]")!.getBoundingClientRect().toJSON(),
    character: document.querySelector(".vx-home__character-panel")!.getBoundingClientRect().toJSON(),
    textWidth: document.querySelector(".vx-instance-picker__trigger .vx-select__text")!.getBoundingClientRect().width,
    cardWidths: [...document.querySelectorAll(".vx-recent-card")].map(element => element.getBoundingClientRect().width),
  }));
  await evidence(page, info, "home-anchor", result);
  expect(result.feet.width).toBeGreaterThan(0); expect(result.feet.bottom).toBeLessThanOrEqual(width === 1920 ? 1080 : 720);
  if (width === 1920) { expect(result.textWidth).toBeGreaterThanOrEqual(280); for (const cardWidth of result.cardWidths) expect(cardWidth).toBeGreaterThanOrEqual(240); }
});

nativeTest("R2-23 Chinese accounts distinguish accounts from players and translate model names", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 930 }); await prepare(page, { locale: "zh-CN" }); await navigate(page, "accounts");
  await expect(page.locator(".vx-accounts-page h1")).toHaveText("角色");
  await expect(page.getByRole("button", { name: "添加账号", exact: true })).toBeVisible();
  await expect(page.locator(".vx-accounts-page")).not.toContainText(/Classic|Slim|添加角色/);
  await evidence(page, info, "accounts-terminology", { text: await page.locator(".vx-accounts-page").innerText() });
});

nativeTest("R2-24 empty servers retain a single explanation in the 380px detail frame", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 930 }); await prepare(page, { emptyServers: true }); await navigate(page, "multiplayer");
  const empty = page.locator(".vx-server-row--empty"); await expect(empty).toBeVisible();
  const result = await empty.evaluate(element => ({ height: element.getBoundingClientRect().height,
    border: getComputedStyle(element).borderTopWidth, borderStyle: getComputedStyle(element).borderTopStyle }));
  await evidence(page, info, "server-empty", result);
  await expect(page.getByText("No saved servers", { exact: true })).toHaveCount(1);
  expect(result.height).toBe(380); expect(result.border).toBe("1px"); expect(result.borderStyle).toBe("solid");
});

nativeTest("R2-25 keyboard traversal reaches recent instances before the single animation control", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 930 }); await prepare(page, { instanceCount: 2 });
  await page.locator('[data-launch-action="idle"]').focus();
  const order: { text: string | null; recent: boolean; animation: boolean }[] = [];
  for (let index = 0; index < 30; index++) {
    await page.keyboard.press("Tab");
    const row = await page.evaluate(() => ({ text: document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent ?? null,
      recent: Boolean(document.activeElement?.matches(".vx-recent-card")), animation: Boolean(document.activeElement?.closest(".vx-home__animation-controls")) }));
    order.push(row); if (row.animation) break;
  }
  await evidence(page, info, "home-tab-order", order);
  expect(order.some(row => row.recent)).toBe(true); expect(order.at(-1)?.animation).toBe(true);
  await expect(page.locator('.vx-home__animation-controls[role],.vx-home__animation-controls[aria-label]')).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Animation mode", exact: true })).toHaveCount(1);
});

nativeTest("R2-26 English wide cards retain the final directory segment and two-line names", async ({ page }, info) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  // Stress the parent path while retaining a normal directory basename; the
  // separate stress matrix records the exceptionally long basename fixture.
  await prepare(page, { stress: true, libraryDirectory: "C:\\SyntheticFixture\\instances\\a-long-parent-directory-with-several-components\\shared-world" });
  await navigate(page, "library");
  const result = await page.locator('.vx-instance-card[data-instance-id="long-instance"]').evaluate(element => {
    const name = element.querySelector<HTMLElement>(".vx-instance-card__name")!, tail = element.querySelector<HTMLElement>(".vx-instance-card__path-tail")!;
    const path = element.querySelector<HTMLElement>(".vx-instance-card__path")!, style = getComputedStyle(name);
    return { title: name.title, nameHeight: name.getBoundingClientRect().height, lineHeight: parseFloat(style.lineHeight),
      tail: tail.textContent, tailWidth: tail.clientWidth, tailScrollWidth: tail.scrollWidth,
      pathTitle: path.title, forbiddenLabel: path.hasAttribute("aria-label") };
  });
  await evidence(page, info, "library-long-path", result);
  expect(result.nameHeight).toBeLessThanOrEqual(result.lineHeight * 2 + .01);
  expect(result.tail).toBe(result.pathTitle.split(/[\\/]/).at(-1));
  expect(result.tailScrollWidth).toBeLessThanOrEqual(result.tailWidth); expect(result.forbiddenLabel).toBe(false);
});

nativeTest("R2-27 create-dialog segmented tracks fit their actual option content", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 930 }); await prepare(page); await navigate(page, "library");
  await page.locator('.vx-library-commandbar__actions').getByRole("button", { name: "Create instance", exact: true }).click();
  const dialog = page.locator('.vx-create-dialog[open]'); await expect(dialog).toHaveCSS("opacity", "1");
  const tracks = await dialog.locator('.vx-segmented').evaluateAll(elements => elements.map(element => {
    const bounds = element.getBoundingClientRect(), style = getComputedStyle(element);
    const children = [...element.querySelectorAll(':scope > button')].map(button => button.getBoundingClientRect());
    const contentWidth = Math.max(...children.map(rect => rect.right)) - Math.min(...children.map(rect => rect.left));
    const insets = [style.paddingLeft, style.paddingRight, style.borderLeftWidth, style.borderRightWidth].reduce((total, value) => total + parseFloat(value || "0"), 0);
    return { width: bounds.width, contentWidth, insets, fill: element.getAttribute("data-fill") };
  }));
  await evidence(page, info, "create-tracks", tracks);
  expect(tracks).toHaveLength(3);
  for (const track of tracks) { expect(track.fill).toBe("false"); expect(Math.abs(track.width - track.contentWidth - track.insets)).toBeLessThanOrEqual(1); }
});

nativeTest("R2-16/21 Doto counts use display typography and resource titles inherit line spacing", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 930 });
  await prepare(page, { stress: true });
  await navigate(page, "multiplayer");
  const count = await page.locator(".vx-server-inventory > h2 > span").evaluate(element => {
    const style = getComputedStyle(element);
    return { size: style.fontSize, weight: style.fontWeight, family: style.fontFamily, text: element.textContent };
  });
  expect.soft(count.size).toBe("15px");
  expect.soft(count.weight).toBe("900");
  expect.soft(count.family).toContain("Doto");
  await page.evaluate(() => {
    const host = window as unknown as { __TAURI_INTERNALS__: { invoke(name: string, args?: Record<string, unknown>): Promise<unknown> } };
    const invoke = host.__TAURI_INTERNALS__.invoke;
    host.__TAURI_INTERNALS__.invoke = async (name, args) => name === "list_local_resources"
      ? [{ name: "Typography fixture", fileName: "typography.zip", path: "C:\\SyntheticFixture\\typography.zip", enabled: true, size: 1024 }]
      : invoke(name, args);
  });
  await navigate(page, "library");
  await page.locator("article[data-instance-id] .vx-instance-card__select").first().click();
  await page.locator("#instance-tab-content").click();
  const title = page.locator(".vx-resource-row strong").filter({ hasText: "Typography fixture" });
  await expect(title).toBeVisible();
  const resource = await title.evaluate(element => {
    const style = getComputedStyle(element), parent = getComputedStyle(element.parentElement!);
    return { fontSize: style.fontSize, lineHeight: style.lineHeight, family: style.fontFamily,
      parentFontSize: parent.fontSize, parentLineHeight: parent.lineHeight, parentFamily: parent.fontFamily };
  });
  await evidence(page, info, "typography-contract", { count, resource });
  expect.soft(resource.family).toBe(resource.parentFamily);
  expect.soft(Number.isFinite(parseFloat(resource.lineHeight))).toBe(true);
  expect.soft(parseFloat(resource.lineHeight)).toBeCloseTo(
    parseFloat(resource.fontSize) * parseFloat(resource.parentLineHeight) / parseFloat(resource.parentFontSize), 5,
  );
});

nativeTest("R2-09 forced colors retain field boundaries and system-colored chevrons on four pages", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 930 }); await page.emulateMedia({ forcedColors: "active" }); await prepare(page, { stress: true });
  const results = [];
  for (const id of ["library", "discover", "downloads", "accounts"]) {
    await navigate(page, id);
    const result = await page.evaluate(() => {
      const probe = document.createElement("span"); probe.style.color = "CanvasText"; document.body.append(probe);
      const systemColor = getComputedStyle(probe).color; probe.style.color = "Highlight";
      const highlightColor = getComputedStyle(probe).color; probe.remove();
      // aria-hidden decorative SVGs remain visible and must be sampled.
      const visible = (element: Element) => element.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && !element.closest('[inert]');
      const fields = [...document.querySelectorAll('.vx-select__surface,.vx-library-page .vx-search,.vx-discover-search')].filter(visible).map(element => {
        const style = getComputedStyle(element); return { className: element.className, borderWidth: style.borderTopWidth, borderColor: style.borderTopColor, borderStyle: style.borderTopStyle };
      });
      const chevrons = [...document.querySelectorAll('.vx-select__chevron')].filter(visible).map(element => ({
        color: getComputedStyle(element).color, bounds: element.getBoundingClientRect().toJSON() }));
      const chromeIcons = [...document.querySelectorAll('.vx-window-chrome__brand svg,.vx-floating-nav__item>svg')].filter(visible).map(element => ({
        color: getComputedStyle(element).color, active: Boolean(element.closest('.vx-floating-nav__item.is-active')) }));
      return { systemColor, highlightColor, fields, chevrons, chromeIcons };
    });
    const screenshot = decodePng(await page.screenshot({ path: info.outputPath(`forced-${id}.png`), scale: "css" }));
    const rgb = result.systemColor.match(/[\d.]+/g)!.slice(0, 3).map(Number);
    const arrowPixels = result.chevrons.map(arrow => {
      let exactSystemPixels = 0;
      for (let y = Math.max(0, Math.floor(arrow.bounds.top)); y < Math.min(screenshot.height, Math.ceil(arrow.bounds.bottom)); y++)
        for (let x = Math.max(0, Math.floor(arrow.bounds.left)); x < Math.min(screenshot.width, Math.ceil(arrow.bounds.right)); x++) {
          const offset = (y * screenshot.width + x) * 4;
          if (rgb.every((channel, index) => screenshot.pixels[offset + index] === channel)) exactSystemPixels++;
        }
      return { ...arrow, exactSystemPixels };
    });
    results.push({ id, ...result, arrowPixels });
    for (const field of result.fields) { expect.soft(field.borderWidth, `${id} ${field.className}`).toBe("1px"); expect.soft(field.borderStyle).toBe("solid"); expect.soft(field.borderColor).toBe(result.systemColor); }
    for (const arrow of arrowPixels) { expect.soft(arrow.color).toBe(result.systemColor); expect.soft(arrow.exactSystemPixels).toBeGreaterThan(0); }
    for (const icon of result.chromeIcons) expect.soft(icon.color).toBe(icon.active ? result.highlightColor : result.systemColor);
  }
  await writeFile(info.outputPath("forced-fields.json"), JSON.stringify(results, null, 2));
});
