import { test, expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { navTo, signInToFixture } from './helpers';
import { clearWishlist, prepareLayout, settle } from './layout-mocks';

// 1.1.2: the arrow of the last price change before Preis DE and Preis INT, and the manual library entry next to catalog hits.

/** A write to the API as the page would send it (origin and CSRF token). */
async function write(page: Page, method: 'DELETE', path: string) {
  const { csrf_token: csrf } = await (await page.request.get('/api/v1/me')).json();
  return page.request.fetch(path, { method, headers: { 'X-CSRF-Token': csrf, Origin: new URL(page.url()).origin } });
}

test.afterEach(async ({ page }) => {
  await clearWishlist(page);
  const library = await page.request.get('/api/v1/library');
  if (library.ok()) for (const item of await library.json()) await write(page, 'DELETE', `/api/v1/wishlist/${item.id}`);
});

const row = (page: Page, title: string, subline: string) => page.locator('table.wl tbody tr').filter({ hasText: title }).filter({ hasText: subline });
/** Tone and label of the arrow in a price cell, null without one. */
async function arrow(cell: Locator) {
  const mark = cell.locator('.price-change');
  if (!(await mark.count())) return null;
  const classes = (await mark.getAttribute('class')) ?? '';
  return { tone: classes.replace('price-change', '').trim(), label: ((await mark.getAttribute('aria-label')) ?? '').replace(/\s/g, ' ') };
}

test('the last price change shows as an arrow before Preis DE and Preis INT', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await prepareLayout(page);
  await page.goto('/');
  await expect(row(page, 'Starfield', 'Standard Edition')).toBeVisible();
  await settle(page);
  const cells = async (title: string, subline: string) => {
    const r = row(page, title, subline);
    return [await arrow(r.locator('td.c-de')), await arrow(r.locator('td.c-world'))];
  };
  expect(await cells('Starfield', 'Standard Edition')).toEqual([
    { tone: 'better', label: 'Günstiger geworden (vor 6 Std.): −2,00 €, vorher 36,99 €' },
    { tone: 'better', label: 'Günstiger geworden (vor 6 Std.): −1,50 €, vorher 19,90 €' },
  ]);
  expect(await cells('Lies of P', 'Standard Edition')).toEqual([
    { tone: 'worse', label: 'Teurer geworden (vor 6 Std.): +1,00 €, vorher 17,99 €' },
    { tone: 'worse', label: 'Teurer geworden (vor 6 Std.): +1,00 €, vorher 11,50 €' },
  ]);
  // The target country itself is the cheapest region: both cells unchanged.
  const same = { tone: 'same', label: 'Unverändert in den letzten 14 Tagen' };
  expect(await cells('Indiana Jones', 'Standard Edition')).toEqual([same, same]);
  expect(await cells('Splinter Cell', 'Classic Edition')).toEqual([same, { tone: 'better', label: 'Günstiger geworden (vor 6 Std.): −0,50 €, vorher 5,49 €' }]);
  // No arrow for a price that is only the last known one, nor without a change from the server.
  expect(await cells('Hogwarts Legacy', 'Xbox One')).toEqual([null, null]);
  expect(await cells('Starfield', 'Premium Edition')).toEqual([{ tone: 'worse', label: 'Teurer geworden (vor 6 Std.): +5,00 €, vorher 54,99 €' }, null]);
  // The narrow card keeps the arrow before the price.
  await page.setViewportSize({ width: 390, height: 900 });
  const card = row(page, 'Starfield', 'Standard Edition');
  const [mark, price] = [card.locator('td.c-de .price-change'), card.locator('td.c-de .price')];
  await expect(mark).toBeVisible();
  const [a, b] = [await mark.boundingBox(), await price.boundingBox()];
  expect(a!.x + a!.width).toBeLessThanOrEqual(b!.x);
  expect(Math.abs(a!.y + a!.height / 2 - (b!.y + b!.height / 2))).toBeLessThan(4);
});

test('the library offers a manual entry next to catalog hits, the wishlist only without hits', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInToFixture(page);
  const query = (dialog: Locator) => dialog.getByLabel('Spiel im Katalog suchen');

  await navTo(page, 'Wunschliste');
  await page.getByRole('banner').getByRole('button', { name: 'Spiel hinzufügen', exact: true }).click();
  const wish = page.getByRole('dialog', { name: 'Spiel hinzufügen', exact: true });
  await query(wish).fill('forza');
  await expect(wish.getByRole('status')).toContainText('Treffer');
  await expect(wish.getByRole('button', { name: 'Ungeprüft vormerken', exact: true })).toHaveCount(0);
  await query(wish).fill('kein Katalogspiel');
  await expect(wish.getByRole('button', { name: 'Ungeprüft vormerken', exact: true })).toBeVisible();
  await wish.getByRole('button', { name: 'Suche schließen', exact: true }).click();

  await navTo(page, 'Bibliothek');
  await page.getByRole('banner').getByRole('button', { name: 'Spiel hinzufügen', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Zur Bibliothek hinzufügen', exact: true });
  await query(dialog).fill('Forza Horizon');
  await expect(dialog.getByRole('status')).toContainText('Treffer für alle Xbox-Systeme');
  await expect(dialog.getByRole('heading', { name: 'Nicht dabei? Manuell hinzufügen', exact: true })).toBeVisible();
  await dialog.getByLabel('System', { exact: true }).selectOption({ label: 'Xbox One' });
  await dialog.getByRole('button', { name: 'Ohne Katalog hinzufügen', exact: true }).click();
  await expect(dialog).toBeHidden();
  const [owned] = await (await page.request.get('/api/v1/library')).json();
  expect([owned.manual_title, owned.platform_id, owned.game]).toEqual(['Forza Horizon', 49, null]);
  await expect(page.getByRole('list', { name: 'Meine Spiele' })).toContainText('Forza Horizon');
});
