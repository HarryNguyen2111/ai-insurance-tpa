import { defineConfig, devices } from '@playwright/test';

// Browser smoke for the synthetic Zalo Mini App prototype. Serves the PRODUCTION bundle (dist/) with
// `vite preview`, i.e. exactly what the bundle-size gate measured, in a mobile Chromium viewport.
const PORT = 3201;

export default defineConfig({
  testDir: './e2e',
  // Keep test-results/ itself (bundle-size.json from the build lives there); Playwright clears only this subdir.
  outputDir: './test-results/playwright',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    locale: 'vi-VN',
    timezoneId: 'Asia/Ho_Chi_Minh',
  },
  projects: [{ name: 'mobile-chromium', use: { ...devices['Pixel 7'] } }],
  webServer: {
    command: 'pnpm preview',
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
