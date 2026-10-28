import { expect, test } from "@playwright/test";
import { installLauncherFixture } from "./fixtures";

test("legacy 64x32 skin renders both legs and invalid PNG recovers to the default preview", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await installLauncherFixture(page, { noAccount: true });
  await page.goto("/");
  await page.locator('[data-page="accounts"]').click();
  await page.getByRole("tab", { name: "本地预览", exact: true }).click();
  const legacy = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 32;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#2859e9";
    context.fillRect(0, 0, 32, 16);
    context.fillStyle = "#eece28";
    context.fillRect(16, 16, 24, 16);
    context.fillStyle = "#23dc58";
    context.fillRect(40, 16, 16, 16);
    context.fillStyle = "#ed2929";
    context.fillRect(0, 16, 16, 16);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.locator('input[aria-label="导入本地 PNG"]').setInputFiles({
    name: "legacy-64x32.png",
    mimeType: "image/png",
    buffer: Buffer.from(legacy, "base64"),
  });
  const preview = page.locator(".vx-appearance-preview .vx-character-canvas");
  await expect(preview).toHaveAttribute("data-character-state", "ready");
  await page.getByRole("button", { name: "重置视角", exact: true }).click();
  const screenshot = await preview.locator("canvas").screenshot();
  const legs = await page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const counts = { left: 0, right: 0 };
    for (let y = Math.floor(canvas.height * 0.65); y < canvas.height * 0.82; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const index = (y * canvas.width + x) * 4;
        if (pixels[index] > 80 && pixels[index] > pixels[index + 1] * 1.6 && pixels[index] > pixels[index + 2] * 1.6) {
          counts[x < canvas.width / 2 ? "left" : "right"]++;
        }
      }
    }
    return counts;
  }, screenshot.toString("base64"));
  expect(legs.left).toBeGreaterThan(200);
  expect(legs.right).toBeGreaterThan(200);

  await page.locator('input[aria-label="导入本地 PNG"]').setInputFiles({
    name: "broken.png",
    mimeType: "image/png",
    buffer: Buffer.from("not a PNG"),
  });
  await expect(preview).toHaveAttribute("data-character-state", "error");
  await page.getByRole("button", { name: "恢复默认预览", exact: true }).click();
  await expect(preview).toHaveAttribute("data-character-state", "ready");
  await expect(page.locator(".vx-character-canvas__error")).toHaveCount(0);
  expect(errors).toEqual([]);
});
