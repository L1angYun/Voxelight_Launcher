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
    const world = document.querySelector<HTMLCanvasElement>(".world-scene canvas");
    const canvas = world ?? document.createElement("canvas");
    const gl = canvas.getContext("webgl2")!, debug = gl.getExtension("WEBGL_debug_renderer_info")!;
    const renderer = String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL));
    if (!world) gl.getExtension("WEBGL_lose_context")?.loseContext();
    return { renderer, source: world ? "launcher-world" : "isolated-component-renderer-probe", dpr: devicePixelRatio,
      theme: document.documentElement.dataset.theme, viewport: { width: innerWidth, height: innerHeight } };
  });
  await writeFile(info.outputPath("runtime.json"), JSON.stringify(runtime, null, 2));
  expect(runtime.renderer).toMatch(/Direct3D11|D3D11/);
  expect(runtime.renderer).not.toMatch(/swiftshader|llvmpipe|software|basic render/i);
  expect(runtime.dpr).toBe(1);
});

const profiles = [
  { id: "24b9d391-bb88-449d-9eab-f0591703093b", name: "First_Player_001" },
  { id: "08691b56-494b-4e69-963b-9a79c9a3103c", name: "Second_Player_02" },
];
async function authlibSelection(page: Page) {
  await installLauncherFixture(page);
  await page.addInitScript(profiles => {
    const host = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown> };
      __appearanceFixtures: { calls: { name: string; args?: Record<string, unknown> }[] };
    };
    const invoke = host.__TAURI_INTERNALS__.invoke;
    host.__TAURI_INTERNALS__.invoke = async (name, args) => {
      if (name === "login_authlib" || name === "select_authlib_profile") {
        host.__appearanceFixtures.calls.push({ name, args });
        return name === "login_authlib" ? { status: "selectProfile", sessionId: "full-uuid-session", profiles, account: null } : null;
      }
      return invoke(name, args);
    };
  }, profiles);
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-world-intro", "off");
  await page.locator('.vx-floating-nav [data-page="accounts"]').click();
  await expect(page.locator('[data-page-stage="accounts"]')).toHaveCSS("opacity", "1");
  await page.getByRole("button", { name: "添加账号", exact: true }).click();
  await page.getByRole("tab", { name: "第三方认证", exact: true }).click();
  await page.getByRole("textbox", { name: "认证服务 API 地址" }).fill("https://auth.example.invalid/api/");
  await page.getByRole("textbox", { name: "用户名或邮箱" }).fill("fixture-user");
  await page.getByLabel("密码", { exact: true }).fill("fixture-password");
  await page.getByRole("button", { name: "登录第三方账号", exact: true }).click();
  await expect(page.locator(".vx-account-profiles button")).toHaveCount(2);
  await expect(page.locator(".vx-dialog[open]")).toHaveCSS("opacity", "1");
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

for (const width of [1050, 1440]) {
  nativeTest(`R2-05 Authlib ${width}: full UUID profile rows contain both lines without overlap`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 1050 ? 720 : 930 });
    await authlibSelection(page);
    const rows = await page.locator(".vx-account-profiles button").evaluateAll(elements => elements.map(element => {
      const textRect = (selector: string) => {
        const target = element.querySelector(selector)!;
        const range = document.createRange(); range.selectNodeContents(target);
        return { text: target.textContent, bounds: range.getBoundingClientRect().toJSON() };
      };
      const css = getComputedStyle(element), bounds = element.getBoundingClientRect();
      const content = { top: bounds.top + parseFloat(css.borderTopWidth) + parseFloat(css.paddingTop),
        bottom: bounds.bottom - parseFloat(css.borderBottomWidth) - parseFloat(css.paddingBottom) };
      return { bounds: bounds.toJSON(), content, name: textRect("strong"), uuid: textRect("small"),
        scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, className: element.className };
    }));
    await page.screenshot({ path: info.outputPath("authlib-profile-rows.png"), scale: "css" });
    await writeFile(info.outputPath("authlib-profile-rows.json"), JSON.stringify(rows, null, 2));
    for (const [index, row] of rows.entries()) {
      expect(row.name.text).toBe(profiles[index].name); expect(row.uuid.text).toBe(profiles[index].id);
      expect.soft(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
      for (const text of [row.name, row.uuid]) {
        expect.soft(text.bounds.top, `${text.text} above row`).toBeGreaterThanOrEqual(row.bounds.top - 1);
        expect.soft(text.bounds.bottom, `${text.text} below row`).toBeLessThanOrEqual(row.bounds.bottom + 1);
        expect.soft(text.bounds.left).toBeGreaterThanOrEqual(row.bounds.left - 1);
        expect.soft(text.bounds.right).toBeLessThanOrEqual(row.bounds.right + 1);
        expect.soft(text.bounds.top, `${text.text} exceeds padded content top`).toBeGreaterThanOrEqual(row.content.top - 1);
        expect.soft(text.bounds.bottom, `${text.text} exceeds padded content bottom`).toBeLessThanOrEqual(row.content.bottom + 1);
      }
      expect.soft(row.name.bounds.bottom).toBeLessThanOrEqual(row.uuid.bounds.top + 1);
      if (index) {
        expect.soft(rows[index - 1].bounds.bottom).toBeLessThanOrEqual(row.bounds.top);
        expect.soft(rows[index - 1].uuid.bounds.bottom).toBeLessThanOrEqual(row.name.bounds.top);
      }
    }
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    await page.getByRole("button", { name: new RegExp(profiles[1].name) }).click();
    const calls = await page.evaluate(() => (window as unknown as { __appearanceFixtures: {
      calls: { name: string; args?: Record<string, unknown> }[] } }).__appearanceFixtures.calls);
    expect(calls.some(call => call.name === "select_authlib_profile" && call.args?.sessionId === "full-uuid-session"
      && call.args.profileId === profiles[1].id)).toBe(true);
  });
}

for (const theme of ["dark", "light"] as const) {
  nativeTest(`R2-04 project ${theme}: selected hover uses only the frame and retains text weights`, async ({ page }, info) => {
    await page.goto(`/tests/e2e/harness/project-selection.html?theme=${theme}`);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const card = page.locator(".vx-project-card"), details = card.locator(".vx-button--ghost");
    const sample = () => card.evaluate(element => {
      const css = getComputedStyle(element), frame = element.querySelector<HTMLElement>(":scope > .vx-lattice-frame")!;
      const weight = (selector: string) => getComputedStyle(element.querySelector(selector)!).fontWeight;
      return { fill: css.backgroundColor, weight: css.fontWeight, shadow: css.boxShadow,
        title: weight("h3"), author: weight(".vx-project-card__identity > span"),
        description: weight(".vx-project-card__description"), meta: weight(".vx-project-card__meta"),
        frame: { selected: frame.dataset.selected, border: getComputedStyle(frame).borderStyle, opacity: getComputedStyle(frame).opacity } };
    });
    await page.mouse.move(1000, 700); const selected = await sample();
    await card.hover(); const hovered = await sample();
    await page.screenshot({ path: info.outputPath("project-selected-hover.png"), scale: "css" });
    await expect.soft(card).not.toHaveAttribute("aria-current", /.+/);
    await expect.soft(details).toHaveAttribute("aria-current", "true");
    await details.focus(); await page.keyboard.press("Enter");
    await expect(page.locator("#open-count")).toHaveText("1");
    await page.locator("#toggle-selected").click(); await page.mouse.move(1000, 700); const unselected = await sample();
    await writeFile(info.outputPath("project-selection.json"), JSON.stringify({ selected, hovered, unselected }, null, 2));
    for (const row of [selected, hovered]) {
      expect.soft(row.fill).toBe("rgba(0, 0, 0, 0)"); expect.soft(row.shadow).toBe("none");
      expect.soft(row.title).toBe("600");
      for (const weight of [row.weight, row.author, row.description, row.meta]) expect.soft(weight).toBe("400");
      expect.soft(row.frame).toEqual({ selected: "true", border: "dotted", opacity: "1" });
    }
    expect(unselected.fill).toBe(selected.fill); await expect(details).not.toHaveAttribute("aria-current", /.+/);
  });
}
