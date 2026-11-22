import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { signInToFixture, navTo, navItem } from './helpers';
import { wishlistHeading } from './detail-helpers';

/** GET requests to the API by path (without query), from now on. */
function recordReads(page: Page) {
  const reads: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname.startsWith('/api/v1/')) reads.push(url.pathname.slice('/api/v1'.length));
  });
  return (path: string) => reads.filter(read => read === path).length;
}

// CODE-08 / PERF-06: the navigation counts come from one small read, not from the full lists, and the sidebar card and
// the "Abrufe heute" tile share one /status/fetch poller.
test('the navigation reads /counts and the fetch status once, not the lists (CODE-08, PERF-06)', async ({ page }) => {
  await signInToFixture(page);
  const reads = recordReads(page);
  await page.reload();
  await expect(wishlistHeading(page)).toBeVisible();
  await expect(navItem(page, 'Warenkorb')).toContainText('0');
  await expect(navItem(page, 'Bibliothek')).toContainText('0');
  await expect(page.locator('.fetch-mini')).toBeVisible();
  await page.waitForTimeout(500);
  expect(reads('/status/fetch')).toBe(1);
  expect(reads('/counts')).toBe(1);
  for (const list of ['/library', '/cart']) expect(reads(list), list).toBe(0);
  // Another page: its own list, one count read, still no second fetch-status poller.
  await navTo(page, 'Warenkorb');
  await expect(page.getByRole('heading', { name: 'Warenkorb', level: 1 })).toBeVisible();
  await page.waitForTimeout(500);
  expect(reads('/cart')).toBe(1);
  expect(reads('/counts')).toBe(2);
  expect(reads('/library')).toBe(0);
  expect(reads('/wishlist')).toBe(1);
  expect(reads('/status/fetch')).toBe(1);
});
