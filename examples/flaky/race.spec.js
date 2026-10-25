import { test, expect } from '../../src/fixture.js';

// FLAKY: hard-coded sleep instead of waiting for the products API to render.
test('catalog shows all 5 products', async ({ page }) => {
  await page.goto('/');
  await page.waitForTimeout(500);
  const count = await page.getByTestId('product').count();
  expect(count).toBe(5);
});
