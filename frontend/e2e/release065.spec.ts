import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { saveSettings, navTo, signInToFixture } from './helpers';
import { backToList, openTab, removeCurrent, wishlistRows, wishlistTable } from './detail-helpers';

const columnList = (page: Page) => page.getByRole('list', { name: 'Spaltenreihenfolge der Wunschliste', exact: true });

test('the order of the wishlist columns is chosen in the settings, and the details button can stand before the cover', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInToFixture(page);
  await page.getByRole('searchbox', { name: 'Nach Spielen suchen', exact: true }).fill('forza');
  await page.getByRole('region', { name: 'Suchergebnisse' }).getByRole('button', { name: 'Forza Horizon 5 (Xbox Series X|S) vormerken', exact: true }).click();
  await expect(page).toHaveURL(/[?&]item=/);
  await backToList(page);
  // Default: the game first, the details button last.
  await expect(wishlistRows(page).first().locator('td').first()).toHaveClass(/c-game/);
  await expect(wishlistRows(page).first().locator('td').last()).toHaveClass(/c-more/);

  await navTo(page, 'Allgemein');
  const list = columnList(page);
  await expect(list.getByRole('listitem')).toHaveCount(8);
  await expect(list.getByRole('listitem').first()).toContainText('Spiel (Cover und Titel)');
  await expect(list.getByRole('button', { name: 'Spiel (Cover und Titel) nach oben', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Standard wiederherstellen', exact: true })).toBeDisabled();
  // Move "Details öffnen" from place 8 to the top with the keyboard: the focus stays on the moved column.
  await list.getByRole('button', { name: 'Details öffnen nach oben', exact: true }).click();
  for (let n = 0; n < 5; n++) await page.keyboard.press('Enter');
  await expect(list.getByRole('listitem').nth(1)).toContainText('Details öffnen');
  await expect(list.getByRole('button', { name: 'Details öffnen nach oben', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(list.getByRole('listitem').first()).toContainText('Details öffnen');
  // At the first place "nach oben" is disabled, so the focus moves to "nach unten" of the same column.
  await expect(list.getByRole('button', { name: 'Details öffnen nach unten', exact: true })).toBeFocused();
  await saveSettings(page);
  const saved = await (await page.request.get('/api/v1/settings')).json();
  expect(saved.wishlist_columns).toEqual(['open', 'game', 'price', 'world', 'save', 'target', 'status', 'trend']);
  await page.setViewportSize({ width: 320, height: 700 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });

  await navTo(page, 'Wunschliste');
  const table = wishlistTable(page);
  await expect(table.locator('thead th').first()).toHaveText('Öffnen');
  await expect(table.locator('thead th').nth(1)).toContainText('Spiel');
  const first = wishlistRows(page).first().locator('td');
  await expect(first.first()).toHaveClass(/c-more/);
  await expect(first.nth(1)).toHaveClass(/c-game/);
  await expect(first.last()).toHaveClass(/c-trend/);
  // The details button stands left of the cover.
  const open = (await first.first().getByRole('button', { name: /^Details zu / }).boundingBox())!;
  const cover = (await first.nth(1).locator('.gcover').boundingBox())!;
  expect(open.x + open.width).toBeLessThanOrEqual(cover.x);

  await navTo(page, 'Allgemein');
  await page.getByRole('button', { name: 'Standard wiederherstellen', exact: true }).click();
  await saveSettings(page);
  await expect(columnList(page).getByRole('listitem').first()).toContainText('Spiel (Cover und Titel)');
  expect((await (await page.request.get('/api/v1/settings')).json()).wishlist_columns).toEqual(['game', 'price', 'world', 'save', 'target', 'status', 'trend', 'open']);
  await navTo(page, 'Wunschliste');
  await wishlistRows(page).first().getByRole('button', { name: /^Details zu / }).click();
  await removeCurrent(page);
});

test('the price trend shows the steadily cheapest region and each product its check interval', async ({ page }) => {
  await signInToFixture(page);
  await page.getByRole('searchbox', { name: 'Nach Spielen suchen', exact: true }).fill('forza');
  await page.getByRole('region', { name: 'Suchergebnisse' }).getByRole('button', { name: 'Forza Horizon 5 (Xbox Series X|S) vormerken', exact: true }).click();
  await expect(page).toHaveURL(/[?&]item=/);
  const now = Math.floor(Date.now() / 1000);
  const link = (id: number, region: string, cents: number, score: number, every: number, availability = 'in_stock') => ({
    id, source: 'eneba', url: `https://www.eneba.com/de/xbox-forza-horizon-5-${region.toLowerCase()}-key`, review: 'confirmed', can_confirm: true,
    eligible: region === 'Germany', queued: false, enabled: true, stale: false, observed_at: now - 3600, attempted_at: now - 3600, last_error: null, retry_at: 0,
    reasons: region === 'Germany' ? [] : ['activation_unknown'], cheap_score: score, check_every: every,
    product: { name: `Forza Horizon 5 Xbox Key ${region}`, region, market: 'DE', activation: region === 'Germany' ? 'confirmed' : 'unknown', availability },
    quotes: availability === 'in_stock' ? [{ id: String(id), seller: null, base_cents: cents, estimated_total_cents: null }] : [],
  });
  const view = { links: [link(1, 'Germany', 3990, 0.5, 8 * 3600), link(2, 'Argentina', 1290, 0.04, 13 * 3600), link(3, 'Turkey', 2590, 0.93, 46 * 3600), link(4, 'India', 0, 0.5, 48 * 3600, 'sold_out')],
    histories: { preferred: [], all: [] }, history: [], best_base: 3990, best_estimate: null, target_country: 'DE', searches: [], sources: [], discovery_running: false };
  await page.route('**/api/v1/wishlist/*/offers', route => route.request().method() === 'GET' ? route.fulfill({ json: view }) : route.continue());
  await page.reload();
  await expect(page.locator('#why-list .trend')).toContainText('Meist am günstigsten: Argentinien · wird deshalb öfter abgefragt');
  await openTab(page, 'Infos');
  const match = (name: string) => page.locator('.match').filter({ hasText: name });
  await expect(match('Argentina').locator('.match-pace')).toHaveText('Abfrage alle 13 h · meist günstig');
  await expect(match('Turkey').locator('.match-pace')).toHaveText('Abfrage alle 46 h · meist teuer');
  await expect(match('India').locator('.match-pace')).toHaveText('Abfrage alle 2 Tage · ausverkauft, seltener geprüft');
  await expect(match('Germany').locator('.match-pace')).toHaveText('Abfrage alle 8 h');
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await removeCurrent(page);
});
