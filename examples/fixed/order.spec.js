import { test, expect } from '../../src/fixture.js';

// FIXED: ask the API for a deterministic order before asserting on position.
test('first product in the catalog is Arduino Uno', async ({ page }) => {
  await page.goto('/?sort=name');
  await expect(page.getByTestId('product')).toHaveCount(5);
  await expect(page.getByTestId('product').first().locator('.name')).toHaveText('Arduino Uno');
});
