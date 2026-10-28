import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 45000,
  workers: 4,
  use: { baseURL: 'http://127.0.0.1:1420', viewport: {width: 1440, height: 1000}, screenshot: 'only-on-failure', launchOptions: {args:['--use-angle=swiftshader', '--enable-unsafe-swiftshader']} },
  webServer: { command: 'npm run dev', url: 'http://127.0.0.1:1420', reuseExistingServer: !process.env.CI, timeout: 60000 },
  reporter: [['list']],
});
