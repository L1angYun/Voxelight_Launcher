import { expect, test } from "@playwright/test";
import { installLauncherFixture } from "./fixtures";
import { changedPixels, withWorldView } from "./helpers/world-image";

test("full effects animate the real crystal world and remain usable after pointer blur", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await installLauncherFixture(page, { effects: "full" });
  await page.goto("/");

  const scene = page.locator(".vx-global-scene");
  await expect(scene.locator(".world-scene__canvas")).toBeVisible();
  await expect(scene).toHaveAttribute("data-motion", "full");
  await expect(scene).toHaveAttribute("data-world-tier", "animated");
  await expect(scene).toHaveAttribute("data-paused", "false");
  await withWorldView(page, async capture => {
    const before = await capture(testInfo.outputPath("crystal-world-before.png"));
    const firstFrames = Number(await scene.getAttribute("data-world-frames"));
    await page.waitForTimeout(1500);
    const after = await capture(testInfo.outputPath("crystal-world-after.png"));
    expect(Number(await scene.getAttribute("data-world-frames"))).toBeGreaterThan(firstFrames);
    expect(changedPixels(before, after)).toBeGreaterThan(100);
  });

  for (let x = 620; x <= 900; x += 28) {
    await page.mouse.move(x, 610 + Math.sin(x / 45) * 28);
  }
  const sweptFrames = Number(await scene.getAttribute("data-world-frames"));
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect.poll(async () => Number(await scene.getAttribute("data-world-frames"))).toBeGreaterThan(sweptFrames);
  await expect(page.getByRole("button", { name: "启动游戏", exact: true })).toBeEnabled();
  expect(errors).toEqual([]);
});

test("liquid SVG filters are mounted and all seven pages survive navigation", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await installLauncherFixture(page);
  await page.goto("/");

  const bar = page.locator(".vx-window-chrome__bar");
  await expect(bar).toHaveCSS("backdrop-filter", "none");
  const slider = page.locator(".vx-floating-nav__indicator");
  await expect(slider).toHaveAttribute("data-glass-refraction", "curvature");
  const ownFilter = slider.locator(':scope > svg.vx-liquid-filter-defs filter[id^="vx-liquid-refraction-"]');
  await expect(ownFilter).toHaveCount(1);
  const filterId = await ownFilter.getAttribute("id");
  await expect
    .poll(() =>
      slider.evaluate(
        (element) => getComputedStyle(element).backdropFilter,
      ),
    )
    .toContain(filterId!);

  for (const [id, selector] of [
    ["library", ".vx-library-page"],
    ["discover", ".vx-discover-page"],
    ["multiplayer", ".vx-multiplayer-page"],
    ["downloads", ".vx-downloads-page"],
    ["accounts", ".vx-accounts-page"],
    ["settings", ".vx-settings-page"],
    ["home", ".vx-home"],
  ] as const) {
    await page.locator(`[data-page="${id}"]`).click();
    await expect(page.locator(selector)).toBeInViewport();
    const chrome = (await page.locator(".vx-window-chrome").boundingBox())!;
    await expect
      .poll(async () => Math.round((await page.locator("#main-content").boundingBox())?.y ?? -1))
      .toBe(Math.round(chrome.y + chrome.height));
  }
  expect(errors).toEqual([]);
});

test("world context loss keeps launcher usable and restores rendering or a CSS fallback", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await installLauncherFixture(page, { launchDelay: 5000 });
  await page.goto("/");
  const scene = page.locator(".vx-global-scene");
  const canvas = scene.locator(".world-scene__canvas");
  await expect(canvas).toBeVisible();
  await expect(scene).toHaveAttribute("data-world-tier", "animated");
  await expect(scene).toHaveAttribute("data-paused", "false");
  const frames = Number(await scene.getAttribute("data-world-frames"));
  await canvas.evaluate(element => {
    const context = (element as HTMLCanvasElement).getContext("webgl2");
    const loss = context?.getExtension("WEBGL_lose_context");
    if (!context || !loss) throw new Error("The real world WebGL2 context and loss extension are required");
    (window as unknown as { __restoreWorldContext: () => void }).__restoreWorldContext = () => loss.restoreContext();
    loss.loseContext();
  });
  await expect(scene).toHaveAttribute("data-world-tier", "css");
  await page.screenshot({ path: testInfo.outputPath("world-context-lost.png") });
  await page.getByRole("button", { name: "启动游戏", exact: true }).click();
  await expect(page.getByRole("button", { name: "取消准备", exact: true })).toBeEnabled();
  await expect(page.getByText("37%", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "停止", exact: true })).toBeEnabled({ timeout: 8000 });
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await expect(page.getByRole("button", { name: "启动游戏", exact: true })).toBeEnabled();
  await page.evaluate(() => {
    const probe = window as unknown as { __restoreWorldContext?: () => void };
    probe.__restoreWorldContext?.();
    delete probe.__restoreWorldContext;
  });
  await expect.poll(async () => (await scene.getAttribute("data-world-tier")) === "css" ||
    Number(await scene.getAttribute("data-world-frames")) > frames).toBe(true);
  expect(errors).toEqual([]);
});

test("home columns do not overlap and the account retry action stays clickable", async ({
  page,
}) => {
  await installLauncherFixture(page, { profileFailure: true, instanceCount: 2 });
  await page.goto("/");

  const charColumn = await page.locator(".vx-home__char-col").boundingBox();
  const stage = await page.locator(".vx-home__stage").boundingBox();
  const recent = await page.locator(".vx-home__recent").boundingBox();
  expect(charColumn).not.toBeNull();
  expect(stage).not.toBeNull();
  expect(recent).not.toBeNull();
  expect(stage!.x + stage!.width).toBeLessThanOrEqual(
    charColumn!.x + 1,
  );
  expect(recent!.x).toBeGreaterThanOrEqual(stage!.x + stage!.width);

  const retry = page.getByRole("button", {
    name: "重试账号外观",
    exact: true,
  });
  await expect(retry).toBeVisible();
  await retry.click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __appearanceFixtures: { calls: { name: string }[] };
            }
          ).__appearanceFixtures.calls.filter(
            (call) => call.name === "get_player_profile",
          ).length,
      ),
    )
    .toBeGreaterThanOrEqual(2);
});
