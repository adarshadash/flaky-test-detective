import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.DEMO_PORT || 4173);
// Point BASE_URL at any public site (e.g. https://www.saucedemo.com) to investigate
// tests against it; by default the bundled FlakyMart demo shop is started locally.
const external = process.env.BASE_URL;

export default defineConfig({
  testDir: './examples',
  timeout: 15_000,
  expect: { timeout: 4_000 },
  reporter: [['list']],
  use: {
    baseURL: external || `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: external
    ? undefined
    : {
        command: `node demo-site/server.mjs ${PORT}`,
        url: `http://localhost:${PORT}/health`,
        reuseExistingServer: true,
        timeout: 10_000,
      },
});
