import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { clearWishlist, offers, prepareLayout, settle } from './layout-mocks';

// 1.1.3: the direction of the price arrows is a setting ("Wie der Preis" by default), and the game page has a price outlook.

/** Sets the arrow direction through the API (the suite shares one database). */
async function setArrows(page: Page, arrows: 'price' | 'rating') {
  const { csrf_token: csrf } = await (await page.request.get('/api/v1/me')).json();
  const settings = await (await page.request.get('/api/v1/settings')).json();
  const response = await page.request.put('/api/v1/settings', {
    data: { ...settings, trend_arrows: arrows },
    headers: { 'X-CSRF-Token': csrf, Origin: new URL(page.url()).origin },
  });
  expect(response.ok()).toBe(true);
}

test.afterEach(async ({ page }) => {
  await setArrows(page, 'price').catch(() => undefined);
  await clearWishlist(page);
});

const mark = (page: Page, title: string, cell: 'c-de' | 'c-world') =>
  page.locator('table.wl tbody tr').filter({ hasText: title }).filter({ hasText: 'Standard Edition' }).locator(`td.${cell} .price-change`);

test('the arrows follow the price by default and say better or worse after switching the setting', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await prepareLayout(page);
  await page.goto('/');
  await expect(mark(page, 'Starfield', 'c-de')).toHaveClass(/\bbetter\b.*\bdown\b/);
  await expect(mark(page, 'Lies of P', 'c-de')).toHaveClass(/\bworse\b.*\bup\b/);
  await expect(mark(page, 'Indiana Jones', 'c-de')).toHaveClass(/\bsame\b.*\bright\b/);

  await page.goto('/?view=settings');
  const arrows = page.getByRole('radiogroup', { name: 'Preispfeile', exact: true });
  await expect(arrows.getByRole('radio', { name: 'Wie der Preis', exact: true })).toHaveAttribute('aria-checked', 'true');
  await arrows.getByRole('radio', { name: 'Besser oder schlechter', exact: true }).click();
  const saved = page.waitForResponse(r => r.request().method() === 'PUT' && new URL(r.url()).pathname === '/api/v1/settings');
  await page.getByRole('button', { name: 'Speichern', exact: true }).click();
  expect((await (await saved).json()).trend_arrows).toBe('rating');

  await page.goto('/');
  await expect(mark(page, 'Starfield', 'c-de')).toHaveClass(/\bbetter\b.*\bup\b/);
  await expect(mark(page, 'Starfield', 'c-world')).toHaveClass(/\bbetter\b.*\bup\b/);
  await expect(mark(page, 'Lies of P', 'c-de')).toHaveClass(/\bworse\b.*\bdown\b/);
  await expect(mark(page, 'Indiana Jones', 'c-de')).toHaveClass(/\bsame\b.*\bright\b/);
});

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0) / 1000;
const D = 86400;
/** One history point per day of the last 90 days, `price(back)` for the day `back` days ago. */
const history = (price: (back: number) => number | null) =>
  Array.from({ length: 91 }, (_, i) => 90 - i).map(back => ({
    observed_at: NOW - back * D - 3600,
    base_cents: price(back),
    link_id: 3,
    region: 'Global',
    source: 'eneba',
    fresh_until: NOW - back * D + D,
  }));

test('the price tab shows the price outlook in a box of its own', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1500 });
  const id = await prepareLayout(page);
  const due = (back: number) => ([86, 56, 26].some(start => back <= start && back > start - 5) ? 2799 : 3499);
  await page.route('**/api/v1/wishlist/*/offers', route =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: { ...offers, best_base: 3499, histories: { preferred: history(due), all: history(due) } } })
      : route.continue(),
  );
  await page.goto(`/?item=${id}`);
  const box = page.getByRole('region', { name: 'Preistendenz', exact: true });
  await expect(box).toBeVisible();
  await settle(page);
  await expect(box.getByText('Eher fallend', { exact: true })).toBeVisible();
  // The days are local days: depending on the time zone the last discount ended 21 or 22 days ago.
  await expect(box).toContainText(/Rabatte kamen bisher etwa alle 30 Tage, zuletzt vor 2[12] Tagen\. Der nächste wäre bald fällig\./);
  await expect(box).toContainText('Sicherheit mittel');
  await expect(box.locator('.price-change')).toHaveClass(/\bbetter\b.*\bdown\b/);
  await expect(box.getByRole('img', { name: 'Preisverlauf der letzten 90 Tage mit üblichem Preis und Rabatten', exact: true })).toBeVisible();
  // The outlook has its own box; "Warum dieser Preis zählt" carries no outlook line.
  await expect(page.getByRole('region', { name: 'Warum dieser Preis zählt', exact: true })).not.toContainText('Tendenz');

  // Too little history: the box says how much is missing.
  await page.unroute('**/api/v1/wishlist/*/offers');
  await page.route('**/api/v1/wishlist/*/offers', route =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: { ...offers, best_base: 3499, histories: { preferred: history(back => (back > 8 ? null : 3499)), all: [] } } })
      : route.continue(),
  );
  await page.reload();
  await expect(box).toContainText('Für eine Tendenz braucht KeyHunter mindestens 14 Tage Preisverlauf in Deutschland, bisher 9 Tage.');
});
