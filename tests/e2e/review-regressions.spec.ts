import { expect, test } from "@playwright/test";
import { installLauncherFixture } from "./fixtures";

test("resource and world writes keep instance and version-directory contexts distinct", async ({ page }) => {
  await installLauncherFixture(page);
  await page.addInitScript(() => {
    const internals = (window as unknown as {
      __TAURI_INTERNALS__: { invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown> };
    }).__TAURI_INTERNALS__;
    const original = internals.invoke;
    internals.invoke = async (name, args) => {
      const result = await original(name, args);
      if (name === "bootstrap") {
        const data = result as { installedVersions: Record<string, unknown>[] };
        if (!data.installedVersions.some((version) => version.id === "1.20.1")) {
          data.installedVersions.push({ id: "1.20.1", type: "release", installed: true, launchable: true, javaMajor: 17 });
        }
      }
      if (name === "list_local_resources") return [{ name: "Synthetic pack", fileName: "fixture.zip", enabled: true, size: 1000, path: "C:\\SyntheticFixture\\fixture.zip" }];
      if (name === "plugin:dialog|open") return "C:\\SyntheticFixture\\world.zip";
      if (name === "import_world") return { name: "ImportedFixture" };
      return result;
    };
  });
  await page.goto("/");
  await page.locator('[data-page="library"]').click();
  await page.locator('[data-instance-id="fixture-world"] .vx-instance-card__select').click();

  async function write() {
    await page.getByRole("tab", { name: "内容", exact: true }).click();
    await page.locator(".vx-resource-row").filter({ hasText: "fixture.zip" }).getByRole("button", { name: "已启用", exact: true }).click();
    await page.getByRole("tab", { name: "世界", exact: true }).click();
    await page.getByRole("button", { name: "导入世界", exact: true }).click();
  }
  async function calls() {
    return page.evaluate(() => (window as unknown as {
      __appearanceFixtures: { calls: { name: string; args?: Record<string, unknown> }[] };
    }).__appearanceFixtures.calls);
  }

  await write();
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await page.getByRole("button", { name: "版本目录", exact: true }).click();
  await page.locator('[data-version-id="1.20.1"]').click();
  await write();

  const recorded = await calls();
  expect(recorded.filter((call) => call.name === "toggle_resource").map((call) => call.args)).toEqual([
    { versionId: "1.21.1", instanceId: "fixture-world", resourceType: "resourcepack", fileName: "fixture.zip" },
    { versionId: "1.20.1", instanceId: undefined, resourceType: "resourcepack", fileName: "fixture.zip" },
  ]);
  expect(recorded.filter((call) => call.name === "import_world").map((call) => call.args)).toEqual([
    { versionId: "1.21.1", instanceId: "fixture-world", path: "C:\\SyntheticFixture\\world.zip", name: undefined },
    { versionId: "1.20.1", instanceId: undefined, path: "C:\\SyntheticFixture\\world.zip", name: undefined },
  ]);
  await expect(page.getByRole("heading", { name: "Minecraft 1.20.1", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "合成测试世界", exact: true })).toHaveCount(0);
});
