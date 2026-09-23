// Config dedicado das capturas STK-UX-01/02.
// Não é usado pela CI: o playwright.config.ts da raiz aponta testDir './tests/e2e'.
// Uso: E2E_BASE_URL=http://127.0.0.1:8099 PLAYWRIGHT_CHANNEL=msedge \
//   npx playwright test --config tests/ux-capture/playwright.ux.config.ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  fullyParallel: true,
  workers: 2,
  expect: { timeout: 15_000 },
  forbidOnly: false,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'ux-report' }]],
  outputDir: 'ux-results',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8099',
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
    trace: 'off',
    screenshot: 'off',
  },
  projects: [
    {
      name: 'desktop-chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } },
    },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
  ],
});
