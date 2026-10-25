import { test, expect } from '../../src/fixture.js';

// FLAKY: both tests reset and use the *same* server-side cart. Fine when tests run
// one at a time, broken as soon as two run at once (parallel workers / sharding).
test.beforeEach(async ({ request }) => {
  await request.delete('/api/cart');
});

test('cart keeps one item after reload', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('product')).toHaveCount(5);
  await page.getByTestId('add-2').click();
  await expect(page.getByTestId('cart-count')).toHaveText('1');
  await page.reload();
  await expect(page.getByTestId('cart-count')).toHaveText('1');
});

test('cart keeps two items after reload', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('product')).toHaveCount(5);
  await page.getByTestId('add-1').click();
  await expect(page.getByTestId('cart-count')).toHaveText('1');
  await page.getByTestId('add-4').click();
  await expect(page.getByTestId('cart-count')).toHaveText('2');
  await page.reload();
  await expect(page.getByTestId('cart-count')).toHaveText('2');
});
