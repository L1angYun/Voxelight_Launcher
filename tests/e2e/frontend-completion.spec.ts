import { expect, test, type Page } from "@playwright/test";
import { installLauncherFixture } from "./fixtures";
import { writeFile } from "node:fs/promises";

test.use({ viewport: { width: 1280, height: 720 }, channel: "chromium", launchOptions: { args: ["--enable-automation", "--use-angle=d3d11"], ignoreDefaultArgs: ["--enable-unsafe-swiftshader"] } });

test.afterEach(async ({ page, browser }, info) => {
  const session = await browser.newBrowserCDPSession();
  const commandLine = await session.send("Browser.getBrowserCommandLine");
  await session.detach();
  const renderer = await page.evaluate(() => {
    for (const canvas of document.querySelectorAll("canvas")) {
      const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
      if (!gl) continue;
      const debug = gl.getExtension("WEBGL_debug_renderer_info");
      if (debug) return String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL));
    }
    return "No WebGL context";
  }).catch(() => "Page unavailable");
  await writeFile(info.outputPath("browser-runtime.json"), JSON.stringify({ renderer, version: browser.version(), channel: "chromium", actualArguments: commandLine.arguments }, null, 2));
});

const project = {
  project_id: "fixture-pack", slug: "fixture-pack", title: "Fixture pack", description: "A complete drawer snapshot",
  icon_url: null, downloads: 1200, author: "Fixture author", project_type: "modpack", versions: ["1.21.1"],
};

async function prepare(page: Page, options: { bootstrapFailure?: boolean; noAccount?: boolean } = {}) {
  await installLauncherFixture(page, { noAccount: options.noAccount, effects: "full", instanceCount: 2 });
  await page.addInitScript(({ project, bootstrapFailure }) => {
    const fixtureWindow = window as unknown as {
      __frontendCompletion: { bootstrapFailure: boolean };
      __TAURI_INTERNALS__: { invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown> };
    };
    fixtureWindow.__frontendCompletion = { bootstrapFailure: Boolean(bootstrapFailure) };
    const original = fixtureWindow.__TAURI_INTERNALS__.invoke;
    fixtureWindow.__TAURI_INTERNALS__.invoke = async (name, args) => {
      if (name === "bootstrap" && fixtureWindow.__frontendCompletion.bootstrapFailure) throw { code: "internal.unexpected" };
      if (name === "get_modrinth_project_details") return {
        project,
        versions: [{ id: "v1", name: "Fixture release", versionNumber: "1.0", datePublished: "2026-01-01", gameVersions: ["1.21.1"], loaders: ["fabric"], compatible: true }],
        dependencies: [{ projectId: "dep", kind: "unknown", name: "Fixture dependency" }],
      };
      if (name === "list_modpack_versions") return [{ id: "pack-v1", name: "Pack release", versionNumber: "1.0", gameVersions: ["1.21.1"], loaders: ["fabric"], datePublished: "2026-01-01" }];
      if (name === "install_modrinth_modpack") throw { code: "internal.unexpected" };
      if (name === "list_loader_versions") return [{ id: "0.16.9", stable: true, recommended: true }];
      return original(name, args);
    };
  }, { project, bootstrapFailure: options.bootstrapFailure });
  await page.route("https://api.modrinth.com/v2/search?**", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ hits: [project] }) }));
  await page.goto("/?next-ui");
  await expect(page.locator(".vx-home")).toBeVisible();
}

async function navigate(page: Page, destination: string) {
  await page.locator(`.vx-floating-nav button[data-page="${destination}"]`).click();
  await expect(page.locator(`[data-page-stage="${destination}"]`)).toBeVisible();
  await expect(page.locator(`[data-page-stage="${destination}"]`)).toHaveCSS("opacity", "1");
  await expect.poll(() => page.locator(`[data-page-stage="${destination}"]`).evaluate((element) => {
    const transform = getComputedStyle(element).transform;
    return transform === "none" || new DOMMatrixReadOnly(transform).isIdentity;
  })).toBe(true);
}

async function sampleDialog(page: Page, selector: string, duration = 400) {
  return page.evaluate(async ({ selector, duration }) => {
    const frames: { opacity: number; open: boolean; display: string; text: string }[] = [];
    await new Promise<void>((resolve) => {
      let start: number;
      function tick() {
        const dialog = document.querySelector<HTMLDialogElement>(selector);
        if (dialog) {
          const style = getComputedStyle(dialog);
          frames.push({ opacity: Number(style.opacity), open: dialog.open, display: style.display, text: dialog.textContent ?? "" });
        }
        if (performance.now() - start < duration) requestAnimationFrame(tick); else resolve();
      }
      document.addEventListener("click", () => { start = performance.now(); requestAnimationFrame(tick); }, { once: true, capture: true });
    });
    return frames;
  }, { selector, duration });
}

test("completion: bootstrap failure keeps the app usable and retry restores its data", async ({ page }) => {
  await prepare(page, { bootstrapFailure: true });
  await expect(page.locator(".vx-bootstrap-error")).toBeVisible();
  await page.evaluate(() => { (window as unknown as { __frontendCompletion: { bootstrapFailure: boolean } }).__frontendCompletion.bootstrapFailure = false; });
  await page.locator(".vx-bootstrap-error").getByRole("button").click();
  await expect(page.locator(".vx-bootstrap-error")).toHaveCount(0);
  await navigate(page, "library");
  await expect(page.locator("article[data-instance-id]")).toHaveCount(2);
});

test("completion: scrolled content stays below the floating navigation at minimum size", async ({ page }, info) => {
  await page.setViewportSize({ width: 1050, height: 720 });
  await installLauncherFixture(page, { instanceCount: 30 });
  await page.goto("/");
  await navigate(page, "library");
  const main = page.locator("#main-content");
  await main.evaluate(element => { element.scrollTop = element.scrollHeight / 2; });
  expect(await main.evaluate(element => element.scrollTop)).toBeGreaterThan(100);
  const viewport = await main.boundingBox();
  const navigation = await page.locator(".vx-window-chrome__bar").boundingBox();
  expect(viewport!.y).toBeGreaterThanOrEqual(navigation!.y + navigation!.height);
  await page.screenshot({ path: info.outputPath("scrolled-library-below-navigation.png") });
  await page.locator("article[data-instance-id] .vx-instance-card__select").last().click();
  await expect(page.locator(".vx-detail-header h1")).toBeFocused();
  const heading = await page.locator(".vx-detail-header h1").boundingBox();
  expect(heading!.y).toBeGreaterThanOrEqual(navigation!.y + navigation!.height);
});

test("completion: the first home intro frame leaves launch and navigation visible", async ({ page }, info) => {
  await page.addInitScript(() => {
    const probe = window as unknown as { __firstHomeVisibility?: { launch: boolean; navigation: boolean[]; stageOpacity?: string } };
    const observer = new MutationObserver(() => {
      if (probe.__firstHomeVisibility || document.documentElement?.dataset.worldIntro !== "on") return;
      const launch = document.querySelector<HTMLElement>("button[data-launch-primary]");
      const navigation = [...document.querySelectorAll<HTMLElement>(".vx-floating-nav button[data-page]")];
      if (!launch || navigation.length < 7) return;
      const stage = document.querySelector('[data-page-stage="home"]');
      probe.__firstHomeVisibility = {
        launch: launch.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
        navigation: navigation.map((item) => item.checkVisibility({ opacityProperty: true, visibilityProperty: true })),
        stageOpacity: stage ? getComputedStyle(stage).opacity : undefined,
      };
      observer.disconnect();
    });
    observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-world-intro", "style", "class"] });
  });
  await prepare(page);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __firstHomeVisibility?: unknown }).__firstHomeVisibility)).toBeTruthy();
  const measured = await page.evaluate(() => (window as unknown as { __firstHomeVisibility: { launch: boolean; navigation: boolean[]; stageOpacity?: string } }).__firstHomeVisibility);
  await writeFile(info.outputPath("first-home-visibility.json"), JSON.stringify(measured, null, 2));
  expect(measured.launch).toBe(true);
  expect(measured.navigation.every(Boolean)).toBe(true);
});

test("completion: library launch failure has one global toast that follows a native dialog", async ({ page }) => {
  await prepare(page, { noAccount: true });
  await navigate(page, "library");
  await page.locator("article[data-instance-id] [data-launch]").first().click();
  await expect(page.locator(".vx-toast[role=alert]")).toHaveCount(1);
  await page.locator(".vx-library-commandbar__actions").getByRole("button", { name: "创建实例", exact: true }).click();
  await expect(page.locator("dialog[open] .vx-toast[role=alert]")).toHaveCount(1);
  await page.locator("dialog[open] [data-dialog-close]").click();
  await expect(page.locator(".vx-toast-root .vx-toast[role=alert]")).toHaveCount(1);
});

test("completion: shared selection slides within its own group", async ({ page }, info) => {
  await prepare(page);
  await navigate(page, "library");
  const source = await page.locator(".vx-library-scope [data-selection-mark]").boundingBox();
  const independent = await page.locator(".vx-library-view [data-selection-mark]").boundingBox();
  expect(source).not.toBeNull();
  const sampled = page.evaluate(async () => {
    const frames: { x: number; otherX: number }[] = [];
    await new Promise<void>((resolve) => {
      let start: number;
      function tick() {
        const mark = document.querySelector(".vx-library-scope [data-selection-mark]");
        const other = document.querySelector(".vx-library-view [data-selection-mark]");
        if (mark && other) frames.push({ x: mark.getBoundingClientRect().x, otherX: other.getBoundingClientRect().x });
        if (performance.now() - start < 650) requestAnimationFrame(tick); else resolve();
      }
      document.addEventListener("click", () => { start = performance.now(); requestAnimationFrame(tick); }, { once: true, capture: true });
    });
    return frames;
  });
  await page.locator(".vx-library-scope").getByRole("button", { name: "版本目录", exact: true }).click();
  const frames = await sampled;
  const destination = await page.locator(".vx-library-scope [data-selection-mark]").boundingBox();
  const low = Math.min(source!.x, destination!.x), high = Math.max(source!.x, destination!.x);
  await info.attach("selection-geometry", { body: JSON.stringify({ source, independent, destination, frames }), contentType: "application/json" });
  await writeFile(info.outputPath("selection-geometry.json"), JSON.stringify({ source, independent, destination, frames }, null, 2));
  expect(high - low).toBeGreaterThan(20);
  expect(frames.filter((frame) => frame.x > low + 1 && frame.x < high - 1).length).toBeGreaterThan(1);
  expect(frames.every((frame) => Math.abs(frame.otherX - independent!.x) < 1)).toBe(true);
});

for (const width of [1280, 1050]) {
test(`completion: create tabs preserve native focus order, stable height and overlay intermediates at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 720 });
  await prepare(page);
  await navigate(page, "library");
  const opening = sampleDialog(page, ".vx-create-dialog");
  await page.locator(".vx-library-commandbar__actions").getByRole("button", { name: "创建实例", exact: true }).click();
  const frames = await opening;
  await info.attach("dialog-enter", { body: JSON.stringify(frames), contentType: "application/json" });
  await writeFile(info.outputPath("dialog-enter.json"), JSON.stringify(frames, null, 2));
  expect(frames.some((frame) => frame.open && frame.opacity > 0 && frame.opacity < 1)).toBe(true);
  const dialog = page.locator(".vx-create-dialog[open]");
  const before = await dialog.boundingBox();
  expect(before!.y).toBeGreaterThanOrEqual(24);
  expect(before!.y + before!.height).toBeLessThanOrEqual(696);
  const tabs = dialog.getByRole("tab");
  await tabs.first().focus();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("group").first().getByRole("button").first()).toBeFocused();
  await tabs.first().focus();
  await page.keyboard.press("ArrowRight");
  await expect(tabs.nth(1)).toBeFocused();
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  const imported = await dialog.boundingBox();
  expect(Math.abs(imported!.height - before!.height)).toBeLessThanOrEqual(1);
  await page.keyboard.press("Home");
  await dialog.getByRole("button", { name: "Fabric", exact: true }).click();
  await expect(dialog.getByRole("combobox", { name: "加载器版本", exact: true })).toBeEnabled();
  expect(Math.abs((await dialog.boundingBox())!.height - before!.height)).toBeLessThanOrEqual(1);
});
}

test("completion: nested install feedback stays above the top dialog and closing preserves drawer content", async ({ page }, info) => {
  await prepare(page);
  await navigate(page, "discover");
  await page.getByRole("tab", { name: "整合包", exact: true }).click();
  await page.getByRole("button", { name: "查看详情", exact: true }).click();
  const drawer = page.locator(".vx-project-details[open]");
  await expect(drawer.getByText("Fixture release", { exact: true })).toBeVisible();
  await drawer.locator(".vx-dialog__footer").getByRole("button", { name: /^安装/ }).click();
  const create = page.locator(".vx-create-dialog[open]");
  await expect(create).toBeVisible();
  await create.locator(".vx-dialog__footer").getByRole("button").click();
  await expect(create.locator(".vx-toast[role=alert]")).toHaveCount(1);
  await expect(page.locator(".vx-toast")).toHaveCount(1);
  await create.locator("[data-dialog-close]").click();
  await writeFile(info.outputPath("nested-after-close.json"), JSON.stringify(await page.locator("dialog").evaluateAll((dialogs) => dialogs.map((dialog) => ({ open: (dialog as HTMLDialogElement).open, modal: dialog.matches(":modal"), className: dialog.className, hasToast: Boolean(dialog.querySelector(".vx-toast")) }))), null, 2));
  await expect(drawer.locator(".vx-toast[role=alert]")).toHaveCount(1);
  const closing = sampleDialog(page, ".vx-project-details", 220);
  await drawer.locator("[data-dialog-close]").click();
  const frames = await closing;
  await info.attach("drawer-close", { body: JSON.stringify(frames), contentType: "application/json" });
  await writeFile(info.outputPath("drawer-close.json"), JSON.stringify(frames, null, 2));
  expect(frames.some((frame) => !frame.open && frame.display !== "none" && frame.opacity > 0 && frame.opacity < 1)).toBe(true);
  expect(frames.every((frame) => frame.text.includes("Fixture release") && frame.text.includes("Fixture dependency"))).toBe(true);
  await expect(page.locator(".vx-project-details")).not.toBeVisible();
  await expect(page.locator(".vx-toast-root .vx-toast")).toHaveCount(1);
});

test("completion: reduced motion keeps selection visible and section opacity immediate", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await prepare(page);
  await navigate(page, "settings");
  await page.locator(".vx-settings-nav").getByRole("button", { name: "外观", exact: true }).click();
  await expect(page.locator(".vx-settings-nav [data-selection-mark]")).toBeVisible();
  await expect(page.locator(".vx-settings-content")).toHaveCSS("opacity", "1");
  await expect(page.locator(".vx-settings-content")).toHaveCSS("transition-duration", "0s");
});
