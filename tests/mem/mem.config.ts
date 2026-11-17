import { defineConfig } from "@playwright/test";
// Memory A/B harness: headed Chromium forced onto the low-power (integrated) GPU.
export default defineConfig({
  testDir: ".",
  timeout: 600_000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:1430",
    headless: false,
    viewport: { width: 1440, height: 930 },
    deviceScaleFactor: 1.5,
    launchOptions: { args: ["--force_low_power_gpu", "--use-angle=d3d11", "--vx-mem-marker"] },
  },
  webServer: { command: "npm run dev -- --port 1430", cwd: "../..", url: "http://127.0.0.1:1430", reuseExistingServer: false, timeout: 60_000 },
  reporter: [["line"]],
});
