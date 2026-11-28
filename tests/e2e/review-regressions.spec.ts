import { expect, test } from "@playwright/test";
import { installLauncherFixture } from "./fixtures";

test("resource and world writes keep every command scoped to its selected instance", async ({ page }) => {
  await installLauncherFixture(page, {
    instances: [
      { id: "fixture-world", name: "合成测试世界", versionId: "1.21.1", gameDirectory: "C:\\SyntheticFixture\\world" },
      { id: "fixture-second", name: "第二实例", versionId: "1.20.1", gameDirectory: "C:\\SyntheticFixture\\world-2" },
    ],
  });
  await page.addInitScript(() => {
    const internals = (window as unknown as {
      __TAURI_INTERNALS__: { invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown> };
    }).__TAURI_INTERNALS__;
    const original = internals.invoke;
    const fixture = (window as unknown as {
      __appearanceFixtures: { calls: { name: string; args?: Record<string, unknown> }[] };
    }).__appearanceFixtures;
    internals.invoke = async (name, args) => {
      const record = <T,>(value: T): T => {
        fixture.calls.push({ name, args });
        return value;
      };
      if (name === "choose_launcher_path" && args?.purpose === "worldRead") {
        return record(["C:\\SyntheticFixture\\world.zip"]);
      }
      if (name === "import_world") return record({ name: "ImportedFixture" });
      if (name === "toggle_resource" && args?.fileName === "fixture.zip") return record({
        name: "Synthetic pack", fileName: "fixture.zip.disabled", enabled: false, size: 1000,
        path: "C:\\SyntheticFixture\\fixture.zip.disabled",
      });
      if (name === "list_local_resources") return [{ name: "Synthetic pack", fileName: "fixture.zip", enabled: true, size: 1000, path: "C:\\SyntheticFixture\\fixture.zip" }];
      return original(name, args);
    };
  });
  await page.goto("/");
  await page.locator('[data-page="library"]').click();
  await page.locator('[data-instance-id="fixture-world"] .vx-instance-card__select').click();

  async function write() {
    await page.getByRole("tab", { name: "内容", exact: true }).click();
    await page.locator(".vx-resource-row").filter({ hasText: "fixture.zip" }).getByRole("switch", { name: "已启用", exact: true }).click();
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
  await page.locator('[data-instance-id="fixture-second"] .vx-instance-card__select').click();
  await write();

  const recorded = await calls();
  // Every content/world command carries the selected instance; no ambient
  // version context may leak into a second drill.
  expect(recorded.filter((call) => call.name === "toggle_resource").map((call) => call.args)).toEqual([
    { versionId: "1.21.1", instanceId: "fixture-world", resourceType: "resourcepack", fileName: "fixture.zip" },
    { versionId: "1.20.1", instanceId: "fixture-second", resourceType: "resourcepack", fileName: "fixture.zip" },
  ]);
  expect(recorded.filter((call) => call.name === "import_world").map((call) => call.args)).toEqual([
    { versionId: "1.21.1", instanceId: "fixture-world", path: "C:\\SyntheticFixture\\world.zip", name: undefined },
    { versionId: "1.20.1", instanceId: "fixture-second", path: "C:\\SyntheticFixture\\world.zip", name: undefined },
  ]);
  await expect(page.getByRole("heading", { name: "第二实例", exact: true })).toBeVisible();
  await expect(page.locator(".vx-detail-header__meta")).toContainText("1.20.1");
  await expect(page.getByRole("heading", { name: "合成测试世界", exact: true })).toHaveCount(0);
});
