import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { signInToFixture } from './helpers';
import { wishlistRows } from './detail-helpers';

/** A write to the API as the page would send it (origin and CSRF token). */
async function write(page: Page, method: 'POST' | 'DELETE', path: string, data?: object) {
  const { csrf_token: csrf } = await (await page.request.get('/api/v1/me')).json();
  const response = await page.request.fetch(path, { method, data, headers: { 'X-CSRF-Token': csrf, Origin: new URL(page.url()).origin } });
  expect(response.ok(), `${method} ${path}`).toBe(true);
  return response.json().catch(() => null);
}

// The suite shares one database: remove every wishlist entry a test leaves behind.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  for (const item of await (await page.request.get('/api/v1/wishlist')).json()) await write(page, 'DELETE', `/api/v1/wishlist/${item.id}`);
});

test('the list filter also takes a shop name and keeps the games where that shop is cheapest', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInToFixture(page);
  const base = (await write(page, 'POST', '/api/v1/wishlist', { igdb_id: 1001, platform_id: 169 })).item.id;
  const premium = (await write(page, 'POST', '/api/v1/wishlist', { igdb_id: 1002, platform_id: 169 })).item.id;
  const t = Math.floor(Date.now() / 1000) - 3600;
  const badge = (source: string, world: string) => ({
    state: 'price',
    cents: 2890,
    source,
    region: 'Global',
    observed_at: t,
    checked_at: t,
    stale: false,
    pending: false,
    world: { cents: 1290, source: world, region: 'India', observed_at: t },
  });
  // Base game: cheapest in Germany at Eneba, worldwide at Driffle. Premium: Driffle for both.
  await page.route(/\/api\/v1\/wishlist\/price-badges(?:\?.*)?$/, route =>
    route.fulfill({ json: { [base]: badge('eneba', 'driffle'), [premium]: badge('driffle', 'driffle') } }),
  );
  await page.goto('/');
  const filter = page.getByLabel('Liste filtern');
  await expect(filter).toHaveAttribute('placeholder', 'Spiel oder Shop filtern …');
  await expect(wishlistRows(page)).toHaveCount(2);
  const note = page.locator('.wl-shop-note');

  await filter.fill('Eneba');
  await expect(wishlistRows(page)).toHaveCount(1);
  await expect(wishlistRows(page).first()).toContainText('Forza Horizon 5');
  await expect(wishlistRows(page).first()).not.toContainText('Premium');
  await expect(note).toHaveText(/^Eneba: Spiele, bei denen dieser Shop den günstigsten Preis DE oder INT hat\.$/);

  await filter.fill('drif');
  await expect(wishlistRows(page)).toHaveCount(2);
  await expect(note).toContainText('Driffle');

  // A title still filters by title, without the shop note.
  await filter.fill('Premium');
  await expect(wishlistRows(page)).toHaveCount(1);
  await expect(wishlistRows(page).first()).toContainText('Premium');
  await expect(note).toHaveCount(0);

  await filter.fill('Gamivo');
  await expect(page.getByText('Kein Spiel passt zu diesem Filter.')).toBeVisible();
});
