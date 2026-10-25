import { test, expect } from '../../../src/fixture.js';

// Measures what the browser actually experienced and attaches it for the test to inspect.
test('probe environment', async ({ page }, testInfo) => {
  const t0 = Date.now();
  await page.goto('/');
  await expect(page.getByTestId('product')).toHaveCount(5, { timeout: 10_000 });
  const loadMs = Date.now() - t0;
  const env = await page.evaluate(async () => {
    // a fixed chunk of JS work: its wall time grows with CPU throttling
    const start = performance.now();
    let x = 0;
    for (let i = 0; i < 3e6; i++) x += Math.sqrt(i);
    return {
      hour: new Date().getHours(),
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      greeting: document.querySelector('[data-testid=greeting]').textContent,
      workMs: performance.now() - start,
      x,
    };
  });
  await testInfo.attach('probe', { body: JSON.stringify({ ...env, loadMs }), contentType: 'application/json' });
});
