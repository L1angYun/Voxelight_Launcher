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
    const canvas = document.querySelector<HTMLCanvasElement>(".world-scene canvas");
    const gl = canvas?.getContext("webgl2"), debug = gl?.getExtension("WEBGL_debug_renderer_info");
    return { renderer: debug ? String(gl!.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : null,
      dpr: devicePixelRatio, theme: document.documentElement.dataset.theme,
      viewport: { width: innerWidth, height: innerHeight } };
  });
  await writeFile(info.outputPath("runtime.json"), JSON.stringify(runtime, null, 2));
  expect(runtime.renderer).toMatch(/D3D11|Direct3D11/);
  expect(runtime.renderer).not.toMatch(/swiftshader|software|llvmpipe/i);
  expect(runtime.dpr).toBe(1);
});

async function prepare(page: Page, width = 1440, stress = false, overrides: { language?: "en-US"; firstInstanceName?: string } = {}) {
  await page.setViewportSize({ width, height: width <= 1150 ? 720 : width === 1920 ? 1080 : 930 });
  await installLauncherFixture(page, { theme: "dark", instanceCount: 2, stress, ...overrides });
  await page.route("https://api.modrinth.com/v2/search?**", route => route.fulfill({
    contentType: "application/json", body: JSON.stringify({ hits: [] }),
  }));
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-world-intro", "off");
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}
async function navigate(page: Page, destination: string) {
  await page.locator(`.vx-floating-nav [data-page="${destination}"]`).click();
  const stage = page.locator(`[data-page-stage="${destination}"]`);
  await expect(stage).toHaveCSS("opacity", "1");
  await expect.poll(() => stage.evaluate(element => {
    const transform = getComputedStyle(element).transform;
    return transform === "none" || new DOMMatrixReadOnly(transform).isIdentity;
  })).toBe(true);
}
async function openFirstInstance(page: Page) {
  await navigate(page, "library");
  await page.locator('.vx-instance-card[data-instance-id="fixture-world"] .vx-instance-card__select').click();
  await expect(page.locator(".vx-detail-workspace")).toHaveCSS("opacity", "1");
}

for (const width of [1050, 1150, 1440]) {
  nativeTest(`R2-21 compact cascade ${width}: effective commandbar minimum and detail padding win`, async ({ page }, info) => {
    await prepare(page, width); await navigate(page, "library");
    const commandbar = await page.locator(".vx-library-commandbar").evaluate((element, minimum) => {
      const node = element as HTMLElement, css = getComputedStyle(node);
      const tracks = css.gridTemplateColumns.split(" ").map(Number.parseFloat);
      const previous = node.style.width;
      const extra = [css.paddingLeft, css.paddingRight, css.borderLeftWidth, css.borderRightWidth].reduce((sum, value) => sum + parseFloat(value), 0);
      // Expose the minimum contract without changing the viewport or product rules.
      node.style.width = `${minimum + tracks[1] + tracks[2] + parseFloat(css.columnGap) * 2 + extra}px`;
      try {
        return { minimum: parseFloat(getComputedStyle(node).gridTemplateColumns),
          actual: getComputedStyle(node).gridTemplateColumns, viewport: innerWidth,
          scrollWidth: node.scrollWidth, clientWidth: node.clientWidth };
      } finally { node.style.width = previous; }
    }, width <= 1179 ? 170 : 180);
    await openFirstInstance(page);
    const padding = await page.locator(".vx-detail-workspace").evaluate(element => {
      const css = getComputedStyle(element);
      return [css.paddingTop, css.paddingRight, css.paddingBottom, css.paddingLeft].map(Number.parseFloat);
    });
    await writeFile(info.outputPath("compact-cascade.json"), JSON.stringify({ width, commandbar, padding }, null, 2));
    await page.screenshot({ path: info.outputPath("compact-detail.png"), scale: "css" });
    expect.soft(commandbar.minimum).toBeCloseTo(width <= 1179 ? 170 : 180, 1);
    expect.soft(commandbar.scrollWidth).toBeLessThanOrEqual(commandbar.clientWidth);
    // The cascade RED used the historical 22 / 24,26,28 values. Item 10 then
    // deliberately maps them to the real 24 / 24,24,32 spacing scale.
    expect.soft(padding).toEqual(width <= 1179 ? [24, 24, 24, 24] : [24, 24, 32, 24]);
  });
}

nativeTest("R2-17 zh dark Discover selectors expose matching surfaces and Settings field borders", async ({ page }, info) => {
  await prepare(page); await navigate(page, "discover");
  const surfaces = page.locator(".vx-discover-target .vx-select__surface, .vx-discover-source .vx-select__surface");
  await expect(surfaces).toHaveCount(2);
  await expect(page.locator(".vx-discover-page .vx-select--embedded")).toHaveCount(0);
  const styles = await surfaces.evaluateAll(elements => elements.map(element => {
    const css = getComputedStyle(element);
    return { background: css.backgroundColor, borderColor: css.borderTopColor, borderWidth: css.borderTopWidth,
      borderStyle: css.borderTopStyle, radius: css.borderRadius };
  }));
  await page.screenshot({ path: info.outputPath("discover-fields.png"), scale: "css" });
  expect(styles[0]).toEqual(styles[1]);
  expect(styles[0].background).not.toBe("rgba(0, 0, 0, 0)");
  expect(styles[0].borderWidth).toBe("1px");
  await navigate(page, "settings");
  await page.locator(".vx-settings-nav").getByRole("button", { name: "下载", exact: true }).click();
  await expect(page.locator(".vx-settings-content")).toHaveCSS("opacity", "1");
  const fields = await page.locator(".vx-settings-content").evaluate(element => {
    const read = (node: Element) => { const css = getComputedStyle(node); return { color: css.borderTopColor,
      width: css.borderTopWidth, style: css.borderTopStyle }; };
    return { input: read(element.querySelector("input[type=number]")!), select: read(element.querySelector(".vx-select__surface")!) };
  });
  await page.screenshot({ path: info.outputPath("settings-fields.png"), scale: "css" });
  await writeFile(info.outputPath("field-surfaces.json"), JSON.stringify({ styles, fields }, null, 2));
  expect(fields.input).toEqual(fields.select);
});

nativeTest("R2-14 server entity h2 uses 20px while R2-16 sections use 16px", async ({ page }, info) => {
  nativeTest.setTimeout(120000);
  await prepare(page, 1050, true);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await navigate(page, "multiplayer");
  await expect(page.locator('[data-page-stage="multiplayer"] h1')).toHaveText("Multiplayer");
  const serverTitle = page.locator(".vx-server-row__copy h2");
  await expect(serverTitle).toHaveText("Community Survival & Creative Building Server — Europe West With A Very Long But Valid Name");
  await expect(serverTitle).toBeVisible();
  const server = await serverTitle.evaluate(element => {
    const css = getComputedStyle(element);
    return { text: element.textContent, size: parseFloat(css.fontSize), lineHeight: parseFloat(css.lineHeight),
      height: element.getBoundingClientRect().height };
  });
  await page.screenshot({ path: info.outputPath("en-dark-1050-server-title.png"), scale: "css" });
  expect.soft(server.size).toBe(20);
  expect.soft(server.height).toBeGreaterThan(0);
  expect.soft(server.height).toBeLessThanOrEqual(2 * server.lineHeight);
  await expect(page.locator(".vx-server-inventory > h2")).toHaveCount(1);
  const managedTab = page.getByRole("tab", { name: "Managed servers" });
  const serversTab = page.getByRole("tab", { name: "Servers", exact: true });
  await managedTab.click();
  const managedTitle = page.locator(".vx-managed-overview h2");
  const managedConsole = page.locator(".vx-managed-console h2");
  await expect(managedTitle).toHaveText(server.text!);
  await expect(managedTitle).toBeVisible();
  await expect(managedConsole).toBeVisible();
  const size = (element: Element) => parseFloat(getComputedStyle(element).fontSize);
  const managed = { entity: await managedTitle.evaluate(size), console: await managedConsole.evaluate(size) };
  expect.soft(managed.entity, "the managed server's name is an entity title").toBe(20);
  expect.soft(managed.console, "the console is a section").toBe(16);
  await serversTab.click();
  await expect(serverTitle).toBeVisible();
  const rows = [];
  for (const destination of ["library", "discover", "multiplayer", "downloads", "accounts", "settings"]) {
    await navigate(page, destination);
    rows.push(await page.locator(`[data-page-stage="${destination}"]`).evaluate((stage, pageId) => {
      const shown = (element: Element) => element.checkVisibility({ opacityProperty: true, visibilityProperty: true })
        && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
      const h2 = [...stage.querySelectorAll("h2")].filter(shown).map(element => ({
        text: element.textContent, size: parseFloat(getComputedStyle(element).fontSize),
        role: element.matches(".vx-server-row__copy h2") ? "entity" : "section",
      }));
      const large = [...stage.querySelectorAll("*")].filter(element => shown(element)
        && [...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())
        && parseFloat(getComputedStyle(element).fontSize) === 28).map(element => ({ tag: element.tagName, text: element.textContent }));
      return { page: pageId, h2, large };
    }, destination));
  }
  await navigate(page, "library");
  await page.locator('.vx-instance-card[data-instance-id="long-instance"] .vx-instance-card__select').click();
  await expect(page.locator(".vx-detail-workspace")).toHaveCSS("opacity", "1");
  const detail = await page.locator(".vx-detail-section h2").evaluateAll(elements => elements.map(element => ({
    text: element.textContent, size: parseFloat(getComputedStyle(element).fontSize), lineHeight: parseFloat(getComputedStyle(element).lineHeight),
  })));
  await writeFile(info.outputPath("heading-scale.json"), JSON.stringify({ server, managed, rows, detail }, null, 2));
  for (const row of rows) {
    expect.soft(row.large, `${row.page} 28px text`).toHaveLength(1);
    expect.soft(row.large[0]?.tag, row.page).toBe("H1");
    for (const heading of row.h2) expect.soft(heading.size, `${row.page}/${heading.text}`).toBe(heading.role === "entity" ? 20 : 16);
  }
  expect(detail.length).toBeGreaterThan(0);
  for (const heading of detail) {
    expect.soft(heading.size, `detail/${heading.text}`).toBe(16);
    expect.soft(heading.lineHeight, `detail/${heading.text}`).toBeCloseTo(16 * 1.35, 2);
  }
});

nativeTest("R2-26 unchanged 1920 stress fixture records the full directory-tail budget", async ({ page }, info) => {
  await prepare(page, 1920, true); await navigate(page, "library");
  const result = await page.locator('.vx-instance-card[data-instance-id="long-instance"] .vx-instance-card__path-tail').evaluate(element => ({
    text: element.textContent, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
    maxWidth: getComputedStyle(element).maxWidth, overflow: getComputedStyle(element).textOverflow,
    bounds: element.getBoundingClientRect().toJSON(),
  }));
  await writeFile(info.outputPath("unmodified-stress-tail.json"), JSON.stringify({ ...result, entireTailVisible: result.scrollWidth <= result.clientWidth }, null, 2));
  await page.screenshot({ path: info.outputPath("unmodified-stress-tail.png"), scale: "css" });
  expect(result.text).toBe("christopher-alexander-montgomery-shared-survival-world-with-a-long-directory-name");
  // The unchanged stress fixture deliberately exceeds the retained 70% tail
  // budget. Its measured failure is reported, not disguised with a shorter fixture.
  expect(result.clientWidth).toBeGreaterThan(0);
  expect(result.overflow).toBe("ellipsis");
});

nativeTest("R2-26 common names fit their actual scroll box without line-clamp hiding overflow", async ({ page }, info) => {
  const wrapped = "Western Wilderness Workshop District";
  await prepare(page, 1920, false, { language: "en-US", firstInstanceName: wrapped }); await navigate(page, "library");
  await expect(page.locator('[data-page-stage="library"] h1')).toHaveText("Library");
  const names = await page.locator(".vx-instance-card[data-instance-id] .vx-instance-card__name").evaluateAll(elements => elements.map(element => ({
    text: element.textContent, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight,
    scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
    lineHeight: parseFloat(getComputedStyle(element).lineHeight),
    height: element.getBoundingClientRect().height,
  })));
  await writeFile(info.outputPath("common-name-overflow.json"), JSON.stringify(names, null, 2));
  await page.screenshot({ path: info.outputPath("common-name-overflow.png"), scale: "css" });
  expect(names).toHaveLength(2);
  const twoLine = names.find(name => name.text === wrapped);
  expect(twoLine).toBeDefined();
  expect(twoLine!.height / twoLine!.lineHeight).toBeCloseTo(2, 2);
  for (const name of names) {
    expect(name.scrollHeight, name.text!).toBeLessThanOrEqual(name.clientHeight);
    expect(name.scrollWidth, name.text!).toBeLessThanOrEqual(name.clientWidth);
  }
});

nativeTest("R2-12 browser resolves the same identity ink through the library drill", async ({ page }, info) => {
  await prepare(page); await navigate(page, "library");
  const read = () => page.locator('.vx-instance-identity[data-identity="fixture-world"]').evaluate(element => {
    const css = getComputedStyle(element), probe = document.createElement("span");
    probe.style.color = "var(--text-tertiary)"; document.body.append(probe);
    const expected = getComputedStyle(probe).color; probe.remove();
    return { color: css.color, expected, key: element.getAttribute("data-layout-id"), letter: element.textContent?.trim() };
  });
  const card = await read(); await openFirstInstance(page); const detail = await read();
  await writeFile(info.outputPath("identity-resolved-color.json"), JSON.stringify({ card, detail }, null, 2));
  expect(card.color).toMatch(/^rgb/); expect(card.color).toBe(card.expected);
  expect(detail.color).toBe(detail.expected); expect(detail.color).toBe(card.color);
  expect(card.key).toBe("instance-identity-fixture-world"); expect(detail.key).toBe(card.key);
  expect(detail.letter).toBe(card.letter);
});
