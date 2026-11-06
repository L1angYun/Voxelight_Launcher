// SPDX-License-Identifier: GPL-3.0-only
import { chromium, expect, test, type Page, type TestInfo } from "@playwright/test";
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
    const gl = document.querySelector<HTMLCanvasElement>(".world-scene canvas")?.getContext("webgl2");
    const debug = gl?.getExtension("WEBGL_debug_renderer_info");
    return { renderer: debug ? String(gl!.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : null,
      dpr: devicePixelRatio, theme: document.documentElement.dataset.theme,
      viewport: { width: innerWidth, height: innerHeight } };
  });
  await writeFile(info.outputPath("runtime.json"), JSON.stringify(runtime, null, 2));
  expect(runtime.renderer).toMatch(/Direct3D11|D3D11/);
  expect(runtime.renderer).not.toMatch(/swiftshader|llvmpipe|software|basic render/i);
  expect(runtime.dpr).toBe(1);
});

async function prepare(page: Page, theme: "dark" | "light", noAccount = false) {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await installLauncherFixture(page, { theme, noAccount });
  await page.addInitScript(() => {
    const host = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown> };
      __appearanceFixtures: { calls: { name: string; args?: Record<string, unknown> }[] };
      __completeProfileSelection?: () => void;
    };
    const original = host.__TAURI_INTERNALS__.invoke;
    host.__TAURI_INTERNALS__.invoke = async (name, args) => {
      if (!["begin_microsoft_login", "poll_microsoft_login", "cancel_auth_login", "login_authlib", "select_authlib_profile"].includes(name)) return original(name, args);
      host.__appearanceFixtures.calls.push({ name, args });
      if (name === "begin_microsoft_login") return { sessionId: "verification-device", userCode: "REVIEW-CODE",
        verificationUri: "https://microsoft.com/devicelogin", expiresIn: 300, interval: 5, message: "Fixture authorization" };
      if (name === "poll_microsoft_login") return { status: "pending", retryAfterSeconds: 5, account: null };
      if (name === "login_authlib") return { status: "selectProfile", sessionId: "verification-profiles", account: null,
        profiles: [{ id: "24b9d391-bb88-449d-9eab-f0591703093b", name: "First_Player_001" },
          { id: "08691b56-494b-4e69-963b-9a79c9a3103c", name: "Second_Player_02" }] };
      if (name === "select_authlib_profile") return new Promise(resolve => { host.__completeProfileSelection = () => resolve(null); });
      return null;
    };
  });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-world-intro", "off");
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await expect(page.locator("html")).toHaveAttribute("data-effects", "full");
  await expect(page.locator("html")).toHaveAttribute("data-reduced-motion", "false");
  await expect(page.locator("html")).toHaveAttribute("data-reduced-transparency", "false");
  await expect(page.locator("html")).toHaveAttribute("data-high-contrast", "false");
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.locator('.vx-floating-nav [data-page="accounts"]').click();
  await expect(page.locator('[data-page-stage="accounts"]')).toHaveCSS("opacity", "1");
}

async function openLogin(page: Page) {
  await page.getByRole("button", { name: "添加账号", exact: true }).click();
  await expect(page.locator(".vx-login-dialog[open]")).toHaveCSS("opacity", "1");
}

async function selectionGeometry(page: Page, info: TestInfo, label: string) {
  await page.evaluate(async () => {
    const mark = document.querySelector<HTMLElement>('.vx-login-dialog[open] [role="tab"][aria-selected="true"] [data-selection-mark]')!;
    let previous = "", stable = 0;
    for (let index = 0; index < 120; index++) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const r = mark.getBoundingClientRect();
      const sample = [r.x, r.y, r.width, r.height].map(value => value.toFixed(2)).join(",");
      if (sample === previous) stable++; else stable = 0;
      if (stable >= 6) return;
      previous = sample;
    }
    throw new Error("Login selection geometry never settled");
  });
  const row = await page.locator(".vx-login-dialog[open]").evaluate(dialog => {
    const tabs = dialog.querySelector('[role="tablist"]')!, tab = tabs.querySelector('[aria-selected="true"]')!;
    const mark = tab.querySelector("[data-selection-mark]")!, panel = dialog.querySelector('[role="tabpanel"]')!;
    const probe = document.createElement("span"); probe.style.backgroundColor = "var(--selection-fill)"; dialog.append(probe);
    const selectionFill = getComputedStyle(probe).backgroundColor; probe.remove();
    return { tab: tab.getBoundingClientRect().toJSON(), mark: mark.getBoundingClientRect().toJSON(),
      tabs: tabs.getBoundingClientRect().toJSON(), panel: panel.getBoundingClientRect().toJSON(),
      background: getComputedStyle(mark).backgroundColor, selectionFill,
      selected: tab.getAttribute("data-tab"), transform: getComputedStyle(mark).transform,
      markAttributes: Object.fromEntries([...mark.attributes].map(attribute => [attribute.name, attribute.value])),
      mode: { ...document.documentElement.dataset } };
  });
  await writeFile(info.outputPath(`${label}.json`), JSON.stringify(row, null, 2));
  await page.screenshot({ path: info.outputPath(`${label}.png`), scale: "css" });
  for (const edge of ["left", "right", "top", "bottom"] as const)
    expect.soft(Math.abs(row.mark[edge] - row.tab[edge]), `${label}: selection ${edge}`).toBeLessThanOrEqual(1);
  expect.soft(row.background, `${label}: shared selection fill`).toBe(row.selectionFill);
  expect.soft(row.panel.top - row.tabs.bottom, `${label}: tabs-to-panel gap`).toBeGreaterThanOrEqual(16);
  return row;
}

async function tracePanelResize(page: Page, info: TestInfo, state: "profiles" | "device", activate: () => Promise<void>) {
  await page.evaluate(state => {
    type Frame = { at: number; active: boolean; edges: number[]; selected: string | null };
    (window as unknown as { __selectionResize: Promise<Frame[]> }).__selectionResize = new Promise(resolve => {
      const rows: Frame[] = [], start = performance.now();
      const frame = () => {
        const dialog = document.querySelector('.vx-login-dialog[open]')!;
        const tab = dialog.querySelector('[role="tab"][aria-selected="true"]')!;
        const mark = tab.querySelector('[data-selection-mark]')!;
        const a = tab.getBoundingClientRect(), b = mark.getBoundingClientRect();
        rows.push({ at: performance.now() - start,
          active: Boolean(dialog.querySelector(state === "profiles" ? ".vx-account-profile-choice" : ".vx-account-device")),
          edges: [b.left - a.left, b.right - a.right, b.top - a.top, b.bottom - a.bottom], selected: tab.getAttribute("data-tab") });
        if (performance.now() - start < 500) requestAnimationFrame(frame); else resolve(rows);
      };
      requestAnimationFrame(frame);
    });
  }, state);
  await activate();
  await expect(page.locator(state === "profiles" ? ".vx-account-profile-choice" : ".vx-account-device").first()).toBeVisible();
  await page.screenshot({ path: info.outputPath(`login-${state}-first-presentation.png`), scale: "css" });
  const frames = await page.evaluate(() => (window as unknown as { __selectionResize: Promise<{ at: number; active: boolean; edges: number[]; selected: string | null }[]> }).__selectionResize);
  await writeFile(info.outputPath(`login-${state}-selection-frames.json`), JSON.stringify(frames, null, 2));
  const affected = frames.filter(frame => frame.active);
  expect(affected.length).toBeGreaterThan(1);
  for (const frame of affected) for (const difference of frame.edges)
    expect.soft(Math.abs(difference), `${state} selected mark remains attached while only panel height changes at ${frame.at.toFixed(1)}ms`).toBeLessThanOrEqual(1);
}

for (const theme of ["dark", "light"] as const) for (const width of [1050, 1440]) {
  nativeTest(`verification login ${theme} ${width}: selected marks, spacing and Authlib states stay inside their controls`, async ({ page }, info) => {
    nativeTest.setTimeout(90000);
    await page.setViewportSize({ width, height: width === 1050 ? 720 : 930 });
    await prepare(page, theme); await openLogin(page);
    await selectionGeometry(page, info, "login-microsoft");
    await page.getByRole("tab", { name: "离线账号", exact: true }).click();
    await selectionGeometry(page, info, "login-offline");
    await page.getByRole("tab", { name: "第三方认证", exact: true }).click();
    await selectionGeometry(page, info, "login-authlib-form");
    await page.getByRole("textbox", { name: "认证服务 API 地址" }).fill("https://auth.example.invalid/api/");
    await page.getByRole("textbox", { name: "用户名或邮箱" }).fill("fixture-user");
    await page.getByLabel("密码", { exact: true }).fill("fixture-password");
    await tracePanelResize(page, info, "profiles", () => page.getByRole("button", { name: "登录第三方账号", exact: true }).click());
    await expect(page.locator(".vx-account-profile-choice")).toHaveCount(2);
    await selectionGeometry(page, info, "authlib-profile-rows");
    const dialog = page.locator(".vx-login-dialog[open]");
    await dialog.getByRole("button", { name: "取消角色选择", exact: true }).focus();
    await page.keyboard.press("Shift+Tab");
    const choice = dialog.locator(".vx-account-profile-choice").last();
    await expect(choice).toBeFocused();
    const focus = await choice.evaluate(element => {
      const css = getComputedStyle(element), bounds = element.getBoundingClientRect();
      const outer = Math.max(0, parseFloat(css.outlineOffset) + parseFloat(css.outlineWidth));
      const clips = [];
      for (let p = element.parentElement; p; p = p.parentElement) {
        const style = getComputedStyle(p), rect = p.getBoundingClientRect();
        if (/hidden|auto|scroll|clip/.test(`${style.overflowX} ${style.overflowY}`)) clips.push({ className: p.className,
          clearance: [bounds.left - rect.left, rect.right - bounds.right, bounds.top - rect.top, rect.bottom - bounds.bottom] });
      }
      return { bounds: bounds.toJSON(), outer, outlineStyle: css.outlineStyle, outlineWidth: css.outlineWidth,
        outlineOffset: css.outlineOffset, color: css.color, clips };
    });
    await writeFile(info.outputPath("authlib-focus.json"), JSON.stringify(focus, null, 2));
    await page.screenshot({ path: info.outputPath("authlib-focus.png"), scale: "css" });
    expect.soft(focus.outlineStyle).toBe("solid"); expect.soft(focus.outlineWidth).toBe("2px");
    expect(focus.clips.length).toBeGreaterThan(0);
    for (const clip of focus.clips) for (const clearance of clip.clearance)
      expect.soft(clearance, `${clip.className}: complete Authlib focus ring`).toBeGreaterThanOrEqual(focus.outer);
    await page.keyboard.press("Enter");
    await expect(choice).toBeDisabled();
    const disabled = await choice.evaluate(element => {
      const probe = document.createElement("span"); probe.style.color = "var(--text-tertiary)"; document.body.append(probe);
      const token = getComputedStyle(probe).color; probe.remove();
      const css = getComputedStyle(element);
      return { color: css.color, token, cursor: css.cursor, opacity: css.opacity };
    });
    await writeFile(info.outputPath("authlib-disabled.json"), JSON.stringify({ beforeColor: focus.color, ...disabled }, null, 2));
    await page.screenshot({ path: info.outputPath("authlib-disabled.png"), scale: "css" });
    expect.soft(disabled.color).toBe(disabled.token); expect.soft(disabled.color).not.toBe(focus.color);
    expect.soft(disabled.opacity).toBe("0.48");
    expect.soft(disabled.cursor).toBe("not-allowed");
    await choice.evaluate(element => (element as HTMLButtonElement).click());
    const calls = await page.evaluate(() => (window as unknown as { __appearanceFixtures: { calls: { name: string }[] } }).__appearanceFixtures.calls);
    expect(calls.filter(call => call.name === "select_authlib_profile")).toHaveLength(1);
    await page.evaluate(() => (window as unknown as { __completeProfileSelection: () => void }).__completeProfileSelection());
    await expect(dialog).toHaveCount(0);
  });
}

nativeTest("verification rapid Authlib completion keeps its selected mark attached while the dialog recenters", async ({ page }, info) => {
  await page.setViewportSize({ width: 1050, height: 720 });
  await prepare(page, "dark"); await openLogin(page);
  await tracePanelResize(page, info, "profiles", async () => {
    await page.getByRole("tab", { name: "第三方认证", exact: true }).click();
    await page.getByRole("textbox", { name: "认证服务 API 地址" }).fill("https://auth.example.invalid/api/");
    await page.getByRole("textbox", { name: "用户名或邮箱" }).fill("fixture-user");
    await page.getByLabel("密码", { exact: true }).fill("fixture-password");
    await page.getByRole("button", { name: "登录第三方账号", exact: true }).click();
  });
  await selectionGeometry(page, info, "rapid-authlib-selection");
});

for (const theme of ["dark", "light"] as const) for (const mode of ["contrast-more", "forced-colors"] as const) {
  nativeTest(`verification Authlib disabled appearance ${theme} ${mode}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1050, height: 720 });
    await prepare(page, theme);
    await page.emulateMedia({ contrast: mode === "contrast-more" ? "more" : "no-preference",
      forcedColors: mode === "forced-colors" ? "active" : "none" });
    await expect(page.locator("html")).toHaveAttribute("data-high-contrast", "true");
    await openLogin(page);
    await page.getByRole("tab", { name: "第三方认证", exact: true }).click();
    await page.getByRole("textbox", { name: "认证服务 API 地址" }).fill("https://auth.example.invalid/api/");
    await page.getByRole("textbox", { name: "用户名或邮箱" }).fill("fixture-user");
    await page.getByLabel("密码", { exact: true }).fill("fixture-password");
    await page.getByRole("button", { name: "登录第三方账号", exact: true }).click();
    const choices = page.locator(".vx-account-profile-choice");
    await expect(choices).toHaveCount(2);
    const before = await choices.evaluateAll(elements => elements.map(element => ({
      color: getComputedStyle(element).color, opacity: getComputedStyle(element).opacity,
    })));
    for (const row of before) expect(row.opacity, "enabled rows retain their full contrast").toBe("1");
    await choices.first().click();
    await expect(choices.first()).toBeDisabled();
    await expect(choices.last()).toBeDisabled();
    const state = await choices.evaluateAll(elements => {
      const sharedButton = document.createElement("button");
      sharedButton.className = "vx-button"; sharedButton.disabled = true; sharedButton.hidden = true;
      const systemProbe = document.createElement("span");
      systemProbe.style.cssText = "color: GrayText; forced-color-adjust: none; display: none";
      document.body.append(sharedButton, systemProbe);
      const sharedOpacity = getComputedStyle(sharedButton).opacity, grayText = getComputedStyle(systemProbe).color;
      sharedButton.remove(); systemProbe.remove();
      return { sharedOpacity, grayText,
        media: { contrastMore: matchMedia("(prefers-contrast: more)").matches, forcedColors: matchMedia("(forced-colors: active)").matches },
        rows: elements.map(element => { const css = getComputedStyle(element); return {
          color: css.color, opacity: css.opacity, cursor: css.cursor, forcedColorAdjust: css.forcedColorAdjust,
          titleColor: getComputedStyle(element.querySelector("strong")!).color,
          detailColor: getComputedStyle(element.querySelector("small")!).color,
        }; }) };
    });
    await writeFile(info.outputPath("authlib-disabled-accessibility.json"), JSON.stringify({ theme, mode, before, ...state }, null, 2));
    await page.screenshot({ path: info.outputPath("authlib-disabled-accessibility.png"), scale: "css" });
    expect(state.media.contrastMore).toBe(mode === "contrast-more");
    expect(state.media.forcedColors).toBe(mode === "forced-colors");
    for (const row of state.rows) {
      expect.soft(row.cursor).toBe("not-allowed");
      if (mode === "contrast-more") {
        expect.soft(state.sharedOpacity).toBe("0.48");
        expect.soft(row.opacity, "profile rows use the shared Button disabled opacity even when high-contrast colors collapse").toBe(state.sharedOpacity);
      } else {
        expect.soft(row.forcedColorAdjust).toBe("auto");
        expect.soft(row.opacity, "system disabled text stays at its native opacity").toBe("1");
        for (const color of [row.color, row.titleColor, row.detailColor]) expect.soft(color).toBe(state.grayText);
      }
    }
  });
}

nativeTest("verification login manual tabs return to the selected device-code tab without cancelling", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 930 });
  await prepare(page, "light"); await openLogin(page);
  await page.getByRole("textbox", { name: "本项目的 Microsoft Client ID" }).fill("fixture-client-id");
  await tracePanelResize(page, info, "device", () => page.getByRole("button", { name: "开始 Microsoft 登录", exact: true }).click());
  await expect(page.getByText("REVIEW-CODE", { exact: true })).toBeVisible();
  const microsoft = page.getByRole("tab", { name: "Microsoft", exact: true });
  const offline = page.getByRole("tab", { name: "离线账号", exact: true });
  await microsoft.focus(); await page.keyboard.press("ArrowRight");
  await expect(offline).toBeFocused(); await expect(microsoft).toHaveAttribute("tabindex", "0");
  await expect(offline).toHaveAttribute("tabindex", "-1");
  await page.keyboard.press("Tab");
  await expect(page.locator(".vx-account-device .vx-button--primary")).toBeFocused();
  await page.keyboard.press("Shift+Tab"); await expect(microsoft).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByText("REVIEW-CODE", { exact: true })).toBeVisible();
  const cancelled = await page.evaluate(() => (window as unknown as { __appearanceFixtures: { calls: { name: string }[] } }).__appearanceFixtures.calls.filter(call => call.name === "cancel_auth_login").length);
  expect(cancelled).toBe(0);
  await selectionGeometry(page, info, "login-manual-focus");
});

nativeTest("verification zh empty accounts uses account wording", async ({ page }, info) => {
  await page.setViewportSize({ width: 1050, height: 720 });
  await prepare(page, "light", true);
  await expect(page.locator(".vx-account-list").getByRole("heading", { name: "还没有账号", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "角色", exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("zh-empty-accounts.png"), scale: "css" });
});
