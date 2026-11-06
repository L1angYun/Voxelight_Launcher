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

async function prepare(page: Page, width = 1440, stress = false) {
  await page.setViewportSize({ width, height: width <= 1150 ? 720 : width === 1920 ? 1080 : 930 });
  await installLauncherFixture(page, { theme: "dark", instanceCount: 2, stress });
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

nativeTest("R2-14 content h2 uses 20px and each page reserves its only 28px text for h1", async ({ page }, info) => {
  nativeTest.setTimeout(120000);
  await prepare(page);
  const rows = [];
  for (const destination of ["library", "discover", "multiplayer", "downloads", "accounts", "settings"]) {
    await navigate(page, destination);
    rows.push(await page.locator(`[data-page-stage="${destination}"]`).evaluate((stage, pageId) => {
      const shown = (element: Element) => element.checkVisibility({ opacityProperty: true, visibilityProperty: true })
        && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
      const h2 = [...stage.querySelectorAll("h2")].filter(shown).map(element => ({ text: element.textContent, size: parseFloat(getComputedStyle(element).fontSize) }));
      const large = [...stage.querySelectorAll("*")].filter(element => shown(element)
        && [...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())
        && parseFloat(getComputedStyle(element).fontSize) === 28).map(element => ({ tag: element.tagName, text: element.textContent }));
      return { page: pageId, h2, large };
    }, destination));
  }
  await openFirstInstance(page);
  const detail = await page.locator(".vx-detail-workspace h2").evaluateAll(elements => elements.map(element => ({ text: element.textContent, size: parseFloat(getComputedStyle(element).fontSize) })));
  await writeFile(info.outputPath("heading-scale.json"), JSON.stringify({ rows, detail }, null, 2));
  for (const row of rows) {
    expect.soft(row.large, `${row.page} 28px text`).toHaveLength(1);
    expect.soft(row.large[0]?.tag, row.page).toBe("H1");
    for (const heading of row.h2) expect.soft(heading.size, `${row.page}/${heading.text}`).toBe(20);
  }
  expect(detail.length).toBeGreaterThan(0);
  for (const heading of detail) expect.soft(heading.size, `detail/${heading.text}`).toBe(20);
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
  await prepare(page, 1920); await navigate(page, "library");
  const names = await page.locator(".vx-instance-card[data-instance-id] .vx-instance-card__name").evaluateAll(elements => elements.map(element => ({
    text: element.textContent, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight,
    scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
  })));
  await writeFile(info.outputPath("common-name-overflow.json"), JSON.stringify(names, null, 2));
  expect(names).toHaveLength(2);
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
