import { test, expect } from '../../src/fixture.js';

// FIXED: web-first assertion retries until the products API has rendered.
test('catalog shows all 5 products', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('product')).toHaveCount(5);
});
