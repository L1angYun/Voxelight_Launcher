import { expect, test } from "@playwright/test";
import { installLauncherFixture } from "./fixtures";
import { selectValue } from "./select-helpers";

const project = {
  project_id: "sodium",
  slug: "sodium",
  title: "Sodium",
  description: "Rendering optimization",
  icon_url: null,
  downloads: 1200,
  author: "Author",
  project_type: "mod",
  versions: ["1.21.1"],
};
const details = {
  project,
  versions: [{ id: "v1", name: "1.0", versionNumber: "1.0", datePublished: "2026-01-01", gameVersions: ["1.21.1"], loaders: ["fabric"], compatible: true }],
  dependencies: [{ projectId: "dep", kind: "unknown", name: null }],
};

function mockRemote(page: import("@playwright/test").Page) {
  return page.addInitScript((details) => {
    const internals = (window as unknown as {
      __TAURI_INTERNALS__: {
        invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
      };
    }).__TAURI_INTERNALS__;
    const original = internals.invoke;
    internals.invoke = async (name, args) => {
      const record = (result: unknown) => {
        (window as unknown as {
          __appearanceFixtures: {
            calls: { name: string; args?: Record<string, unknown> }[];
          };
        }).__appearanceFixtures.calls.push({ name, args });
        return result;
      };
      if (name === "get_modrinth_project_details" || name === "get_curseforge_project_details") return record(details);
      if (name === "search_curseforge") return record({ hits: [details.project] });
      if (name === "install_resource" || name === "install_curseforge_resource") return record({ name: "Sodium", fileName: "sodium.jar", path: "fixture/sodium.jar" });
      if (name === "list_modpack_versions") return record([{ id: "pack-1", name: "Pack 1", versionNumber: "1.0", gameVersions: ["1.21.1"], loaders: ["fabric"], datePublished: "2026-01-01" }]);
      if (name === "install_modrinth_modpack") return record({ instance: { id: "pack-instance", name: "Pack 1", versionId: "1.21.1", gameDirectory: "C:\\SyntheticFixture\\pack", createdAt: "2026-01-01", category: "", notes: "", totalPlayTime: 0, loader: "fabric", loaderVersion: "0.16.9" }, warnings: [] });
      return original(name, args);
    };
  }, details);
}

test("discovery shows real details, installs into the selected instance, and switches source", async ({ page }) => {
  await installLauncherFixture(page);
  await mockRemote(page);
  await page.route("https://api.modrinth.com/v2/search?**", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ hits: [project] }) });
  });
  await page.goto("/?next-ui");
  await page.getByRole("button", { name: "探索", exact: true }).click();
  await expect(page.getByText("Sodium", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "查看详情", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Sodium", exact: true })).toBeVisible();
  await expect(page.getByText("1.0", { exact: true })).toBeVisible();
  await expect(page.getByText("未知关系", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "安装 · 合成测试世界", exact: true }).last().click();
  const calls = await page.evaluate(() => (window as unknown as { __appearanceFixtures: { calls: { name: string; args?: Record<string, unknown> }[] } }).__appearanceFixtures.calls);
  expect(calls.some((call) => call.name === "install_resource" && call.args?.projectId === "sodium" && call.args?.instanceId === "fixture-world")).toBe(true);
  await page.getByRole("dialog", { name: "Sodium", exact: true }).getByRole("button", { name: "关闭", exact: true }).click();
  await selectValue(page, "来源", "curseforge");
  await expect(page.getByText("Sodium", { exact: true }).first()).toBeVisible();
});

test("modpack installation uses the shared create flow", async ({ page }) => {
  await installLauncherFixture(page);
  await mockRemote(page);
  await page.route("https://api.modrinth.com/v2/search?**", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ hits: [{ ...project, project_type: "modpack" }] }) });
  });
  await page.goto("/?next-ui");
  await page.getByRole("button", { name: "探索", exact: true }).click();
  await page.getByRole("tab", { name: "整合包", exact: true }).click();
  await page.getByRole("button", { name: "安装 · 合成测试世界", exact: true }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("heading", { name: "安装整合包", exact: true })).toBeVisible();
  await expect.poll(async () => {
    const calls = await page.evaluate(() => {
      const w = window as unknown as { __appearanceFixtures: { calls: { name: string }[] } };
      return w.__appearanceFixtures.calls;
    });
    return calls.some((call) => call.name === "list_modpack_versions");
  }).toBe(true);
  const calls = await page.evaluate(() => (window as unknown as { __appearanceFixtures: { calls: { name: string }[] } }).__appearanceFixtures.calls);
  expect(calls.some((call) => call.name === "install_resource")).toBe(false);
});

test("empty results and remote failure stay distinct", async ({ page }) => {
  await installLauncherFixture(page);
  await mockRemote(page);
  await page.route("https://api.modrinth.com/v2/search?**", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ hits: [] }) });
  });
  await page.goto("/?next-ui");
  await page.getByRole("button", { name: "探索", exact: true }).click();
  await expect(page.getByText("没有找到相关资源", { exact: true })).toBeVisible();
  await page.unroute("https://api.modrinth.com/v2/search?**");
  await page.route("https://api.modrinth.com/v2/search?**", async (route) => {
    await route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
  });
  await page.getByRole("searchbox", { name: "搜索资源" }).fill("sodium");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page.getByText("发生未预期错误，请查看诊断信息。", { exact: true })).toBeVisible();
});
