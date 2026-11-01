import { expect, test } from "@playwright/test";
import { installLauncherFixture } from "./fixtures";

function canvasHash() {
  const canvas = document.querySelector<HTMLCanvasElement>(
    ".world-scene__cube-canvas",
  );
  const context = canvas?.getContext("2d");
  if (!canvas || !context) return 0;
  const width = Math.min(canvas.width, 900);
  const height = Math.min(canvas.height, 720);
  const pixels = context.getImageData(0, 0, width, height).data;
  let hash = 2166136261;
  for (let index = 0; index < pixels.length; index += 997) {
    hash ^= pixels[index];
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

test("full effects animate the cube field and pointer influence fades smoothly", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await installLauncherFixture(page, { effects: "full" });
  await page.goto("/");

  const scene = page.locator(".vx-global-scene");
  await expect(scene).toHaveAttribute("data-motion", "full");
  await page.screenshot({ path: testInfo.outputPath("cube-rotation-before.png") });
  const firstHash = await scene.locator(".world-scene__cube-canvas").evaluate(canvasHash);
  await page.waitForTimeout(1500);
  const secondHash = await scene.locator(".world-scene__cube-canvas").evaluate(canvasHash);
  expect(secondHash).not.toBe(firstHash);
  await page.screenshot({ path: testInfo.outputPath("cube-rotation-after.png") });

  for (let x = 620; x <= 900; x += 28) {
    await page.mouse.move(x, 610 + Math.sin(x / 45) * 28);
  }
  await expect(scene).toHaveAttribute("data-pointer-active", "true");
  await expect
    .poll(async () => Number(await scene.getAttribute("data-active-flips")))
    .toBeGreaterThan(0);

  const afterBlur = await page.evaluate(() => {
    window.dispatchEvent(new Event("blur"));
    const element = document.querySelector<HTMLElement>(".vx-global-scene");
    return {
      pointer: element?.dataset.pointerActive,
      ripple: element?.dataset.rippleActive,
    };
  });
  expect(afterBlur.pointer).toBe("false");
  expect(afterBlur.ripple).toBe("true");
  await expect(scene).toHaveAttribute("data-ripple-active", "false");
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
    await expect
      .poll(async () => Math.round((await page.locator("#main-content").boundingBox())?.y ?? -1))
      .toBe(0);
  }
  expect(errors).toEqual([]);
});

test("home columns do not overlap and the account retry action stays clickable", async ({
  page,
}) => {
  await installLauncherFixture(page, { profileFailure: true });
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
