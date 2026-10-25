import { test, expect } from '../../src/fixture.js';

// FLAKY: written at night, so it "always passed" for its author.
test('header greets the engineer', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('greeting')).toHaveText('Good evening, engineer', { timeout: 1000 });
});
