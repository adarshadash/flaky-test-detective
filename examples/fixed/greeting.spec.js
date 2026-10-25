import { test, expect } from '../../src/fixture.js';

// FIXED: control the clock, then assert the greeting for that controlled time.
test('header greets the engineer', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-01-15T20:00:00'));
  await page.goto('/');
  await expect(page.getByTestId('greeting')).toHaveText('Good evening, engineer');
});
