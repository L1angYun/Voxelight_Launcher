import { defineConfig } from "@playwright/test";
// D3D11 variant (mirrors worklogs/round3/native.config.mjs) on port 1430.
export default defineConfig({
  testDir: "../e2e",
  timeout: 45000,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:1430", viewport: { width: 1440, height: 1000 }, screenshot: "only-on-failure", channel: "chromium", deviceScaleFactor: 1, launchOptions: { args: ["--use-angle=d3d11"] } },
  webServer: { command: "npm run dev -- --port 1430", cwd: "../..", url: "http://127.0.0.1:1430", reuseExistingServer: false, timeout: 60000 },
  reporter: [["list"]],
});
