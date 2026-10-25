import { test, expect } from '../../src/fixture.js';

// FLAKY: checks a transient toast after a fixed delay; the toast appears after a
// variable delay and only stays for ~1.2s.
test('adding a product shows a confirmation toast', async ({ page }) => {
  await page.goto('/?sid=toast-' + Date.now() + Math.random());
  await expect(page.getByTestId('product')).toHaveCount(5);
  await page.getByTestId('add-3').click();
  await page.waitForTimeout(700);
  const shown = await page.getByTestId('toast').evaluate((el) => el.classList.contains('show'));
  expect(shown).toBe(true);
});
