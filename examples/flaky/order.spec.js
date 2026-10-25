import { test, expect } from '../../src/fixture.js';

// FLAKY: assumes the API returns products in alphabetical order. It doesn't.
test('first product in the catalog is Arduino Uno', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('product')).toHaveCount(5);
  await expect(page.getByTestId('product').first().locator('.name')).toHaveText('Arduino Uno', { timeout: 1000 });
});
