import { expect, test, type Page } from "@playwright/test";
import { installLauncherFixture } from "./fixtures";

const managedFixture = {
  id: "fixture-server",
  name: "合成测试服务端",
  versionId: "1.21.1",
  createdAt: "2026-01-01T00:00:00Z",
  directory: "C:\\SyntheticFixture\\server",
  settings: {
    port: 25565,
    maxPlayers: 20,
    onlineMode: true,
    whitelist: false,
    motd: "Synthetic server",
    difficulty: "normal",
    gamemode: "survival",
    viewDistance: 10,
    maxMemoryMb: 2048,
    bindAddress: "",
  },
  eulaAccepted: false,
  eulaUrl: "https://aka.ms/MinecraftEULA",
  installed: true,
  status: "stopped",
  pid: null,
  exitCode: null,
  error: null,
  javaMajor: 21,
};

function mockMultiplayer(page: Page) {
  return page.addInitScript((fixture) => {
    let managed: Omit<typeof fixture, "pid"> & { pid: number | null } = { ...fixture, settings: { ...fixture.settings } };
    const rowsByVersion = new Map([["1.21.1", [{ index: 0, name: "Fixture server", address: "play.example.invalid:25565", hideAddress: false, snapshot: "fixture-0" }]]]);
    let generation = 0;
    function saveRows(version: string, rows: NonNullable<ReturnType<typeof rowsByVersion.get>>) {
      generation++;
      const next = rows.map((row, index) => ({ ...row, index, snapshot: `${version}-${generation}-${index}` }));
      rowsByVersion.set(version, next);
      return next;
    }
    const internals = (window as unknown as {
      __TAURI_INTERNALS__: { invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown> };
    }).__TAURI_INTERNALS__;
    const original = internals.invoke;
    internals.invoke = async (name, args) => {
      const record = (result: unknown) => {
        (window as unknown as {
          __appearanceFixtures: { calls: { name: string; args?: Record<string, unknown> }[] };
        }).__appearanceFixtures.calls.push({ name, args });
        return result;
      };
      const version = String(args?.versionId ?? "");
      const rows = rowsByVersion.get(version) ?? [];
      if (name === "list_servers") return record(rows);
      if (name === "save_server") {
        const entry = args?.entry as { name: string; address: string; hideAddress: boolean };
        return record(saveRows(version, [...rows, { ...entry, index: rows.length, snapshot: "" }]));
      }
      if (name === "remove_server") {
        const expected = args?.expected as { index: number; snapshot: string } | undefined;
        const matches = expected && args?.index === expected.index
          && rows[expected.index]?.snapshot === expected.snapshot;
        if (!matches) {
          record(null);
          throw { code: "server.snapshotChanged", params: {} };
        }
        return record(saveRows(version, rows.filter((row) => row.index !== expected.index)));
      }
      if (name === "ping_server") return record({ online: true, latencyMs: 42, version: "1.21.1", playersOnline: 3, playersMax: 20, description: "Fixture MOTD" });
      if (name === "discover_lan") return record([]);
      if (name === "list_managed_servers") return record([managed]);
      if (name === "read_managed_server_logs") return record([{ serverId: managed.id, timestamp: "2026-01-01T00:00:00Z", stream: "stdout", message: "Fixture log" }]);
      if (name === "set_managed_server_eula") {
        managed = { ...managed, eulaAccepted: Boolean(args?.accepted) };
        return record(managed);
      }
      if (name === "start_managed_server") {
        managed = { ...managed, status: "running", pid: 12345 };
        return record({ serverId: managed.id, status: "running", pid: 12345, exitCode: null });
      }
      if (name === "stop_managed_server") {
        managed = { ...managed, status: "stopped", pid: null };
        return record(null);
      }
      if (name === "update_managed_server") {
        managed = { ...managed, settings: args?.settings as typeof managed.settings };
        return record(managed);
      }
      if (name === "create_managed_server") {
        managed = { ...managed, name: "Created server", status: "stopped", pid: null, eulaAccepted: false };
        return record(managed);
      }
      if (name === "send_managed_server_command") return record(null);
      return original(name, args);
    };
  }, managedFixture);
}

async function openMultiplayer(page: Page) {
  await page.goto("/?next-ui");
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "联机", exact: true }).click();
  await expect(page.getByRole("heading", { name: "联机", exact: true })).toBeVisible();
}

async function calls(page: Page) {
  return page.evaluate(() => (window as unknown as {
    __appearanceFixtures: { calls: { name: string; args?: Record<string, unknown> }[] };
  }).__appearanceFixtures.calls);
}

test("real status queries and direct join preserve the selected address", async ({ page }) => {
  await installLauncherFixture(page);
  await mockMultiplayer(page);
  await openMultiplayer(page);
  const row = page.locator('[data-server-address="play.example.invalid:25565"]');
  await expect(row).toContainText("尚未查询");
  await row.getByRole("button", { name: "查询状态", exact: true }).click();
  await expect(row).toContainText("在线");
  await expect(row).toContainText("42 ms");
  await row.getByRole("button", { name: "加入", exact: true }).click();
  await expect.poll(async () => (await calls(page)).some((call) => call.name === "launch_game" && call.args?.serverAddress === "play.example.invalid:25565")).toBe(true);
});

test("switching A to B to C prevents a stale bookmark action and late B display", async ({ page }) => {
  await installLauncherFixture(page, { versionDirectoryCount: 3 });
  await mockMultiplayer(page);
  await openMultiplayer(page);
  await expect(page.locator(".vx-server-row__copy h2")).toHaveText("Fixture server");
  await page.evaluate(() => {
    const probe = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown> };
      releaseFixtureServerB?: () => void;
    };
    const original = probe.__TAURI_INTERNALS__.invoke;
    probe.__TAURI_INTERNALS__.invoke = async (name, args) => {
      const result = await original(name, args);
      const version = args?.versionId;
      if (name !== "list_servers" || (version !== "fixture-version-002" && version !== "fixture-version-003")) return result;
      const label = version === "fixture-version-002" ? "B" : "C";
      if (label === "B") await new Promise<void>((resolve) => { probe.releaseFixtureServerB = resolve; });
      return [{ index: 0, name: `Bookmark ${label}`, address: `${label}.example.invalid`, hideAddress: false, snapshot: `snapshot-${label}` }];
    };
  });
  async function changeEnvironment(name: string) {
    await page.getByRole("combobox", { name: "游戏环境" }).click();
    await page.getByRole("option", { name, exact: true }).click();
  }
  await changeEnvironment("fixture-version-002");
  await expect.poll(async () => (await calls(page)).some((call) => call.name === "list_servers" && call.args?.versionId === "fixture-version-002")).toBe(true);
  await expect(page.getByRole("button", { name: "移除服务器", exact: true })).toHaveCount(0);
  await expect(page.locator(".vx-server-row__copy h2")).toHaveCount(0);
  await changeEnvironment("fixture-version-003");
  await expect(page.locator(".vx-server-row__copy h2")).toHaveText("Bookmark C");
  await page.evaluate(async () => {
    const release = (window as unknown as { releaseFixtureServerB?: () => void }).releaseFixtureServerB;
    if (!release) throw new Error("B was never deferred");
    release();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await expect(page.locator(".vx-server-row__copy h2")).toHaveText("Bookmark C");
  expect((await calls(page)).some((call) => call.name === "remove_server")).toBe(false);
});

test("add, remove and empty LAN discovery keep separate outcomes", async ({ page }) => {
  await installLauncherFixture(page);
  await mockMultiplayer(page);
  await openMultiplayer(page);
  await page.getByRole("button", { name: "添加服务器", exact: true }).click();
  await page.getByRole("textbox", { name: "服务器名称", exact: true }).fill("Added server");
  await page.getByRole("textbox", { name: "服务器地址", exact: true }).fill("added.example.invalid");
  await page.getByRole("button", { name: "保存服务器", exact: true }).click();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.locator('[data-server-address="play.example.invalid:25565"]').getByRole("button", { name: "移除服务器", exact: true }).click();
  await page.getByRole("button", { name: "搜索局域网", exact: true }).click();
  await expect(page.getByText("当前网络中没有发现局域网世界。", { exact: true })).toBeVisible();
  const recorded = await calls(page);
  expect(recorded.some((call) => call.name === "save_server")).toBe(true);
  expect(recorded.find((call) => call.name === "remove_server")?.args).toMatchObject({
    versionId: "1.21.1",
    index: 0,
    expected: { index: 0, snapshot: "1.21.1-1-0" },
  });
  await expect(page.locator('[data-server-address="added.example.invalid"]')).toBeVisible();
});

test("managed start remains disabled until the user explicitly accepts EULA", async ({ page }) => {
  await installLauncherFixture(page);
  await mockMultiplayer(page);
  await openMultiplayer(page);
  await page.getByRole("tab", { name: "服务端管理", exact: true }).click();
  const start = page.getByRole("button", { name: "启动服务端", exact: true });
  await expect(start).toBeDisabled();
  await page.getByRole("checkbox", { name: "同意 Minecraft EULA", exact: true }).check();
  await expect(start).toBeEnabled();
  await start.click();
  const recorded = await calls(page);
  expect(recorded.some((call) => call.name === "set_managed_server_eula" && call.args?.accepted === true)).toBe(true);
  expect(recorded.some((call) => call.name === "start_managed_server" && call.args?.serverId === "fixture-server")).toBe(true);
});

test("managed console commands and graceful stop use the selected process", async ({ page }) => {
  await installLauncherFixture(page);
  await mockMultiplayer(page);
  await page.addInitScript(() => {
    const internals = (window as unknown as {
      __TAURI_INTERNALS__: { invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown> };
    }).__TAURI_INTERNALS__;
    const original = internals.invoke;
    internals.invoke = async (name, args) => {
      if (name === "list_managed_servers") return [{
        id: "fixture-server", name: "合成测试服务端", versionId: "1.21.1", createdAt: "2026-01-01T00:00:00Z", directory: "C:\\SyntheticFixture\\server",
        settings: { port: 25565, maxPlayers: 20, onlineMode: true, whitelist: false, motd: "Synthetic server", difficulty: "normal", gamemode: "survival", viewDistance: 10, maxMemoryMb: 2048, bindAddress: "" },
        eulaAccepted: true, eulaUrl: "https://aka.ms/MinecraftEULA", installed: true, status: "running", pid: 12345, exitCode: null, error: null, javaMajor: 21,
      }];
      return original(name, args);
    };
  });
  await openMultiplayer(page);
  await page.getByRole("tab", { name: "服务端管理", exact: true }).click();
  await expect(page.getByRole("log", { name: "服务端控制台日志" })).toContainText("Fixture log");
  await page.getByRole("textbox", { name: "服务端控制台命令", exact: true }).fill("list");
  await page.getByRole("button", { name: "发送命令", exact: true }).click();
  await page.getByRole("button", { name: "保存并停止", exact: true }).click();
  const recorded = await calls(page);
  expect(recorded.some((call) => call.name === "send_managed_server_command" && call.args?.command === "list")).toBe(true);
  expect(recorded.some((call) => call.name === "stop_managed_server" && call.args?.force === false)).toBe(true);
});

test("settings save the complete object and creation does not auto-start", async ({ page }) => {
  await installLauncherFixture(page);
  await mockMultiplayer(page);
  await openMultiplayer(page);
  await page.getByRole("tab", { name: "服务端管理", exact: true }).click();
  await page.getByRole("button", { name: "服务端设置", exact: true }).click();
  await page.getByRole("spinbutton", { name: "端口", exact: true }).fill("25566");
  await page.getByRole("textbox", { name: "服务器简介 MOTD", exact: true }).fill("Changed MOTD");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await page.getByRole("button", { name: "创建服务端", exact: true }).click();
  await page.getByRole("textbox", { name: "服务器名称", exact: true }).fill("Created server");
  await page.getByRole("button", { name: "安装服务端", exact: true }).click();
  const recorded = await calls(page);
  expect(recorded.some((call) => call.name === "update_managed_server" && JSON.stringify(call.args?.settings).includes("25566"))).toBe(true);
  expect(recorded.some((call) => call.name === "create_managed_server")).toBe(true);
  expect(recorded.some((call) => call.name === "set_managed_server_eula")).toBe(false);
  expect(recorded.some((call) => call.name === "start_managed_server")).toBe(false);
});
