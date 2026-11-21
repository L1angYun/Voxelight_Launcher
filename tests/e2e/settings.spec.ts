import { expect, test, type Page } from "@playwright/test";
import { installLauncherFixture } from "./fixtures";
import { selectValue } from "./select-helpers";
import packageJson from "../../package.json" with { type: "json" };

function mockSettings(page: Page) {
  return page.addInitScript(() => {
    let configured = false;
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
      if (name === "get_service_status") return record({ curseforgeConfigured: configured, microsoftConfigured: true });
      if (name === "set_service_secret") {
        configured = Boolean(args?.secret);
        return record(configured);
      }
      if (name === "detect_java") return record([{ path: "C:\\SyntheticFixture\\java.exe", version: "21.0.1", major: 21 }]);
      if (name === "choose_launcher_path") {
        if (args?.purpose === "gameDirectory") return record(["C:\\ChangedFixture"]);
        if (args?.purpose === "presetRead" || args?.purpose === "presetWrite") return record(["C:\\SyntheticFixture\\preset.json"]);
        if (args?.purpose === "background") return record(["C:\\SyntheticFixture\\background.png"]);
      }
      if (name === "set_launcher_background") {
        const bootstrap = await original("bootstrap") as { config: Record<string, unknown> };
        const next = { ...bootstrap.config, customBackground: args?.path ?? null };
        await original("save_config", { config: next });
        return record(next);
      }
      if (name === "export_launcher_config") return record(args?.path);
      if (name === "import_launcher_config") {
        const bootstrap = await original("bootstrap") as { config: Record<string, unknown> };
        const next = { ...bootstrap.config, effects: "lite", accentSource: "system" };
        const saved = await original("save_config", { config: next });
        return record({ config: saved, heapArgumentsRemoved: false });
      }
      return original(name, args);
    };
  });
}

async function calls(page: Page) {
  return page.evaluate(() => (window as unknown as {
    __appearanceFixtures: { calls: { name: string; args?: Record<string, unknown> }[] };
  }).__appearanceFixtures.calls);
}

async function openSettings(page: Page) {
  await page.goto("/?next-ui");
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByRole("heading", { name: "设置", exact: true })).toBeVisible();
}

test("appearance and language preview immediately and persist only on explicit save", async ({ page }) => {
  await installLauncherFixture(page);
  await mockSettings(page);
  await page.addInitScript(() => localStorage.setItem("theme", "light"));
  await openSettings(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.locator(".vx-settings-nav").getByRole("button", { name: "外观", exact: true }).click();
  const effects = page.getByRole("combobox", { name: "特效级别", exact: true });
  await effects.click();
  await expect(page.getByRole("listbox", { name: "特效级别", exact: true }).getByRole("option")).toHaveCount(2);
  await effects.press("Escape");
  await selectValue(page, "特效级别", "lite");
  await expect(page.locator("html")).toHaveAttribute("data-effects", "lite");
  await selectValue(page, "强调色来源", "system");
  await expect(page.locator("html")).toHaveAttribute("data-accent-source", "system");
  await selectValue(page, "主题", "light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await selectValue(page, "界面语言", "en-US");
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  expect((await calls(page)).some((call) => call.name === "save_config")).toBe(false);
  await page.getByRole("checkbox", { name: "Sound effects", exact: true }).check();
  await page.getByRole("button", { name: "Save settings", exact: true }).click();
  const saves = (await calls(page));
  expect(saves.some(call => call.name === "save_config")).toBe(false);
  const saved = saves.filter(call => call.name === "save_appearance_config").at(-1)?.args?.patch as Record<string, unknown>;
  expect(saved).toEqual({ effects: "lite", theme: "light", language: "en-US", soundEnabled: true });
  expect(await page.locator("html").getAttribute("data-theme")).toBe("light");
});

test("game, Java and download drafts survive section switches and save together", async ({ page }) => {
  await installLauncherFixture(page);
  await mockSettings(page);
  await openSettings(page);
  await page.locator(".vx-settings-nav").getByRole("button", { name: "游戏", exact: true }).click();
  await page.getByRole("button", { name: "浏览", exact: true }).click();
  await page.getByRole("checkbox", { name: "版本隔离", exact: true }).uncheck();
  await page.getByRole("spinbutton", { name: "游戏窗口宽度", exact: true }).fill("1600");
  await page.getByRole("spinbutton", { name: "游戏窗口高度", exact: true }).fill("900");
  await page.locator(".vx-settings-nav").getByRole("button", { name: "Java", exact: true }).click();
  await page.getByRole("button", { name: "自动检测", exact: true }).click();
  await page.getByRole("button", { name: "Java 21", exact: true }).click();
  await page.getByRole("spinbutton", { name: "最大内存（MB）", exact: true }).fill("8192");
  await page.getByRole("textbox", { name: "额外 JVM 参数", exact: true }).fill("-XX:+UseG1GC");
  await page.getByRole("checkbox", { name: "自动准备 Java", exact: true }).uncheck();
  await page.locator(".vx-settings-nav").getByRole("button", { name: "下载", exact: true }).click();
  await selectValue(page, "游戏下载源", "bmclapi");
  await page.getByRole("spinbutton", { name: "并发下载数", exact: true }).fill("8");
  await page.getByRole("spinbutton", { name: "下载速度上限（KiB/s）", exact: true }).fill("1024");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  const saved = (await calls(page)).filter((call) => call.name === "save_config").at(-1)?.args?.config as Record<string, unknown>;
  expect(saved).toMatchObject({
    gameDirectory: "C:\\ChangedFixture",
    versionIsolation: false,
    screenWidth: 1600,
    screenHeight: 900,
    javaPath: "C:\\SyntheticFixture\\java.exe",
    maxMemoryMb: 8192,
    jvmArguments: "-XX:+UseG1GC",
    javaAutoDownload: false,
    downloadSource: "bmclapi",
    downloadConcurrency: 8,
    downloadLimitKib: 1024,
  });
});

test("R4-M1 saves the appearance during an operation and can retry the retained game settings", async ({ page }) => {
  await installLauncherFixture(page, { settingsOperationLocked: true });
  await openSettings(page);
  const sections = page.locator(".vx-settings-nav");
  const save = page.getByRole("button", { name: "保存设置", exact: true });
  const width = page.getByRole("spinbutton", { name: "游戏窗口宽度", exact: true });
  const persistedConfig = () => page.evaluate(async () => (await (window as unknown as {
    __TAURI_INTERNALS__: { invoke: (name: string) => Promise<{ config: Record<string, unknown> }> };
  }).__TAURI_INTERNALS__.invoke("bootstrap")).config);

  await sections.getByRole("button", { name: "游戏", exact: true }).click();
  await width.fill("1600");
  await sections.getByRole("button", { name: "外观", exact: true }).click();
  await selectValue(page, "主题", "light");
  await save.click();

  await expect(page.getByRole("status").filter({ hasText: "外观已保存。" })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "其他设置未保存。" })).toBeVisible();
  await expect(page.getByText(/有未保存的更改/)).toBeVisible();
  expect(await persistedConfig()).toMatchObject({ theme: "light", screenWidth: 1280 });

  await page.evaluate(() => (window as unknown as {
    __appearanceFixtures: { releaseSettingsOperation: () => void };
  }).__appearanceFixtures.releaseSettingsOperation());
  await sections.getByRole("button", { name: "游戏", exact: true }).click();
  await expect(width).toHaveValue("1600");
  await save.click();
  await expect(page.getByRole("status").filter({ hasText: "其他设置已保存。" })).toBeVisible();
  await expect(page.getByText(/有未保存的更改/)).toHaveCount(0);
  expect(await persistedConfig()).toMatchObject({ theme: "light", screenWidth: 1600 });

  const saves = (await calls(page)).filter(({ name }) => name === "save_appearance_config" || name === "save_config");
  expect(saves).toEqual([
    { name: "save_appearance_config", args: { patch: { theme: "light" } } },
    { name: "save_config", args: { config: expect.objectContaining({ theme: "light", screenWidth: 1600 }), preserveAppearance: true } },
    { name: "save_config", args: { config: expect.objectContaining({ theme: "light", screenWidth: 1600 }), preserveAppearance: true } },
  ]);
});

test("service secrets, presets and background stay in their owning groups", async ({ page }) => {
  await installLauncherFixture(page);
  await mockSettings(page);
  await openSettings(page);
  await page.getByLabel("CurseForge API Key", { exact: true }).fill("fixture-secret");
  await page.getByRole("button", { name: "保存密钥", exact: true }).click();
  await expect(page.getByRole("button", { name: "清除已保存的密钥", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "导出设置预设", exact: true }).click();
  await page.getByRole("button", { name: "导入设置预设", exact: true }).click();
  await page.locator(".vx-settings-nav").getByRole("button", { name: "外观", exact: true }).click();
  await page.getByRole("button", { name: "选择首页背景", exact: true }).click();
  await page.getByRole("button", { name: "恢复默认背景", exact: true }).click();
  await page.locator(".vx-settings-nav").getByRole("button", { name: "关于", exact: true }).click();
  await expect(page.getByText(packageJson.version, { exact: true })).toBeVisible();
  await expect(page.getByLabel("CurseForge API Key", { exact: true })).toHaveCount(0);
  const recorded = await calls(page);
  expect(recorded.some((call) => call.name === "set_service_secret" && call.args?.secret === "fixture-secret")).toBe(true);
  expect(recorded.some((call) => call.name === "export_launcher_config" && !("secret" in (call.args ?? {})))).toBe(true);
  expect(recorded.some((call) => call.name === "import_launcher_config")).toBe(true);
  expect(recorded.some((call) => call.name === "set_launcher_background" && call.args?.path === "C:\\SyntheticFixture\\background.png")).toBe(true);
  expect(recorded.some((call) => call.name === "set_launcher_background" && call.args?.path === null)).toBe(true);
});

test("fallback profile shows both the active directory and retained primary state", async ({ page }) => {
  await installLauncherFixture(page);
  await page.addInitScript(() => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: {
      invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
    } }).__TAURI_INTERNALS__;
    const original = internals.invoke;
    internals.invoke = async (name, args) => {
      const result = await original(name, args);
      if (name !== "bootstrap") return result;
      return {
        ...result as Record<string, unknown>,
        storage: { activeDirectory: "C:\\SyntheticFixture\\fallback", recovery: {
          reason: "newerSchema", primaryDirectory: "C:\\SyntheticFixture\\primary",
          primaryStatePath: "C:\\SyntheticFixture\\primary\\state.json", primaryStateRetained: true,
        } },
      };
    };
  });
  await page.goto("/?next-ui");
  const warning = page.getByRole("alert").filter({ hasText: "C:\\SyntheticFixture\\fallback" });
  await expect(warning).toContainText("C:\\SyntheticFixture\\primary\\state.json");
  await expect(warning).toContainText("更新版本");
  await expect(warning).toContainText("保留");
  await page.getByRole("navigation", {name:"主导航"}).getByRole("button",{name:"设置",exact:true}).click();
  await expect(warning).toBeVisible();
});

test("the startup update notice opens Settings → About once and installs from there", async ({ page }) => {
  await installLauncherFixture(page, { launcherUpdate: { latestVersion: "99.0.0" } });
  await page.goto("/?next-ui");
  const notice = page.locator(".vx-toast");
  await expect(notice).toContainText("发现新版本 99.0.0，可在“设置 → 关于”中查看和安装。");
  await notice.getByRole("button", { name: "查看更新", exact: true }).click();
  await expect(page.getByRole("heading", { name: "版本更新", exact: true })).toBeVisible();
  const status = page.getByTestId("launcher-update-status");
  await expect(status).toHaveText("发现新版本 99.0.0。");
  const install = page.getByRole("button", { name: "下载并更新", exact: true });
  await expect(install).toBeFocused();
  await expect(page.locator(".vx-toast")).toHaveCount(0);

  // Leaving and coming back opens General again; the session result stays.
  const nav = page.getByRole("navigation", { name: "主导航" });
  await nav.getByRole("button", { name: "角色", exact: true }).click();
  await nav.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByRole("heading", { name: "版本更新", exact: true })).toHaveCount(0);
  await page.locator(".vx-settings-nav").getByRole("button", { name: "关于", exact: true }).click();
  await expect(status).toHaveText("发现新版本 99.0.0。");

  await page.getByRole("button", { name: "下载并更新", exact: true }).click();
  await expect(status).toHaveText("安装包已校验，正在准备更新…");
  const recorded = await calls(page);
  expect(recorded.filter(({ name }) => name === "check_launcher_update")).toHaveLength(1);
  expect(recorded.find(({ name }) => name === "install_launcher_update_and_exit")?.args).toEqual({
    errorText: "更新未完成。请重新打开 Voxelight 后重试，或从发布页手动下载安装包。",
    logsText: "故障诊断日志：",
  });
});

test("the update source and the startup check save at once", async ({ page }) => {
  await installLauncherFixture(page);
  await openSettings(page);
  await page.locator(".vx-settings-nav").getByRole("button", { name: "关于", exact: true }).click();
  await expect(page.getByTestId("launcher-update-status")).toHaveText(`当前版本 ${packageJson.version} 已是最新。`);
  await page.getByLabel("启动时检查更新", { exact: true }).uncheck();
  await selectValue(page, "更新来源", "gitee");
  await expect(page.getByTestId("launcher-update-status")).toHaveText("尚未检查更新。");
  await expect(page.getByText(/有未保存的更改/)).toHaveCount(0);
  const persisted = await page.evaluate(async () => (await (window as unknown as {
    __TAURI_INTERNALS__: { invoke: (name: string) => Promise<{ config: Record<string, unknown> }> };
  }).__TAURI_INTERNALS__.invoke("bootstrap")).config);
  expect(persisted).toMatchObject({ checkForUpdates: false, updateSource: "gitee" });
  const saved = (await calls(page)).filter(({ name }) => name === "set_launcher_update_preferences").map(({ args }) => args);
  expect(saved).toEqual([{ checkForUpdates: false, updateSource: "auto" }, { checkForUpdates: false, updateSource: "gitee" }]);
});
