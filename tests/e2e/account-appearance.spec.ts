import { expect, test, type Page } from "@playwright/test";
import { installLauncherFixture } from "./fixtures";
import { selectValue } from "./select-helpers";

async function fixtureSkins(page: Page) {
  return page.evaluate(() => (window as unknown as {
    __appearanceFixtures: { skins: Record<string, string> };
  }).__appearanceFixtures.skins);
}

async function openAccounts(page: Page) {
  await page.locator('[data-page="accounts"]').click();
  await expect(page.getByRole("heading", { name: "角色", exact: true })).toBeVisible();
}

test("home renders the ACTIVE account skin and cape, disposes on navigation, and never substitutes on failure", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await installLauncherFixture(page, { defaultModel: "slim" });
  await page.goto("/");
  const skins = await fixtureSkins(page);
  const character = page.locator(".vx-home__char-col .vx-character-canvas");
  await expect(character).toHaveAttribute("data-character-state", "ready");
  await expect(character).toHaveAttribute("data-skin-url", skins.classic);
  await expect(character).toHaveAttribute("data-skin-model", "classic");
  await expect(character).toHaveAttribute("data-cape-url", skins.cape);
  await expect(page.locator(".vx-home__preview-source")).toHaveText("CyanFixture 的角色预览");
  for (let cycle = 0; cycle < 2; cycle++) {
    await page.locator('[data-page="library"]').click();
    await expect(page.locator(".vx-home__char-col canvas")).toHaveCount(0);
    await page.locator('[data-page="home"]').click();
    await expect(character).toHaveAttribute("data-character-state", "ready");
  }
  await openAccounts(page);
  await page.getByRole("button", { name: "选择 AmberFixture", exact: true }).click();
  await page.locator('[data-page="home"]').click();
  await expect(character).toHaveAttribute("data-skin-url", skins.slim);
  await expect(character).toHaveAttribute("data-skin-model", "slim");
  await openAccounts(page);
  await page.getByRole("button", { name: "选择 UnavailableFixture", exact: true }).click();
  await page.locator('[data-page="home"]').click();
  await expect(page.locator(".vx-home__char-col .vx-character-canvas")).toHaveCount(0);
  await expect(page.locator(".vx-character-placeholder")).toContainText("账号外观暂不可用");
  expect(errors).toEqual([]);
});

test("profile failure exposes a retry state and no default character", async ({ page }) => {
  await installLauncherFixture(page, { profileFailure: true, profileDelay: 1000 });
  await page.goto("/");
  await expect(page.locator(".vx-character-placeholder")).toContainText("正在读取账号外观");
  await expect(page.locator(".vx-character-placeholder")).toContainText("账号外观暂不可用");
  await expect(page.locator(".vx-home__char-col .vx-character-canvas")).toHaveCount(0);
  await page.getByRole("button", { name: "重试账号外观", exact: true }).click();
  await expect.poll(async () => page.evaluate(() => (window as unknown as {
    __appearanceFixtures: { calls: { name: string }[] };
  }).__appearanceFixtures.calls.filter((call) => call.name === "get_player_profile").length)).toBeGreaterThanOrEqual(2);
  await expect(page.locator(".vx-home__char-col .vx-character-canvas")).toHaveCount(0);
});

test("a successful empty profile and a no-account home keep distinct honest previews", async ({ page }) => {
  await installLauncherFixture(page, { emptyProfile: true });
  await page.goto("/");
  await expect(page.locator(".vx-character-placeholder")).toContainText("尚未取得当前账号的皮肤");
  await expect(page.locator(".vx-home__char-col .vx-character-canvas")).toHaveCount(0);
});

test("an account-free home labels and renders the chosen default preview", async ({ page }) => {
  await installLauncherFixture(page, { noAccount: true });
  await page.goto("/");
  await expect(page.locator(".vx-home__preview-source")).toHaveText("默认角色预览");
  await expect(page.locator(".vx-home__char-col .vx-character-canvas")).toHaveAttribute("data-character-state", "ready");
  await expect(page.locator(".vx-home__preview-source")).not.toContainText("CyanFixture");
});

test("texture decoding failure cannot offer a default character inside the account preview", async ({ page }) => {
  await installLauncherFixture(page);
  await page.addInitScript(() => {
    const internals = (window as unknown as {
      __TAURI_INTERNALS__: { invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown> };
    }).__TAURI_INTERNALS__;
    const original = internals.invoke;
    internals.invoke = async (name, args) => {
      const value = await original(name, args);
      if (name === "get_player_profile") {
        const profile = value as { skins: { state: string; url: string }[] };
        for (const skin of profile.skins) skin.url = "data:image/png;base64,YnJva2Vu";
      }
      return value;
    };
  });
  await page.goto("/");
  await expect(page.locator(".vx-character-canvas")).toHaveAttribute("data-character-state", "error");
  await expect(page.getByRole("button", { name: "使用 Lumen", exact: true })).toHaveCount(0);
  await expect(page.locator(".vx-home__preview-source")).toHaveText("CyanFixture 的角色预览");
});

test("local previews expose their source and pause offscreen without changing account appearance", async ({ page }) => {
  await installLauncherFixture(page);
  await page.setViewportSize({ width: 1050, height: 650 });
  await page.goto("/");
  const skins = await fixtureSkins(page);
  await expect(page.locator(".vx-home__char-col .vx-character-canvas")).toHaveAttribute("data-skin-url", skins.classic);
  await openAccounts(page);
  await page.getByRole("tab", { name: "本地预览", exact: true }).click();
  await page.locator('input[aria-label="导入本地 PNG"]').setInputFiles({
    name: "local-amber.png",
    mimeType: "image/png",
    buffer: Buffer.from(skins.slim.split(",")[1], "base64"),
  });
  const preview = page.locator(".vx-appearance-preview .vx-character-canvas");
  await expect(preview).toHaveAttribute("data-character-state", "ready");
  await expect(preview).toHaveAttribute("data-skin-model", "auto");
  await expect(page.locator(".vx-appearance-preview__source")).toContainText("local-amber.png");
  await expect(page.locator(".vx-appearance-preview__source")).toContainText("仅用于本地预览");
  await selectValue(page, "人物动画", "none");
  await page.getByRole("button", { name: "自动旋转", exact: true }).click();
  await expect(page.getByRole("button", { name: "自动旋转", exact: true })).toHaveAttribute("aria-pressed", "false");
  await page.setViewportSize({ width: 1050, height: 300 });
  await page.evaluate(() => {
    const main = document.querySelector("main")!;
    const spacer = document.createElement("div");
    spacer.dataset.testSpacer = "true";
    spacer.style.height = "1200px";
    main.append(spacer);
    main.scrollTo({ top: main.scrollHeight });
  });
  await expect(preview).toHaveAttribute("data-visible", "false");
  await page.evaluate(() => {
    document.querySelector("[data-test-spacer]")?.remove();
    document.querySelector("main")!.scrollTo({ top: 0 });
  });
  await expect(preview).toHaveAttribute("data-visible", "true");
  await page.locator('[data-page="home"]').click();
  await expect(page.locator(".vx-home__char-col .vx-character-canvas")).toHaveAttribute("data-skin-url", skins.classic);
  const mutations = await page.evaluate(() => (window as unknown as {
    __appearanceFixtures: { calls: { name: string }[] };
  }).__appearanceFixtures.calls.filter((call) => ["upload_account_skin", "reset_account_skin", "select_account_cape"].includes(call.name)));
  expect(mutations).toEqual([]);
});

test("reduced motion disables automatic animation while keeping manual camera controls", async ({ page }) => {
  await installLauncherFixture(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await openAccounts(page);
  await page.getByRole("tab", { name: "本地预览", exact: true }).click();
  await expect(page.getByRole("button", { name: "自动旋转", exact: true })).toBeDisabled();
  await expect(page.getByRole("combobox", { name: "人物动画", exact: true })).toBeDisabled();
  await expect(page.getByRole("combobox", { name: "人物动画", exact: true })).toContainText("静止");
  const canvas = page.locator(".vx-appearance-preview canvas");
  await canvas.focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("+");
  await expect(page.locator(".vx-character-canvas__error")).toHaveCount(0);
});

test("only Steve and Alex are offered as default preview characters", async ({ page }) => {
  const proprietaryRequests: string[] = [];
  page.on("request", (request) => {
    if (/\/(?:Steve|Alex)\.png$/i.test(request.url())) proprietaryRequests.push(request.url());
  });
  await installLauncherFixture(page, { noAccount: true });
  await page.goto("/");
  await openAccounts(page);
  await page.getByRole("tab", { name: "本地预览", exact: true }).click();
  await expect(page.getByRole("radio", { name: "Lumen", exact: true })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "Steve", exact: true })).toBeChecked();
  await expect(page.getByRole("radio", { name: "Alex", exact: true })).toBeVisible();
  await expect(page.locator(".vx-appearance-preview .vx-character-canvas")).toHaveAttribute("data-character-state", "ready");
  expect(proprietaryRequests).toEqual([]);
});
