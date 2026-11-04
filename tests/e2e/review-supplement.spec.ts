// SPDX-License-Identifier: GPL-3.0-only
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { installLauncherFixture } from "./fixtures";
import { decodePng } from "./helpers/glass-pixel-probe.mjs";

test.use({ viewport: { width: 1280, height: 720 }, channel: "chromium", launchOptions: {
  args: ["--enable-automation", "--use-angle=d3d11"], ignoreDefaultArgs: ["--enable-unsafe-swiftshader"],
} });

test.afterEach(async ({ page, browser }, info) => {
  const session = await browser.newBrowserCDPSession();
  const commandLine = await session.send("Browser.getBrowserCommandLine");
  await session.detach();
  const runtime = await page.evaluate(() => {
    const world = document.querySelector<HTMLElement>(".world-scene"), canvas = world?.querySelector("canvas");
    const gl = canvas?.getContext("webgl2"), debug = gl?.getExtension("WEBGL_debug_renderer_info");
    return { renderer: debug ? String(gl!.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : null,
      world: { ...world?.dataset }, appearance: { ...document.documentElement.dataset } };
  });
  await writeFile(info.outputPath("browser-runtime.json"), JSON.stringify({ ...runtime,
    version: browser.version(), actualArguments: commandLine.arguments }, null, 2));
  expect(commandLine.arguments).toContain("--use-angle=d3d11");
  expect(commandLine.arguments.filter(argument => /swiftshader/i.test(argument))).toEqual([]);
  if (runtime.renderer) expect(runtime.renderer).toMatch(/Direct3D11|D3D11/);
});

async function navigate(page: Page, name: string) {
  await page.locator(`.vx-floating-nav button[data-page="${name}"]`).click();
  const stage = page.locator(`[data-page-stage="${name}"]`);
  await expect(stage).toHaveCSS("opacity", "1");
  await expect.poll(() => stage.evaluate(element => {
    const transform = getComputedStyle(element).transform;
    return transform === "none" || new DOMMatrixReadOnly(transform).isIdentity;
  })).toBe(true);
}

async function prepare(page: Page, effects: "full" | "lite" = "full") {
  await installLauncherFixture(page, { effects, theme: "dark", instanceCount: 3 });
  await page.goto("/");
  await expect(page.locator(".vx-home")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-world-intro", "off");
  await expect(page.locator("button[data-launch-primary]")).toBeEnabled();
}

type Frame = {
  epochMs: number; rafTimestamp: number | null; opacity: number; display: string; open: boolean | null;
  text: string; mode: "grid" | "list" | null; cards: number;
};
type Trace = { inputEpochMs: number; trusted: boolean; frames: Frame[] };

/** Save unmodified compositor PNGs and associate them with observations of the same native clock. */
async function capture(page: Page, info: TestInfo, label: string, target: string, trigger: string,
  action: () => Promise<unknown>, intermediate: (frame: Frame) => boolean) {
  await expect(page.locator(target)).toHaveCount(1);
  await expect(page.locator(target)).toBeVisible();
  const directory = info.outputPath(label);
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: join(directory, "before.png") });
  const cdp = await page.context().newCDPSession(page);
  const shots: { epochMs: number; data: string }[] = [], acknowledgements: Promise<unknown>[] = [], errors: string[] = [];
  cdp.on("Page.screencastFrame", frame => {
    if (typeof frame.metadata.timestamp === "number") shots.push({ epochMs: frame.metadata.timestamp * 1000, data: frame.data });
    else errors.push("Screencast frame has no native timestamp");
    acknowledgements.push(cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(error => errors.push(String(error))));
  });
  let trace: Trace;
  try {
    await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
    await expect.poll(() => shots.length, { timeout: 5000 }).toBeGreaterThan(0);
    await page.evaluate(({ target, trigger }) => {
      const host = window as unknown as { supplementTrace: Promise<Trace> };
      host.supplementTrace = new Promise(resolve => {
        const clicked = (event: Event) => {
          if (!(event.target instanceof Element) || !event.target.closest(trigger)) return;
          document.removeEventListener("click", clicked, true);
          const start = performance.now();
          const result: Trace = { inputEpochMs: performance.timeOrigin + start, trusted: event.isTrusted, frames: [] };
          const sample = (rafTimestamp: number | null) => {
            const element = document.querySelector<HTMLElement>(target);
            if (!element) return;
            const style = getComputedStyle(element), sheet = element.querySelector(".vx-instance-sheet");
            result.frames.push({ epochMs: performance.timeOrigin + performance.now(), rafTimestamp,
              opacity: Number(style.opacity), display: style.display,
              open: element instanceof HTMLDialogElement ? element.open : null, text: element.textContent ?? "",
              mode: sheet?.classList.contains("vx-instance-sheet--list") ? "list" : sheet?.classList.contains("vx-instance-sheet--grid") ? "grid" : null,
              cards: element.querySelectorAll("article[data-instance-id]").length });
          };
          sample(null);
          const frame = (timestamp: number) => { sample(timestamp); if (performance.now() - start < 500) requestAnimationFrame(frame); else resolve(result); };
          requestAnimationFrame(frame);
        };
        document.addEventListener("click", clicked, true);
      });
    }, { target, trigger });
    await action();
    trace = await page.evaluate(() => (window as unknown as { supplementTrace: Promise<Trace> }).supplementTrace);
  } finally {
    await cdp.send("Page.stopScreencast");
    await Promise.all(acknowledgements);
    await cdp.detach();
  }
  const index = [];
  for (const [number, shot] of shots.entries()) {
    if (shot.epochMs < trace.inputEpochMs) continue;
    const nearest = trace.frames.reduce((best, frame) => Math.abs(frame.epochMs - shot.epochMs) < Math.abs(best.epochMs - shot.epochMs) ? frame : best);
    const deltaMs = Math.abs(nearest.epochMs - shot.epochMs);
    const image = Buffer.from(shot.data, "base64"), decoded = decodePng(image);
    expect(decoded.width).toBe(1280); expect(decoded.height).toBe(720);
    const file = `${String(number).padStart(3, "0")}-${Math.round(shot.epochMs - trace.inputEpochMs)}ms.png`;
    await writeFile(join(directory, file), image);
    index.push({ file, epochMs: shot.epochMs, deltaMs, intermediate: deltaMs < 20 && intermediate(nearest), nearest });
  }
  await page.screenshot({ path: join(directory, "settled.png") });
  await writeFile(join(directory, "trace.json"), JSON.stringify({ ...trace, captured: index, captureErrors: errors }, null, 2));
  expect(errors).toEqual([]);
  expect(trace.trusted, "the recorded transition starts from real input").toBe(true);
  expect(trace.frames.filter(frame => frame.rafTimestamp !== null).length).toBeGreaterThan(2);
  expect(trace.frames.some(intermediate), "real RAF observations contain the requested intermediate state").toBe(true);
  expect(index.some(frame => frame.intermediate), "an actual compositor PNG coincides with an intermediate state").toBe(true);
  return trace;
}

test("supplement: closing the actual project details drawer retains release and dependency content in captured frames", async ({ page }, info) => {
  await installLauncherFixture(page, { theme: "dark", effects: "full", instanceCount: 3 });
  const project = { project_id: "supplement-pack", slug: "supplement-pack", title: "Supplement pack", description: "Drawer close acceptance",
    icon_url: null, downloads: 1200, author: "Fixture author", project_type: "modpack", versions: ["1.21.1"] };
  await page.addInitScript(project => {
    const api = (window as unknown as { __TAURI_INTERNALS__: { invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const original = api.invoke;
    api.invoke = async (name, args) => name === "get_modrinth_project_details" ? { project,
      versions: [{ id: "supplement-release", name: "Supplement release", versionNumber: "1.0", datePublished: "2026-01-01", gameVersions: ["1.21.1"], loaders: ["fabric"], compatible: true }],
      dependencies: [{ projectId: "supplement-dependency", kind: "unknown", name: "Supplement dependency" }],
    } : original(name, args);
  }, project);
  await page.route("https://api.modrinth.com/v2/search?**", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ hits: [project] }) }));
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-world-intro", "off");
  await navigate(page, "discover");
  await page.getByRole("tab", { name: "整合包", exact: true }).click();
  await page.getByRole("button", { name: "查看详情", exact: true }).click();
  const drawer = page.locator(".vx-project-details[open]");
  await expect(drawer).toHaveCSS("opacity", "1");
  await expect(drawer.getByText("Supplement release", { exact: true })).toBeVisible();
  await expect(drawer.getByText("Supplement dependency", { exact: true })).toBeVisible();
  await expect(page.locator(".vx-create-dialog[open]")).toHaveCount(0);
  const trace = await capture(page, info, "drawer-close", ".vx-project-details", ".vx-project-details [data-dialog-close]",
    () => drawer.locator("[data-dialog-close]").click(), frame => frame.open === false && frame.display !== "none" && frame.opacity > .01 && frame.opacity < .99);
  expect(trace.frames.every(frame => frame.text.includes("Supplement release") && frame.text.includes("Supplement dependency"))).toBe(true);
  await expect(page.locator(".vx-project-details")).not.toBeVisible();
});

test("supplement: the actual commandbar switches grid to list and back with captured content intermediates", async ({ page }, info) => {
  await prepare(page); await navigate(page, "library");
  const toolbar = page.locator(".vx-library-commandbar .vx-library-view");
  await expect(toolbar).toBeVisible();
  await expect(page.locator(".vx-instance-sheet--grid article[data-instance-id]")).toHaveCount(3);
  for (const [mode, name, index] of [["list", "列表视图", 2], ["grid", "网格视图", 1]] as const) {
    const trigger = `.vx-library-commandbar .vx-library-view > button:nth-child(${index})`;
    const trace = await capture(page, info, `library-${mode}`, ".vx-library-page > .vx-section-panel", trigger,
      () => toolbar.getByRole("button", { name, exact: true }).click(), frame => frame.mode === mode && frame.opacity > .01 && frame.opacity < .99);
    await expect(toolbar.getByRole("button", { name, exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(`.vx-instance-sheet--${mode} article[data-instance-id]`)).toHaveCount(3);
    expect(trace.frames.filter(frame => frame.mode === mode).every(frame => frame.cards === 3)).toBe(true);
  }
});

for (const mode of ["lite", "reduced-motion", "reduced-transparency", "high-contrast"] as const) {
  test(`supplement: ${mode} home and library screenshots preserve usable controls`, async ({ page }, info) => {
    if (mode === "reduced-motion") await page.emulateMedia({ reducedMotion: "reduce" });
    if (mode === "high-contrast") await page.emulateMedia({ forcedColors: "active" });
    await installLauncherFixture(page, { effects: mode === "lite" ? "lite" : "full", theme: "dark", instanceCount: 3 });
    if (mode === "reduced-transparency") await page.addInitScript(() => {
      const api = (window as unknown as { __TAURI_INTERNALS__: { invoke: (name: string, args?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
      const original = api.invoke;
      api.invoke = async (name, args) => name === "get_system_appearance"
        ? { accentColor: "#b4f17a", animationsEnabled: true, advancedEffectsEnabled: false, locale: "zh-CN" } : original(name, args);
    });
    await page.goto("/");
    const attribute = { lite: "data-effects", "reduced-motion": "data-reduced-motion", "reduced-transparency": "data-reduced-transparency", "high-contrast": "data-high-contrast" }[mode];
    await expect(page.locator("html")).toHaveAttribute(attribute, mode === "lite" ? "lite" : "true");
    await expect(page.locator("html")).toHaveAttribute("data-world-intro", "off");
    await expect(page.locator("button[data-launch-primary]")).toBeEnabled();
    await expect(page.getByRole("combobox", { name: "当前实例", exact: true })).toBeInViewport();
    await expect(page.locator('[data-page-stage="home"]')).toHaveCSS("opacity", "1");
    await expect(page.locator('.vx-character-canvas[data-character-state="ready"]')).toBeVisible();
    await page.screenshot({ path: info.outputPath(`${mode}-home.png`) });
    await navigate(page, "library");
    await expect(page.locator('[data-page-stage="library"]')).toHaveAttribute("data-motion-tier", mode === "lite" || mode === "reduced-transparency" ? "fade" : "none");
    await expect(page.locator(".vx-library-commandbar")).toBeInViewport();
    await expect(page.locator("article[data-instance-id]")).toHaveCount(3);
    await expect(page.locator(".vx-library-commandbar__actions").getByRole("button", { name: "创建实例", exact: true })).toBeEnabled();
    await page.screenshot({ path: info.outputPath(`${mode}-library.png`) });
  });
}

test("supplement: dark 1920 by 1080 home keeps the launch console and character visible", async ({ page }, info) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await prepare(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator(".vx-home__identity")).toBeInViewport();
  await expect(page.locator("button[data-launch-primary]")).toBeInViewport();
  await expect(page.locator(".vx-home__feet")).toBeAttached();
  await expect(page.locator('.vx-character-canvas[data-character-state="ready"]')).toBeVisible();
  await expect(page.locator(".world-scene canvas")).toBeVisible();
  await page.screenshot({ path: info.outputPath("dark-1920-home.png") });
});
