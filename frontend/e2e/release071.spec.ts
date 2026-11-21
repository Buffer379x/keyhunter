import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { navTo, saveSettings, signInToFixture } from './helpers';
import { backToList, removeCurrent, wishlistRows, wishlistTable } from './detail-helpers';

async function addForza(page: Page) {
  await page.getByRole('searchbox', { name: 'Nach Spielen suchen', exact: true }).fill('forza');
  await page.getByRole('region', { name: 'Suchergebnisse' }).getByRole('button', { name: 'Forza Horizon 5 (Xbox Series X|S) vormerken', exact: true }).click();
  await expect(page).toHaveURL(/[?&]item=/);
}
const columnList = (page: Page) => page.getByRole('list', { name: 'Spaltenreihenfolge der Wunschliste', exact: true });
const visibility = (page: Page, name: string) => columnList(page).getByRole('switch', { name: `${name} anzeigen`, exact: true });

test('columns can be hidden, and either the button, the title or the cover opens the game', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInToFixture(page);
  await addForza(page);
  await backToList(page);
  await navTo(page, 'Allgemein');
  const mode = page.getByRole('radiogroup', { name: 'Detailseite öffnen über', exact: true });
  await expect(mode.getByRole('radio', { name: 'Button', exact: true })).toBeChecked();
  // The button opens the game: its column cannot be hidden.
  await expect(visibility(page, 'Details öffnen')).toBeDisabled();
  await expect(visibility(page, 'Details öffnen')).toBeChecked();
  await visibility(page, 'Ziel').click();
  await visibility(page, '14 Tage').click();
  await mode.getByRole('radio', { name: 'Titel', exact: true }).click();
  // Now the title opens it: the game column stays, the button column is gone.
  await expect(visibility(page, 'Spiel (Cover und Titel)')).toBeDisabled();
  await expect(visibility(page, 'Details öffnen')).not.toBeChecked();
  await saveSettings(page);
  const saved = await (await page.request.get('/api/v1/settings')).json();
  expect(saved.wishlist_open).toBe('title');
  expect([...saved.wishlist_hidden].sort()).toEqual(['target', 'trend']);

  await navTo(page, 'Wunschliste');
  const head = wishlistTable(page).locator('thead th');
  await expect(head).toHaveText(['Spiel', /^Preis [A-Z]{2}$/, 'Preis INT', 'Ersparnis', 'Status']);
  const row = wishlistRows(page).first();
  await expect(row.getByRole('button', { name: /^Details zu / })).toHaveCount(0);
  await expect(row.locator('.cover-open')).toHaveCount(0);
  await row.getByRole('button', { name: 'Forza Horizon 5', exact: true }).click();
  await expect(page).toHaveURL(/[?&]item=/);
  await backToList(page);

  await navTo(page, 'Allgemein');
  await mode.getByRole('radio', { name: 'Cover', exact: true }).click();
  await saveSettings(page);
  await navTo(page, 'Wunschliste');
  await expect(row.locator('.title-open')).toHaveCount(0);
  await row.getByRole('button', { name: 'Details zu Forza Horizon 5', exact: true }).click();
  await expect(page).toHaveURL(/[?&]item=/);
  await backToList(page);

  await navTo(page, 'Allgemein');
  await page.getByRole('button', { name: 'Standard wiederherstellen', exact: true }).click();
  await saveSettings(page);
  const reset = await (await page.request.get('/api/v1/settings')).json();
  expect([reset.wishlist_open, reset.wishlist_hidden]).toEqual(['button', []]);
  await navTo(page, 'Wunschliste');
  await row.getByRole('button', { name: /^Details zu / }).click();
  await removeCurrent(page);
});

test('Preis DE and Preis INT show only the shop under the price', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInToFixture(page);
  await addForza(page);
  const id = new URL(page.url()).searchParams.get('item')!;
  const now = Math.floor(Date.now() / 1000);
  await page.route(/\/api\/v1\/wishlist\/price-badges(?:\?.*)?$/, route => route.fulfill({ json: { [id]: {
    state: 'price', cents: 2890, source: 'eneba', region: 'Germany', observed_at: now - 3600, checked_at: now - 3600, stale: false, pending: false,
    world: { cents: 1290, source: 'driffle', region: 'India', observed_at: now - 3600 } } } }));
  await backToList(page);
  const row = wishlistRows(page).first();
  await expect(wishlistTable(page).locator('thead th').nth(2)).toHaveText('Preis INT');
  await expect(row.locator('.c-de .wl-sub')).toHaveText('Eneba');
  await expect(row.locator('.c-world .wl-sub')).toHaveText('Driffle');
  await expect(row.locator('.c-world')).toContainText('12,90');
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await row.getByRole('button', { name: /^Details zu / }).click();
  await removeCurrent(page);
});

test('the Abrufstatus card in the sidebar pauses and resumes the automatic checks', async ({ page }) => {
  await signInToFixture(page);
  const card = page.locator('.fetch-mini');
  await card.getByRole('button', { name: 'Automatische Abfragen pausieren', exact: true }).click();
  await expect(card).toContainText('Pausiert seit');
  await expect(card.locator('.fetch-row').first()).toContainText('pausiert');
  expect((await (await page.request.get('/api/v1/status/fetch')).json()).paused_at).toEqual(expect.any(Number));
  // The settings page only shows the state; the control lives in the card.
  await card.locator('.fetch-open').click();
  await expect(page).toHaveURL(/section=status/);
  await expect(page.getByRole('region', { name: 'Automatische Abfragen' })).toHaveCount(0);
  await expect(page.getByRole('article', { name: 'Abrufstatus Eneba' })).toContainText('Pausiert');
  await card.getByRole('button', { name: 'Automatische Abfragen fortsetzen', exact: true }).click();
  await expect(card).not.toContainText('Pausiert seit');
  expect((await (await page.request.get('/api/v1/status/fetch')).json()).paused_at).toBeNull();
  await expect(page.getByRole('article', { name: 'Abrufstatus Eneba' })).not.toContainText('Pausiert');
});
