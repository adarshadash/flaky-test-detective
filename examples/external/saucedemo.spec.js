import { test, expect } from '../../src/fixture.js';

// Real public site: https://www.saucedemo.com (free practice app by Sauce Labs).
// Its `performance_glitch_user` logs in slowly — a perfect real-world source of
// flakiness. Run with:
//
//   BASE_URL=https://www.saucedemo.com npx ftd investigate examples/external -n 5
//
// The first test is written the "it works on my machine" way; the second is the fix.

async function login(page, user) {
  await page.goto('/');
  await page.getByPlaceholder('Username').fill(user);
  await page.getByPlaceholder('Password').fill('secret_sauce');
  await page.getByRole('button', { name: 'Login' }).click();
}

test('glitch user sees 6 products (FLAKY: fixed sleep)', async ({ page }) => {
  await login(page, 'performance_glitch_user');
  await page.waitForTimeout(3000);
  expect(await page.locator('.inventory_item').count()).toBe(6);
});

test('glitch user sees 6 products (fixed: web-first assertion)', async ({ page }) => {
  await login(page, 'performance_glitch_user');
  await expect(page.locator('.inventory_item')).toHaveCount(6, { timeout: 15_000 });
});

test('standard user can add a backpack to the cart', async ({ page }) => {
  await login(page, 'standard_user');
  await page.locator('[data-test="add-to-cart-sauce-labs-backpack"]').click();
  await expect(page.locator('.shopping_cart_badge')).toHaveText('1');
});
