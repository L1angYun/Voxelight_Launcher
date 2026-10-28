import { expect, test, type Page } from "@playwright/test";
import { installLauncherFixture } from "./fixtures";

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
      if (name === "plugin:dialog|open") {
        const options = JSON.stringify(args ?? {});
        if (options.includes('"directory":true')) return record("C:\\ChangedFixture");
        if (options.includes("json")) return record("C:\\SyntheticFixture\\preset.json");
        return record("C:\\SyntheticFixture\\background.png");
      }
      if (name === "plugin:dialog|save") return record("C:\\SyntheticFixture\\preset.json");
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
        return record(saved);
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
  await expect(page.locator('select[aria-label="特效级别"] option')).toHaveCount(2);
  await page.getByRole("combobox", { name: "特效级别", exact: true }).selectOption("lite");
  await expect(page.locator("html")).toHaveAttribute("data-effects", "lite");
  await page.getByRole("combobox", { name: "强调色来源", exact: true }).selectOption("system");
  await expect(page.locator("html")).toHaveAttribute("data-accent-source", "system");
  await page.getByRole("combobox", { name: "主题", exact: true }).selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("combobox", { name: "界面语言", exact: true }).selectOption("en-US");
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  expect((await calls(page)).some((call) => call.name === "save_config")).toBe(false);
  await page.getByRole("checkbox", { name: "Sound effects", exact: true }).check();
  await page.getByRole("button", { name: "Save settings", exact: true }).click();
  const saved = (await calls(page)).filter((call) => call.name === "save_config").at(-1)?.args?.config as Record<string, unknown>;
  expect(saved).toMatchObject({ effects: "lite", accentSource: "system", theme: "light", language: "en-US", soundEnabled: true });
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
  await page.getByRole("combobox", { name: "游戏下载源", exact: true }).selectOption("bmclapi");
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
  await expect(page.getByText("0.5.0", { exact: true })).toBeVisible();
  await expect(page.getByLabel("CurseForge API Key", { exact: true })).toHaveCount(0);
  const recorded = await calls(page);
  expect(recorded.some((call) => call.name === "set_service_secret" && call.args?.secret === "fixture-secret")).toBe(true);
  expect(recorded.some((call) => call.name === "export_launcher_config" && !("secret" in (call.args ?? {})))).toBe(true);
  expect(recorded.some((call) => call.name === "import_launcher_config")).toBe(true);
  expect(recorded.some((call) => call.name === "set_launcher_background" && call.args?.path === "C:\\SyntheticFixture\\background.png")).toBe(true);
  expect(recorded.some((call) => call.name === "set_launcher_background" && call.args?.path === null)).toBe(true);
});
