// Config for the probe test that verifies each variation really perturbs the browser.
import { defineConfig, devices } from '@playwright/test';

const PORT = 4180;
export default defineConfig({
  testDir: '.',
  timeout: 20_000,
  use: { baseURL: `http://localhost:${PORT}` },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `node ../../../demo-site/server.mjs ${PORT}`,
    url: `http://localhost:${PORT}/health`,
    reuseExistingServer: true,
  },
});
