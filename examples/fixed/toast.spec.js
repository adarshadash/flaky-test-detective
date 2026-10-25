import { test, expect } from '../../src/fixture.js';

// FIXED: wait for the toast state itself instead of guessing when it appears.
test('adding a product shows a confirmation toast', async ({ page }) => {
  await page.goto('/?sid=toast-' + Date.now() + Math.random());
  await expect(page.getByTestId('product')).toHaveCount(5);
  await page.getByTestId('add-3').click();
  const toast = page.getByTestId('toast');
  await expect(toast).toHaveClass(/show/);
  await expect(toast).toHaveText('Added CO2 Sensor');
});
