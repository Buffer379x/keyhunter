import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { expectSettingsSaved, navTo, signInToFixture } from './helpers';
import { backToList, removeCurrent, wishlistRows, wishlistTable } from './detail-helpers';

const columnList = (page: Page) => page.getByRole('list', { name: 'Spaltenreihenfolge der Wunschliste', exact: true });

test('the order of the wishlist columns is chosen in the settings, and the details button can stand before the cover', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInToFixture(page);
  await page.getByRole('searchbox', { name: 'Nach Spielen suchen', exact: true }).fill('forza');
  await page.getByRole('region', { name: 'Suchergebnisse' }).getByRole('button', { name: 'Forza Horizon 5 vormerken', exact: true }).click();
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
  await expectSettingsSaved(page);
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
  await expectSettingsSaved(page);
  await expect(columnList(page).getByRole('listitem').first()).toContainText('Spiel (Cover und Titel)');
  expect((await (await page.request.get('/api/v1/settings')).json()).wishlist_columns).toEqual(['game', 'price', 'world', 'save', 'target', 'status', 'trend', 'open']);
  await navTo(page, 'Wunschliste');
  await wishlistRows(page).first().getByRole('button', { name: /^Details zu / }).click();
  await removeCurrent(page);
});
