// SPDX-License-Identifier: GPL-3.0-only
import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { installLauncherFixture } from "./fixtures";

test.use({ channel: "chromium", launchOptions: { args: ["--use-angle=d3d11"] },
  deviceScaleFactor: 1, viewport: { width: 1440, height: 930 } });
const project = { project_id: "P7dR8mSH", slug: "fabric-api", title: "Fabric API",
  description: "Synthetic required Fabric API install", icon_url: null, downloads: 1200,
  author: "Fixture", project_type: "mod", versions: ["1.21.1"] };

async function remote(page: Page, gameVersions = ["1.21.1"]) {
  const urls: string[] = [];
  const responseProject = { ...project, versions: gameVersions };
  await page.route("https://api.modrinth.com/v2/search?**", route => {
    urls.push(route.request().url());
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ hits: [responseProject] }) });
  });
  await page.addInitScript(({ project, gameVersions }) => {
    const host = window as unknown as { __TAURI_INTERNALS__: { invoke: (name: string, args?: unknown) => Promise<unknown> } };
    const original = host.__TAURI_INTERNALS__.invoke;
    host.__TAURI_INTERNALS__.invoke = (name, args) => name === "get_modrinth_project_details"
      ? Promise.resolve({ project, dependencies: [], versions: [{ id: "fixture-resource-version", name: "Fabric API",
        versionNumber: "fixture", datePublished: "2026-01-01", gameVersions, loaders: ["fabric"], compatible: false }] })
      : original(name, args);
  }, { project: responseProject, gameVersions });
  return urls;
}

async function open(page: Page) {
  await page.goto("/");
  await page.locator('button[data-page="discover"]').click();
  await expect(page.getByText("Fabric API", { exact: true }).first()).toBeVisible();
}
async function calls(page: Page) {
  return page.evaluate(() => (window as unknown as {
    __appearanceFixtures: { calls: { name: string; args?: Record<string, unknown> }[] };
  }).__appearanceFixtures.calls);
}
const targetDialog = (page: Page) => page.getByRole("dialog", { name: "选择安装位置 · Fabric API", exact: true });
const install = (page: Page) => page.getByRole("button", { name: /^安装 · / }).first().click();

test.afterEach(async ({ page }, info) => {
  const runtime = await page.evaluate(() => {
    const gl = document.querySelector<HTMLCanvasElement>(".world-scene canvas")!.getContext("webgl2")!;
    const debug = gl.getExtension("WEBGL_debug_renderer_info")!;
    return { renderer: String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)), dpr: devicePixelRatio };
  });
  await writeFile(info.outputPath("runtime.json"), JSON.stringify(runtime, null, 2));
  expect(runtime.renderer).toMatch(/D3D11/);
  expect(runtime.renderer).not.toMatch(/swiftshader|software|llvmpipe/i);
  expect(runtime.dpr).toBe(1);
});

for (const versionDirectoryCount of [1, 0]) {
  test(`R3-3 vanilla-only target with ${versionDirectoryCount} installed versions guides one Fabric instance task`, async ({ page }, info) => {
    await installLauncherFixture(page, { noInstances: true, versionDirectoryCount });
    await remote(page); await open(page);
    if (!versionDirectoryCount) {
      await page.getByRole("button", { name: "查看详情", exact: true }).click();
      const details = page.getByRole("dialog", { name: "Fabric API", exact: true });
      await expect(details).toBeVisible();
      await details.getByRole("button", { name: /^安装 · / }).click();
    } else await install(page);
    const dialog = targetDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("新建实例", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("combobox", { name: "游戏版本", exact: true })).toContainText("1.21.1");
    await expect(dialog.getByRole("button", { name: "Fabric", exact: true })).toHaveAttribute("aria-pressed", "true");
    expect((await calls(page)).some(call => call.name === "install_resource")).toBe(false);
    await page.screenshot({ path: info.outputPath("guided-fabric-target.png") });
    const confirm = dialog.getByRole("button", { name: "创建并安装", exact: true });
    await expect(confirm).toBeEnabled(); await confirm.click();
    await expect(page.getByText("资源已安装到新实例。", { exact: true })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "安装到", exact: true })).toContainText("Fabric API");
    const commands = await calls(page);
    const create = commands.find(call => call.name === "create_instance_for_resource");
    expect(create?.args).toMatchObject({ source: "modrinth", projectId: "P7dR8mSH", resourceType: "mod",
      loader: "fabric", gameVersion: "1.21.1", name: "Fabric API" });
    expect(commands.filter(call => call.name === "create_instance_for_resource")).toHaveLength(1);
    expect(commands.filter(call => call.name === "install_resource")).toHaveLength(0);
    await page.screenshot({ path: info.outputPath("created-resource-instance.png") });
  });
}

test("R3-3 compatible Fabric instance is offered while a vanilla instance is selected", async ({ page }, info) => {
  await installLauncherFixture(page, { instances: [
    { id: "vanilla", name: "原版实例", versionId: "1.21.1" },
    { id: "fabric-existing", name: "现有 Fabric 实例", versionId: "fabric-loader-0.16.9-1.21.1", loader: "fabric", loaderVersion: "0.16.9" },
  ] });
  await remote(page); await open(page); await install(page);
  const dialog = targetDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("现有 Fabric 实例", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("radiogroup").getByRole("radio")).toHaveCount(1);
  await expect(dialog.getByText("fabric-loader-0.16.9-1.21.1", { exact: true })).toHaveCount(0);
  await dialog.getByText(/不兼容/).click();
  await expect(dialog.getByText("原版，无法加载模组", { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("existing-targets.png") });
  await dialog.getByRole("button", { name: "安装到 现有 Fabric 实例", exact: true }).click();
  await expect.poll(async () => (await calls(page)).some(call => call.name === "install_resource")).toBe(true);
  const installed = (await calls(page)).find(call => call.name === "install_resource");
  expect(installed?.args).toMatchObject({ instanceId: "fabric-existing", versionId: "fabric-loader-0.16.9-1.21.1" });
  expect((await calls(page)).some(call => call.name === "create_instance_for_resource")).toBe(false);
});

test("R3-3 a selected Fabric target stays one click and searches with real game and loader facets", async ({ page }) => {
  await installLauncherFixture(page, { instanceLoader: "fabric" });
  const urls = await remote(page); await open(page);
  await expect.poll(() => {
    const facets: string[] = JSON.parse(new URL(urls.at(-1)!).searchParams.get("facets") ?? "[]").flat();
    return facets.includes("versions:1.21.1") && facets.includes("categories:fabric");
  }).toBe(true);
  expect(urls.every(url => !decodeURIComponent(url).includes("versions:fabric-loader-"))).toBe(true);
  await install(page);
  await expect.poll(async () => (await calls(page)).some(call => call.name === "install_resource")).toBe(true);
  await expect(targetDialog(page)).toHaveCount(0);
  expect((await calls(page)).some(call => call.name === "create_instance_for_resource")).toBe(false);
});

test("R3-3 review: a compatible Fabric target stays one click while the Mojang manifest is unavailable", async ({ page }) => {
  await installLauncherFixture(page, { instanceLoader: "fabric", resourceManifestUnavailable: true });
  await remote(page); await open(page); await install(page);
  await expect.poll(async () => (await calls(page)).filter(call => call.name === "install_resource").length).toBe(1);
  await expect(targetDialog(page)).toHaveCount(0);
  expect((await calls(page)).some(call => call.name === "create_instance_for_resource")).toBe(false);
});

for (const language of ["zh-CN", "en-US"] as const) {
  test(`R3-3 review ${language}: snapshot-only projects explain the empty plan and retain an external action`, async ({ page }, info) => {
    await installLauncherFixture(page, { language, resourceGameVersions: ["24w20a"] });
    await remote(page, ["24w20a"]); await open(page);
    await page.getByRole("button", { name: language === "en-US" ? /^Install · / : /^安装 · / }).first().click();
    const dialog = page.locator('.vx-install-target');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveCSS("opacity", "1");
    await expect(dialog).toContainText(language === "en-US"
      ? "This project has no installable release game version." : "该项目没有可安装的正式版游戏版本。");
    await expect(dialog.getByRole("button", { name: language === "en-US" ? "Open project page" : "打开项目页面", exact: true })).toBeEnabled();
    await expect(dialog.getByRole("button", { name: language === "en-US" ? "Create and install" : "创建并安装", exact: true })).toHaveCount(0);
    expect((await calls(page)).some(call => ["install_resource", "create_instance_for_resource"].includes(call.name))).toBe(false);
    await page.screenshot({ path: info.outputPath("no-release-target.png") });
  });
}

test("R3-3 cancel during fixture loader stage addresses its own task and registers no instance", async ({ page }, info) => {
  await installLauncherFixture(page, { noInstances: true, resourceCreateDelay: 4000 });
  await remote(page); await open(page); await install(page);
  const dialog = targetDialog(page);
  await dialog.getByRole("button", { name: "创建并安装", exact: true }).click();
  const cancel = dialog.getByRole("button", { name: "取消安装", exact: true });
  await expect(cancel).toBeEnabled(); await cancel.click();
  await expect.poll(async () => (await calls(page)).some(call => call.name === "cancel_download_task")).toBe(true);
  const cancelled = (await calls(page)).find(call => call.name === "cancel_download_task");
  expect(cancelled?.args?.taskId).toMatch(/^fixture-resource-/);
  await page.waitForTimeout(4100);
  const data = await page.evaluate(() => (window as unknown as {
    __TAURI_INTERNALS__: { invoke: (name: string) => Promise<{ instances: unknown[] }> };
  }).__TAURI_INTERNALS__.invoke("bootstrap"));
  expect(data.instances).toHaveLength(0);
  await page.screenshot({ path: info.outputPath("cancelled-target.png") });
});

test("R3-3 Downloads navigation does not cancel the combined install or lose the resulting selection", async ({ page }, info) => {
  await installLauncherFixture(page, { noInstances: true, resourceCreateDelay: 2000 });
  await remote(page); await open(page); await install(page);
  const dialog = targetDialog(page);
  await dialog.getByRole("button", { name: "创建并安装", exact: true }).click();
  await dialog.getByRole("button", { name: "在下载中查看", exact: true }).click();
  await expect(page.locator(".vx-downloads-page")).toBeVisible();
  await page.screenshot({ path: info.outputPath("resource-in-downloads.png") });
  await expect.poll(async () => {
    const tasks = await page.evaluate(() => (window as unknown as { __TAURI_INTERNALS__: {
      invoke: (name: string) => Promise<{ kind: string; status: string }[]> } }).__TAURI_INTERNALS__.invoke("list_download_tasks"));
    return tasks.some(task => task.kind === "resource" && task.status === "completed");
  }).toBe(true);
  expect((await calls(page)).some(call => call.name === "cancel_download_task")).toBe(false);
  await page.locator('button[data-page="discover"]').click();
  await expect(page.getByRole("combobox", { name: "安装到", exact: true })).toContainText("Fabric API");
});

test("R3-3 English progress names the real loader stage in the chooser and Downloads", async ({ page }, info) => {
  await installLauncherFixture(page, { noInstances: true, language: "en-US", resourceCreateDelay: 30000 });
  await remote(page); await open(page);
  await page.getByRole("button", { name: /^Install · / }).first().click();
  const dialog = page.getByRole("dialog", { name: "Choose install location · Fabric API", exact: true });
  await dialog.getByRole("button", { name: "Create and install", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Cancel installation", exact: true })).toBeVisible();
  await expect.soft(dialog).toContainText("Verifying loader libraries", { timeout: 1500 });
  await expect.soft(dialog).toContainText("1 / 3 files", { timeout: 1500 });
  await page.screenshot({ path: info.outputPath("english-install-progress.png") });
  await dialog.getByRole("button", { name: "View in Downloads", exact: true }).click();
  const row = page.locator('.vx-downloads-page [data-task-id^="fixture-resource-"][data-stage="loader-libraries"]');
  await expect(row).toBeVisible();
  await expect.soft(row.locator(".vx-task-row__stage")).toHaveText("Verifying loader libraries", { timeout: 1500 });
  await expect.soft(row).not.toContainText("Unknown stage");
  await page.screenshot({ path: info.outputPath("english-install-downloads.png") });
});
