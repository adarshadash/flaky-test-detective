// Drop-in replacement for `@playwright/test`:
//
//   import { test, expect } from 'flaky-test-detective/fixture';
//
// When run normally it behaves exactly like Playwright. When the detective runs it
// (FTD_VARIATION set), it injects the requested perturbation and records signals
// (network timings, console errors, DOM snapshot at failure) as an attachment the
// analyzer reads back.
import { test as base, expect } from '@playwright/test';
import { currentVariation, fixedTimeToDate } from './variations.js';

const variation = currentVariation();

export const test = base.extend({
  // Built-in option overrides: pass the variation's timezone straight to the context.
  timezoneId: [variation.timezoneId ?? undefined, { option: true }],

  page: async ({ page, browserName }, use, testInfo) => {
    const signals = {
      variation: variation.name,
      requests: [],
      consoleErrors: [],
      pageErrors: [],
      appliedPerturbations: [],
    };

    // ── network latency ───────────────────────────────────────────────
    if (Array.isArray(variation.latencyMs)) {
      const [min, max] = variation.latencyMs;
      await page.route('**/*', async (route) => {
        const req = route.request();
        if (req.resourceType() === 'document') return route.continue();
        const delay = min + Math.floor(Math.random() * (max - min + 1));
        await new Promise((r) => setTimeout(r, delay));
        await route.continue();
      });
      signals.appliedPerturbations.push(`latency ${min}-${max}ms`);
    }

    // ── CPU throttle (Chromium only, via CDP) ─────────────────────────
    if (variation.cpuThrottle && browserName === 'chromium') {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: variation.cpuThrottle });
      signals.appliedPerturbations.push(`cpu x${variation.cpuThrottle}`);
    }

    // ── frozen clock ──────────────────────────────────────────────────
    if (variation.fixedTime) {
      await page.clock.setFixedTime(fixedTimeToDate(variation.fixedTime));
      signals.appliedPerturbations.push(`clock ${variation.fixedTime}`);
    }
    if (variation.timezoneId) signals.appliedPerturbations.push(`tz ${variation.timezoneId}`);

    // ── signal collection ─────────────────────────────────────────────
    const started = new Map();
    page.on('request', (r) => started.set(r, Date.now()));
    page.on('requestfinished', (r) => {
      const t0 = started.get(r);
      if (r.resourceType() === 'fetch' || r.resourceType() === 'xhr') {
        signals.requests.push({ method: r.method(), url: new URL(r.url()).pathname, ms: t0 ? Date.now() - t0 : null, at: Date.now() });
      }
    });
    page.on('console', (m) => m.type() === 'error' && signals.consoleErrors.push(m.text()));
    page.on('pageerror', (e) => signals.pageErrors.push(String(e)));
    const testStart = Date.now();

    await use(page);

    if (testInfo.status !== testInfo.expectedStatus) {
      try {
        signals.domAtFailure = (await page.locator('body').innerText({ timeout: 1000 })).slice(0, 1500);
      } catch {
        signals.domAtFailure = null;
      }
    }
    signals.requests = signals.requests.map((r) => ({ ...r, at: r.at - testStart }));
    await testInfo.attach('ftd-signals', { body: JSON.stringify(signals), contentType: 'application/json' });
  },
});

export { expect };
