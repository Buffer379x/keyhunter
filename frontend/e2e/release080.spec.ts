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

  // Real offers per shop (0.8.1): Eneba with 10 % fees, Driffle without a fee estimate.
  const offer = (cents: number, estimate: number | null, region: string) => ({ cents, estimate_cents: estimate, region, observed_at: t(), stale: false });
  const offers: Record<string, object> = {
    [base]: { eneba: { home: offer(2890, 3179, 'Global'), world: offer(1290, 1419, 'India') }, driffle: { home: offer(3100, null, 'Europe'), world: offer(1500, null, 'Turkey') } },
    [premium]: { driffle: { home: offer(4000, null, 'Europe'), world: offer(3500, null, 'Turkey') } },
  };
  await page.route('**/api/v1/cart', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const entries = await response.json();
    await route.fulfill({ response, json: entries.map((entry: { id: string }) => ({ ...entry, offers: offers[entry.id] ?? {} })) });
  });
  const changes: unknown[] = [];
  page.on('request', request => { if (request.method() === 'PUT' && request.url().includes('/api/v1/cart/')) changes.push(request.postDataJSON()); });
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

  // Added with the button: the cheapest variant, shop and region independent.
  const line = table.locator('tbody tr').first();
  const premiumRow = table.locator('tbody tr').filter({ hasText: 'Premium' });
  const shopOf = (row: typeof line) => row.getByRole('combobox', { name: /^Shop für / });
  await expect(shopOf(line)).toHaveValue('');
  await expect(shopOf(line).locator('option:checked')).toHaveText('Günstigster (Eneba)');
  await expect(line.locator('.c-key')).toContainText('12,90');
  await expect(line.locator('.c-fee')).toContainText('+1,29');
  await expect(premiumRow.locator('.c-fee')).toHaveText('unbekannt');
  const sum = page.getByRole('region', { name: 'Gesamt', exact: true });
  const shops = sum.getByRole('list', { name: 'Nach Shops' }).getByRole('listitem');
  await expect(shops).toHaveCount(2);
  await expect(shops.filter({ hasText: 'Eneba' })).toContainText('14,19');
  const totals = sum.locator('.cart-totals');
  await expect(totals).toContainText(/Reine Key-Kosten\s*47,90/);
  await expect(totals).toContainText(/Gebühren \(geschätzt\)[\s\S]*\+1,29/);
  await expect(totals).toContainText(/Gesamt mit Gebühren\s*49,19/);
  await expect(sum).toContainText('Für Driffle ist keine Gebührenschätzung eingestellt');
  await expect(sum.getByRole('definition').filter({ hasText: 'mit Gebühren ·' })).toHaveCount(0);

  // DE for this game: the price of its shop (Eneba) valid in the target country; the extra cost shows.
  const scopeOf = (row: typeof line) => row.getByRole('radiogroup', { name: /^Preisgrundlage für / });
  await scopeOf(line).getByRole('radio').first().click();
  await expect(line.locator('.c-key')).toContainText('28,90');
  await expect.poll(() => changes.at(-1)).toEqual({ source: 'eneba', scope: 'home' });
  await expect(totals).toContainText(/Gesamt mit Gebühren\s*66,79/);
  const extra = sum.locator('.cart-extra');
  await expect(extra).toContainText('Mehrkosten gegenüber der günstigsten Zusammensetzung');
  await expect(extra).toContainText(/\+17,60\s€ mit Gebühren · \+16,00\s€ Keys/);

  // Another shop: DE/INT now counts for Driffle.
  await shopOf(line).selectOption('driffle');
  await expect.poll(() => changes.at(-1)).toEqual({ source: 'driffle', scope: 'home' });
  await expect(line.locator('.c-key')).toContainText('31,00');
  await expect(line.locator('.c-fee')).toHaveText('unbekannt');
  await expect(extra).toContainText(/\+16,81\s€ mit Gebühren · \+18,10\s€ Keys/);
  await scopeOf(line).getByRole('radio', { name: 'INT', exact: true }).click();
  await expect.poll(() => changes.at(-1)).toEqual({ source: 'driffle', scope: 'world' });
  await expect(line.locator('.c-key')).toContainText('15,00');
  // Back to the cheapest: no extra cost.
  await shopOf(line).selectOption('');
  await expect.poll(() => changes.at(-1)).toEqual({ source: null, scope: 'world' });
  await expect(line.locator('.c-key')).toContainText('12,90');
  await expect(extra).toHaveCount(0);

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
