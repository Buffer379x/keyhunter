import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { navTo, navItem, signInToFixture } from './helpers';

const libraryList = (page: Page) => page.getByRole('list', { name: 'Meine Spiele', exact: true });
const addDialog = (page: Page) => page.getByRole('dialog', { name: 'Zur Bibliothek hinzufügen', exact: true });

/** A write to the API as the page would send it (origin and CSRF token). */
async function write(page: Page, method: 'POST' | 'DELETE', path: string, data?: object) {
  const { csrf_token: csrf } = await (await page.request.get('/api/v1/me')).json();
  const response = await page.request.fetch(path, { method, data, headers: { 'X-CSRF-Token': csrf, Origin: new URL(page.url()).origin } });
  expect(response.ok(), `${method} ${path}`).toBe(true);
}

// The suite shares one database: remove every library and wishlist entry a test leaves behind.
test.afterEach(async ({ page }) => {
  for (const path of ['/api/v1/library', '/api/v1/wishlist']) {
    for (const item of await (await page.request.get(path)).json()) await write(page, 'DELETE', `/api/v1/wishlist/${item.id}`);
  }
});

test('in the library a game is added straight to the library, a wished one only after confirmation', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInToFixture(page);
  await navTo(page, 'Bibliothek');
  await expect(page.getByRole('heading', { name: 'Noch keine Spiele in der Bibliothek' })).toBeVisible();

  // "Spiel hinzufügen" in the top bar opens the library's own dialog; the page stays.
  await page.getByRole('banner').getByRole('button', { name: 'Spiel hinzufügen', exact: true }).click();
  const dialog = addDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Spiel im Katalog suchen').fill('forza');
  await dialog.getByRole('button', { name: 'Forza Horizon 5 (Xbox Series X|S) zur Bibliothek hinzufügen', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Bibliothek', level: 1, exact: true })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Forza Horizon 5 ist jetzt in der Bibliothek.' })).toBeVisible();
  await expect(libraryList(page).getByRole('listitem')).toHaveCount(1);
  await expect(navItem(page, 'Bibliothek')).toContainText('1');
  expect(await (await page.request.get('/api/v1/wishlist')).json()).toEqual([]);

  // The same game is shown as already there.
  await page.getByRole('banner').getByRole('button', { name: 'Spiel hinzufügen', exact: true }).click();
  await dialog.getByLabel('Spiel im Katalog suchen').fill('forza');
  await expect(dialog.getByRole('button', { name: 'Forza Horizon 5 (Xbox Series X|S) zur Bibliothek hinzufügen', exact: true })).toHaveText('In der Bibliothek');
  await expect(dialog.getByRole('button', { name: 'Forza Horizon 5 (Xbox Series X|S) zur Bibliothek hinzufügen', exact: true })).toBeDisabled();

  // A game on the wishlist moves over only when confirmed, as if bought.
  // (confirm_owned: the base game is owned already, the edition is a different entry.)
  await write(page, 'POST', '/api/v1/wishlist', { igdb_id: 1002, platform_id: 169, confirm_owned: true });
  await dialog.getByRole('button', { name: 'Forza Horizon 5: Premium Edition (Xbox Series X|S) zur Bibliothek hinzufügen', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Steht auf der Wunschliste', exact: true });
  await expect(confirm).toContainText('steht auf deiner Wunschliste');
  await confirm.getByRole('button', { name: 'Als gekauft verschieben', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(libraryList(page).getByRole('listitem')).toHaveCount(2);
  expect(await (await page.request.get('/api/v1/wishlist')).json()).toEqual([]);
});

test('the library switches between tiles and a list, and keeps the choice', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInToFixture(page);
  await write(page, 'POST', '/api/v1/library', { igdb_id: 1001, platform_id: 169 });
  await write(page, 'POST', '/api/v1/library', { manual_title: 'Altes Disc-Spiel', platform_id: 49 });
  await navTo(page, 'Bibliothek');
  const view = page.getByRole('group', { name: 'Ansicht', exact: true });
  await expect(view.getByRole('button', { name: 'Kacheln', exact: true })).toHaveAttribute('aria-pressed', 'true');
  // 0.9.0: the tiles name the system under the title too, like the list.
  await expect(libraryList(page).locator('.lib-sub')).toHaveText(['Xbox One', 'Xbox Series X|S']);

  await view.getByRole('button', { name: 'Liste', exact: true }).click();
  await expect(view.getByRole('button', { name: 'Liste', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const rows = libraryList(page).getByRole('listitem');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('Altes Disc-Spiel');
  // 0.8.1: title and system only, no purchase date.
  await expect(rows.first().locator('.lib-sub')).toHaveText('Xbox One');
  await expect(rows.nth(1)).toContainText(/Forza Horizon 5\s*Xbox Series X\|S/);
  await expect(libraryList(page)).not.toContainText('gekauft am');
  // Unlocked, restore and delete sit at the end of each row.
  await page.getByRole('button', { name: 'Bearbeiten entsperren', exact: true }).click();
  await expect(rows.first().getByRole('button', { name: 'Altes Disc-Spiel aus der Bibliothek entfernen', exact: true })).toBeVisible();
  const row = await rows.first().boundingBox();
  const remove = await rows.first().getByRole('button', { name: 'Altes Disc-Spiel aus der Bibliothek entfernen', exact: true }).boundingBox();
  expect(remove!.x + remove!.width).toBeGreaterThan(row!.x + row!.width - 24);

  await page.reload();
  await expect(page.getByRole('group', { name: 'Ansicht', exact: true }).getByRole('button', { name: 'Liste', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('group', { name: 'Ansicht', exact: true }).getByRole('button', { name: 'Kacheln', exact: true }).click();
});

test('on a phone the library head has its own add button', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInToFixture(page);
  await navTo(page, 'Bibliothek');
  await page.getByRole('main').getByRole('button', { name: 'Spiel zur Bibliothek hinzufügen', exact: true }).click();
  await expect(addDialog(page)).toBeVisible();
  await addDialog(page).getByRole('button', { name: 'Suche schließen', exact: true }).click();
  await expect(addDialog(page)).toBeHidden();
});
