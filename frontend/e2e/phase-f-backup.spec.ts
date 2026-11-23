import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { clearWishlist } from './layout-mocks';
import { navTo, signInToFixture } from './helpers';

// Release 1.0, Phase F: "Sichern & Wiederherstellen" in Einstellungen › System (PROD-01, K51): the export is imported
// again after a preview, an import never deletes or doubles anything, and a game in the library is reported.

test.afterEach(async ({ page }) => {
  await clearWishlist(page);
  for (const item of await (await page.request.get('/api/v1/library')).json()) await write(page, 'DELETE', `/api/v1/wishlist/${item.id}`);
});

async function write(page: Page, method: 'POST' | 'DELETE', path: string, data?: object) {
  const { csrf_token: csrf } = await (await page.request.get('/api/v1/me')).json();
  return page.request.fetch(path, { method, data, headers: { 'X-CSRF-Token': csrf, Origin: new URL(page.url()).origin } });
}

/** What the wishlist holds, as comparable lines. */
async function wishes(page: Page) {
  const rows: { game: { name: string } | null; manual_title: string | null; platform_id: number }[] = await (await page.request.get('/api/v1/wishlist')).json();
  return rows.map(r => `${r.game?.name ?? r.manual_title}|${r.platform_id}`).sort();
}

const panel = (page: Page) => page.getByRole('region', { name: 'Sichern & Wiederherstellen', exact: true });
const choose = (page: Page, file: string | { name: string; mimeType: string; buffer: Buffer }) =>
  panel(page).getByLabel('Datei der Wunschliste wählen', { exact: true }).setInputFiles(file);

test('PROD-01: the exported wishlist is imported again after a preview, and a second import changes nothing', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInToFixture(page);
  for (const input of [
    { igdb_id: 1001, platform_id: 169 },
    { igdb_id: 1001, platform_id: 49 },
    { manual_title: 'Mein Testspiel', platform_id: 12 },
  ]) {
    expect((await write(page, 'POST', '/api/v1/wishlist', input)).ok()).toBe(true);
  }
  const before = await wishes(page);
  expect(before).toHaveLength(3);

  // Export in System.
  await navTo(page, 'System');
  const download = page.waitForEvent('download');
  await panel(page).getByRole('button', { name: 'Exportieren', exact: true }).click();
  const path = testInfo.outputPath('keyhunter-wunschliste.json');
  await (await download).saveAs(path);
  const exported = JSON.parse(await readFile(path, 'utf8'));
  expect(exported.version).toBe(1);
  expect(exported.items).toHaveLength(3);

  // A fresh instance: nothing on the list. The preview names the counts and changes nothing.
  await clearWishlist(page);
  expect(await wishes(page)).toEqual([]);
  await choose(page, path);
  const dialog = page.getByRole('dialog', { name: 'Wunschliste importieren', exact: true });
  const counts = dialog.getByRole('list', { name: 'Ergebnis des Imports', exact: true });
  await expect(counts.getByRole('listitem')).toHaveText([
    /^3 werden hinzugefügt/,
    /^0 sind schon auf der Liste/,
    /^0 sind in der Bibliothek/,
    /^0 sind unbekannt oder nicht unterstützt/,
    /^0 sind ungültig/,
  ]);
  expect(await wishes(page)).toEqual([]);
  await dialog.getByRole('button', { name: '3 hinzufügen', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('3 Spiele hinzugefügt', { exact: true })).toBeVisible();
  expect(await wishes(page)).toEqual(before);

  // The same file again: all three are on the list, there is nothing to add.
  await choose(page, path);
  await expect(counts.getByRole('listitem').first()).toHaveText(/^0 werden hinzugefügt/);
  await expect(counts.getByRole('listitem').nth(1)).toHaveText(/^3 sind schon auf der Liste/);
  await expect(dialog.getByRole('button', { name: 'Hinzufügen', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Abbrechen', exact: true }).click();
  expect(await wishes(page)).toEqual(before);

  // A game bought since stays in the library and is named in the preview, like adding it by hand.
  const forza = (await (await page.request.get('/api/v1/wishlist')).json()).find(
    (r: { platform_id: number; game: object | null }) => r.platform_id === 169 && r.game,
  );
  await write(page, 'POST', `/api/v1/wishlist/${forza.id}/purchase`, {});
  await choose(page, path);
  await expect(counts.getByRole('listitem').nth(2)).toHaveText(/^1 sind in der Bibliothek/);
  await expect(dialog.getByRole('list', { name: 'Übersprungene Einträge', exact: true })).toContainText('ist schon in der Bibliothek');
  await dialog.getByRole('button', { name: 'Abbrechen', exact: true }).click();
  expect(await wishes(page)).toEqual(before.filter(line => line !== 'Forza Horizon 5|169'));
});

test('PROD-01: a file that is not an export is refused inside the dialog and nothing is sent', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInToFixture(page);
  await navTo(page, 'System');
  const imports: string[] = [];
  page.on('request', request => request.url().includes('/wishlist/import') && imports.push(request.method()));
  await choose(page, { name: 'andere.json', mimeType: 'application/json', buffer: Buffer.from('{"hello":"world"}') });
  const dialog = page.getByRole('dialog', { name: 'Wunschliste importieren', exact: true });
  await expect(dialog.getByRole('alert')).toContainText('keine Wunschlisten-Datei');
  await expect(dialog.getByRole('button', { name: 'Hinzufügen', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Schließen', exact: true }).click();
  await expect(dialog).toBeHidden();
  await choose(page, { name: 'kaputt.json', mimeType: 'application/json', buffer: Buffer.from('nope') });
  await expect(dialog.getByRole('alert')).toContainText('kein gültiges JSON');
  await dialog.getByRole('button', { name: 'Schließen', exact: true }).click();
  expect(imports).toEqual([]);
  expect(await wishes(page)).toEqual([]);
});
