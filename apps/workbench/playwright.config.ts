import { defineConfig, devices } from '@playwright/test';

// Real FE+BE browser smoke. The spec starts the compiled core-api and the production
// Next server itself (it must stop/restart the backend), so no `webServer` block.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: { trace: 'retain-on-failure', locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
