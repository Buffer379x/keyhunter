import { test, expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { navTo, saveSettings, settingsCountry, signInToFixture } from '../helpers';
import { backToList, openWishlistRow, wishlistRows, wishlistTable } from '../detail-helpers';

// FUNC-06: the price surface against the real backend with seeded price data (backend/examples/catalog_fixture.rs,
// KEYHUNTER_FIXTURE_PRICES=1), no route mocks. deploy/browser-check.sh runs this project on its own server.

/** The wishlist row of a game by title. */
const row = (page: Page, title: string): Locator =>
  wishlistRows(page).filter({ has: page.locator('.game-cell b').filter({ hasText: new RegExp(`^${title}$`) }) });
const main = (page: Page) => page.getByRole('main');

/** Switch the target country in the settings (a no-op when it is set) and go back to the list. */
async function targetCountry(page: Page, code: string) {
  await navTo(page, 'Allgemein');
  if ((await settingsCountry(page).inputValue()) !== code) {
    await settingsCountry(page).selectOption(code);
    await saveSettings(page);
  }
  await navTo(page, 'Wunschliste');
  await expect(wishlistRows(page)).toHaveCount(7);
}
async function openTab(page: Page, title: string, tab: string) {
  await openWishlistRow(page, title);
  await page.getByRole('tab', { name: new RegExp(`^${tab}`) }).click();
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInToFixture(page);
});

test('the list shows target price, INT price and saving by the market rule', async ({ page }) => {
  await targetCountry(page, 'DE');
  const forza = row(page, 'Forza Horizon 5');
  await expect(forza.locator('.c-de')).toContainText('23,99');
  await expect(forza.locator('.c-world')).toContainText('12,99');
  await expect(forza.locator('.c-save')).toContainText('11,00');
  await expect(forza.locator('.spark i')).toHaveCount(14);
  await expect(forza).toContainText('3 Angebote');
});

test('FUNC-02: with an EU target country (AT) the current price, the trend and the history stay', async ({ page }) => {
  await targetCountry(page, 'AT');
  await expect(wishlistTable(page).locator('thead th.c-de')).toHaveText('Preis AT');
  const forza = row(page, 'Forza Horizon 5');
  await expect(forza.locator('.c-de')).toContainText('23,99');
  await expect(forza.locator('.c-world')).toContainText('12,99');
  await expect(forza.locator('.c-save')).toContainText('11,00');
  await expect(forza.locator('.spark i')).toHaveCount(14);
  await openWishlistRow(page, 'Forza Horizon 5');
  await expect(main(page).getByRole('group', { name: 'Preisvergleich' })).toContainText('Bester Preis · AT');
  await expect(main(page).getByRole('group', { name: 'Preisvergleich' })).toContainText('23,99');
  // The history of the target country is not empty (it was for AT, FR, … before 0.9.3): the day of the 31,99 € offer.
  const history = main(page).getByRole('table', { name: /^Preisverlauf Österreich/ });
  await expect(history).toContainText('31,99 €');
  await targetCountry(page, 'DE');
});

test('FUNC-03: a stale or failed price shows no saving, in the list and in the detail', async ({ page }) => {
  await targetCountry(page, 'DE');
  for (const [title, price, world] of [
    ['Teststadt Chroniken', '19,99', '9,99'],
    ['Lichtungsfall', '34,99', '10,99'],
  ]) {
    const game = row(page, title);
    await expect(game.locator('.c-de')).toContainText(price);
    await expect(game.locator('.c-world')).toContainText(world);
    await expect(game.locator('.c-save')).toHaveText('–');
    await expect(game.locator('.c-status')).toContainText('Veraltet');
  }
  await openWishlistRow(page, 'Teststadt Chroniken');
  const compare = main(page).getByRole('group', { name: 'Preisvergleich' });
  await expect(compare).toContainText('Zuletzt bekannt · DE');
  await expect(compare).toContainText('Veraltet');
  await expect(compare).not.toContainText('spart');
  await expect(compare).not.toContainText('−');
  await page.getByRole('tab', { name: /^Angebote/ }).click();
  const offers = main(page).getByRole('table').first();
  await expect(offers.getByRole('row').filter({ hasText: 'Eneba' })).toContainText('veraltet');
  await expect(offers.getByRole('row').filter({ hasText: 'Eneba' })).not.toContainText('bester');
  await backToList(page);
  await openTab(page, 'Lichtungsfall', 'Angebote');
  await expect(main(page).getByRole('row').filter({ hasText: 'Eneba' })).toContainText('Abruffehler');
});

test('FUNC-11: the offer count of every row equals the count of the tab Angebote', async ({ page }) => {
  await targetCountry(page, 'DE');
  const expected: Record<string, string> = {
    'Forza Horizon 5': '3',
    'Teststadt Chroniken': '2',
    Lichtungsfall: '2',
    'Funkstille Frontier': '0',
    'Leerlauf Legende': '0',
    'Pausenzeit Odyssee': '0',
    'Suchlauf Saga': '0',
  };
  for (const [title, count] of Object.entries(expected)) {
    await expect(row(page, title)).toContainText(`(${count} Angebot`);
    await openWishlistRow(page, title);
    await expect(page.getByRole('tab', { name: /^Angebote/ })).toHaveText(new RegExp(`^Angebote\\s*${count}$`));
    await backToList(page);
    await expect(wishlistRows(page)).toHaveCount(7);
  }
});

test('RESP-11: "Abruf fehlgeschlagen" and "Noch keine Angebote" are told apart', async ({ page }) => {
  await targetCountry(page, 'DE');
  await openWishlistRow(page, 'Funkstille Frontier');
  await expect(main(page).getByRole('group', { name: 'Preisvergleich' })).toContainText('Abruf fehlgeschlagen');
  await expect(main(page).getByRole('group', { name: 'Preisvergleich' })).not.toContainText('Noch keine Angebote');
  await backToList(page);
  await openWishlistRow(page, 'Leerlauf Legende');
  await expect(main(page).getByRole('group', { name: 'Preisvergleich' })).toContainText('Noch keine Angebote');
  await expect(main(page).getByRole('group', { name: 'Preisvergleich' })).not.toContainText('Abruf fehlgeschlagen');
});

test('CODE-01: a paused wish is not "Wird gesucht", its unpaused twin is', async ({ page }) => {
  await targetCountry(page, 'DE');
  await expect(row(page, 'Suchlauf Saga').locator('.c-status')).toContainText('Wird gesucht');
  await expect(row(page, 'Pausenzeit Odyssee').locator('.c-status')).not.toContainText('Wird gesucht');
  await openWishlistRow(page, 'Pausenzeit Odyssee');
  await expect(page.locator('.pause-pill')).toHaveText('Abfragen pausiert, bis du sie fortsetzt');
  await expect(main(page)).not.toContainText('Wird gesucht');
  await expect(main(page)).not.toContainText('Suche eingeplant');
});

test('PERF-06: the first load reads the wishlist once and its price badges not a second time', async ({ page }) => {
  await targetCountry(page, 'DE');
  const reads = { list: 0, badges: 0 };
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/api/v1/wishlist') reads.list += 1;
    if (url.pathname === '/api/v1/wishlist/price-badges') reads.badges += 1;
  });
  await page.reload();
  await expect(wishlistRows(page)).toHaveCount(7);
  await expect(row(page, 'Forza Horizon 5').locator('.c-de')).toContainText('23,99');
  await page.waitForTimeout(2000);
  expect(reads).toEqual({ list: 1, badges: 0 });
});

test('PERF-05: with paused wishes the chip row has its final size while the list loads, the table does not move (1366 px)', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  // The list was read once: the browser knows there are paused wishes.
  await targetCountry(page, 'DE');
  await page.route('**/api/v1/wishlist', async route => {
    if (route.request().method() === 'GET') await new Promise(done => setTimeout(done, 1000));
    await route.fallback();
  });
  await page.reload();
  const chips = page.getByRole('group', { name: 'Filter', exact: true });
  await expect(chips.getByRole('button', { name: /^Pausiert/ })).toBeVisible();
  await expect(wishlistRows(page)).toHaveCount(0);
  const body = page.getByRole('region', { name: 'Spiele', exact: true }).locator('> :nth-child(2)');
  const before = (await body.boundingBox())!.y;
  await expect(wishlistRows(page)).toHaveCount(7);
  await expect(chips.getByRole('button', { name: /^Pausiert/ })).toContainText('1');
  expect((await body.boundingBox())!.y, `table top while loading: ${before}`).toBe(before);
});
