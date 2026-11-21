import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { navItem, navTo, signInToFixture } from './helpers';
import { backToList, wishlistRows } from './detail-helpers';

/** A write to the API as the page would send it (origin and CSRF token). */
async function write(page: Page, method: 'POST' | 'DELETE', path: string, data?: object) {
  const { csrf_token: csrf } = await (await page.request.get('/api/v1/me')).json();
  return page.request.fetch(path, { method, data, headers: { 'X-CSRF-Token': csrf, Origin: new URL(page.url()).origin } });
}

// The suite shares one database: remove every wishlist and library entry a test leaves behind.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  for (const path of ['/api/v1/wishlist', '/api/v1/library']) {
    for (const item of await (await page.request.get(path)).json()) await write(page, 'DELETE', `/api/v1/wishlist/${item.id}`);
  }
});

const t = () => Math.floor(Date.now() / 1000) - 3600;
const price = (cents: number, source: string, estimate: number | null, world: { cents: number; estimate: number | null; source: string; region: string }) => ({
  state: 'price', cents, source, region: 'Global', observed_at: t(), checked_at: t(), stale: false, pending: false, estimate_cents: estimate,
  world: { cents: world.cents, base_cents: world.cents, estimate_cents: world.estimate, source: world.source, region: world.region, observed_at: t() },
});

test('wishes go into the cart once, show a basket in the list, and the cart sums keys and fees by shop', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInToFixture(page);
  const base = (await (await write(page, 'POST', '/api/v1/wishlist', { igdb_id: 1001, platform_id: 169 })).json()).item.id;
  const premium = (await (await write(page, 'POST', '/api/v1/wishlist', { igdb_id: 1002, platform_id: 169 })).json()).item.id;
  await page.goto(`/?item=${base}`);
  await expect(navItem(page, 'Warenkorb')).toContainText('0');

  // Into the cart from the game page; once only.
  const cartButton = page.getByRole('button', { name: 'In den Warenkorb', exact: true });
  await cartButton.click();
  await expect(page.getByRole('button', { name: 'Im Warenkorb', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(navItem(page, 'Warenkorb')).toContainText('1');
  expect((await write(page, 'POST', '/api/v1/cart', { wish_id: base })).status()).toBe(409);

  // The list marks it with a basket after the name.
  await backToList(page);
  const forza = wishlistRows(page).filter({ hasText: 'Standard Edition' });
  await expect(forza.getByRole('img', { name: 'im Warenkorb', exact: true })).toBeVisible();
  await expect(wishlistRows(page).filter({ hasText: 'Premium' }).getByRole('img', { name: 'im Warenkorb' })).toHaveCount(0);

  // Real prices from the badges: Eneba with 10 % fees, Driffle without a fee estimate.
  await page.route('**/api/v1/cart', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const entries = await response.json();
    const badges: Record<string, object> = {
      [base]: price(2890, 'eneba', 3179, { cents: 1290, estimate: 1419, source: 'eneba', region: 'India' }),
      [premium]: price(4000, 'driffle', null, { cents: 3500, estimate: null, source: 'driffle', region: 'Turkey' }),
    };
    await route.fulfill({ response, json: entries.map((entry: { id: string }) => ({ ...entry, price_badge: badges[entry.id] })) });
  });
  await navTo(page, 'Warenkorb');
  await expect(page.getByRole('heading', { name: 'Warenkorb', level: 1 })).toBeVisible();
  const table = page.getByRole('table', { name: 'Spiele im Warenkorb', exact: true });
  await expect(table.locator('tbody tr')).toHaveCount(1);
  // The second one from the picker; a wish already in the cart is not offered.
  const picker = page.getByLabel('Spiel aus der Wunschliste wählen');
  await expect(picker.locator('option')).toHaveCount(2);
  await picker.selectOption({ label: 'Forza Horizon 5: Premium Edition' });
  await page.getByRole('button', { name: 'In den Warenkorb', exact: true }).click();
  await expect(table.locator('tbody tr')).toHaveCount(2);
  await expect(navItem(page, 'Warenkorb')).toContainText('2');
  // Nothing left to add: no picker.
  await expect(picker).toHaveCount(0);

  const rowOf = (name: string | RegExp) => table.locator('tbody tr').filter({ hasText: name });
  await expect(rowOf('Premium')).toContainText('Driffle');
  await expect(rowOf('Premium').locator('.c-fee')).toHaveText('unbekannt');
  await expect(table.locator('tbody tr').first().locator('.c-fee')).toContainText('+2,89');
  const sum = page.getByRole('region', { name: /^Gesamt/ });
  const shops = sum.getByRole('list', { name: 'Nach Shops' }).getByRole('listitem');
  await expect(shops).toHaveCount(2);
  await expect(shops.filter({ hasText: 'Eneba' })).toContainText('31,79');
  await expect(sum.locator('.cart-totals')).toContainText(/Reine Key-Kosten\s*68,90/);
  await expect(sum.locator('.cart-totals')).toContainText(/Gebühren \(geschätzt\)\s*\+2,89/);
  await expect(sum.locator('.cart-totals')).toContainText(/Gesamt mit Gebühren\s*71,79/);
  await expect(sum.locator('.cart-totals')).toContainText(/Gesamt ohne Gebühren\s*68,90/);
  await expect(sum).toContainText('Für Driffle ist keine Gebührenschätzung eingestellt');

  // Preis INT: the cheapest region of each game.
  await page.getByRole('radiogroup', { name: 'Preisgrundlage' }).getByRole('radio', { name: 'Preis INT', exact: true }).click();
  await expect(sum.locator('.cart-totals')).toContainText(/Reine Key-Kosten\s*47,90/);
  await expect(sum.locator('.cart-totals')).toContainText(/Gesamt mit Gebühren\s*49,19/);
  await page.getByRole('radiogroup', { name: 'Preisgrundlage' }).getByRole('radio', { name: /^Preis (DE|Zielland)$/ }).click();

  // Out again by hand.
  await page.getByRole('button', { name: 'Forza Horizon 5: Premium Edition aus dem Warenkorb nehmen', exact: true }).click();
  await expect(table.locator('tbody tr')).toHaveCount(1);
  await expect(navItem(page, 'Warenkorb')).toContainText('1');

  // Bought: gone from the cart as well.
  await table.getByRole('button', { name: 'Forza Horizon 5', exact: true }).click();
  await page.getByRole('button', { name: 'Gekauft', exact: true }).click();
  await expect(navItem(page, 'Warenkorb')).toContainText('0');
  await navTo(page, 'Warenkorb');
  await expect(page.getByRole('heading', { name: 'Der Warenkorb ist leer' })).toBeVisible();
});
