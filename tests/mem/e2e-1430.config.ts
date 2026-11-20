import { defineConfig } from "@playwright/test";
// Worktree-local copy of the default config on port 1430, so it never shares a
// dev server with runs on 1420 in the main checkout.
export default defineConfig({
  testDir: "../e2e",
  timeout: 45000,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:1430", viewport: { width: 1440, height: 1000 }, screenshot: "only-on-failure", launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] } },
  webServer: { command: "npm run dev -- --port 1430", cwd: "../..", url: "http://127.0.0.1:1430", reuseExistingServer: false, timeout: 60000 },
  reporter: [["list"]],
});
