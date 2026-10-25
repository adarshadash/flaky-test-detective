import { test, expect } from '../../src/fixture.js';

// CONTROL: a well-written test. The detective should report it as stable.
test('search filters the catalog', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('product')).toHaveCount(5);
  await page.getByTestId('search').fill('sensor');
  await expect(page.getByTestId('product')).toHaveCount(1);
  await expect(page.getByTestId('product').locator('.name')).toHaveText('CO2 Sensor');
});
