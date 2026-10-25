import { test, expect } from '../../src/fixture.js';

// FIXED: every test gets its own cart (session id derived from testInfo), so tests
// can run in parallel without touching each other's data.
let sid;
test.beforeEach(async ({ request }, testInfo) => {
  sid = `${testInfo.testId}-${testInfo.repeatEachIndex}-${testInfo.workerIndex}`;
  await request.delete(`/api/cart?sid=${sid}`);
});

test('cart keeps one item after reload', async ({ page }) => {
  await page.goto(`/?sid=${sid}`);
  await expect(page.getByTestId('product')).toHaveCount(5);
  await page.getByTestId('add-2').click();
  await expect(page.getByTestId('cart-count')).toHaveText('1');
  await page.reload();
  await expect(page.getByTestId('cart-count')).toHaveText('1');
});

test('cart keeps two items after reload', async ({ page }) => {
  await page.goto(`/?sid=${sid}`);
  await expect(page.getByTestId('product')).toHaveCount(5);
  await page.getByTestId('add-1').click();
  await expect(page.getByTestId('cart-count')).toHaveText('1');
  await page.getByTestId('add-4').click();
  await expect(page.getByTestId('cart-count')).toHaveText('2');
  await page.reload();
  await expect(page.getByTestId('cart-count')).toHaveText('2');
});
