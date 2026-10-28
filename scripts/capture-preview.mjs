import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
const output = new URL("../docs/screenshots/0.5.0/", import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
});
page.on("pageerror", (error) => console.error(error.message));
await page.goto("http://127.0.0.1:1420");
await page.locator(".skin-viewer-loading").waitFor({ state: "hidden" });
await page.waitForTimeout(1500);
await page.screenshot({
  path: new URL("home.png", output).pathname.replace(/^\/(\w:)/, "$1"),
  fullPage: true,
});
await page.getByRole("button", { name: "角色与皮肤", exact: true }).click();
await page.waitForTimeout(4000);
await page.locator(".skin-viewer-loading").waitFor({ state: "hidden" });
await page.waitForTimeout(1000);
await page.screenshot({
  path: new URL("skins.png", output).pathname.replace(/^\/(\w:)/, "$1"),
  fullPage: true,
});
await browser.close();
console.log("Saved home.png and skins.png");
