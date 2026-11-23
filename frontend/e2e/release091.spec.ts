import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { navTo, signInToFixture } from './helpers';
import { wishlistRows } from './detail-helpers';

/** A write to the API as the page would send it (origin and CSRF token). */
async function write(page: Page, method: 'POST' | 'PUT' | 'DELETE', path: string, data?: object) {
  const { csrf_token: csrf } = await (await page.request.get('/api/v1/me')).json();
  return page.request.fetch(path, { method, data, headers: { 'X-CSRF-Token': csrf, Origin: new URL(page.url()).origin } });
}

// The suite shares one database and this browser's storage: remove every wish and forget the stored list views.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  for (const item of await (await page.request.get('/api/v1/wishlist')).json()) await write(page, 'DELETE', `/api/v1/wishlist/${item.id}`);
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) if (key.startsWith('keyhunter.list.')) localStorage.removeItem(key);
    sessionStorage.clear();
  });
});

const now = () => Math.floor(Date.now() / 1000);

test('messages after an action are popups at the bottom right and the page does not move', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInToFixture(page);
  const id = (await (await write(page, 'POST', '/api/v1/wishlist', { igdb_id: 1001, platform_id: 169 })).json()).item.id;
  await page.goto(`/?item=${id}`);
  const head = page.locator('.game-head, .detail-head, .game-meta').first();
  const before = (await head.boundingBox())!.y;
  await page.getByRole('button', { name: 'Abfragen pausieren', exact: true }).click();
  await page.getByRole('menuitem', { name: '1 Woche', exact: true }).click();
  const popup = page.locator('.toast-pop').filter({ hasText: 'Abfragen pausiert bis' });
  await expect(popup).toBeVisible();
  const box = (await popup.boundingBox())!;
  expect(box.x + box.width).toBeGreaterThan(1440 - 40);
  expect(box.y + box.height).toBeGreaterThan(900 - 40);
  expect((await head.boundingBox())!.y).toBe(before);
  await expect(page.locator('main .notice')).toHaveCount(0);
  // It closes with its button, and by itself after a few seconds.
  await popup.getByRole('button', { name: 'Meldung schließen', exact: true }).click();
  await expect(popup).toHaveCount(0);
  await page.getByRole('button', { name: 'Fortsetzen', exact: true }).click();
  await expect(page.locator('.toast-pop').filter({ hasText: 'laufen wieder' })).toBeVisible();
  await expect(page.locator('.toast-pop').filter({ hasText: 'laufen wieder' })).toHaveCount(0, { timeout: 8000 });
});

test('the wishlist goes page by page and keeps chip, page size and page when the owner comes back', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInToFixture(page);
  for (let n = 1; n <= 28; n++) await write(page, 'POST', '/api/v1/wishlist', { manual_title: `Seitenspiel ${String(n).padStart(2, '0')}`, platform_id: 169 });
  await page.reload();
  await page.getByLabel('Pro Seite', { exact: true }).selectOption('25');
  await expect(wishlistRows(page)).toHaveCount(25);
  const pager = page.getByRole('navigation', { name: 'Seiten Wunschliste', exact: true });
  await expect(pager).toContainText('1–25 von 28');
  await pager.getByRole('button', { name: 'Nächste Seite', exact: true }).click();
  await expect(wishlistRows(page)).toHaveCount(3);
  await page.getByRole('radio', { name: /^Ohne Preis/ }).click();
  await expect(pager).toContainText('1–25 von 28');
  await pager.getByRole('button', { name: 'Letzte Seite', exact: true }).click();
  // Away and back: the chip, the page size and the page are kept.
  await navTo(page, 'Warenkorb');
  await navTo(page, 'Wunschliste');
  await expect(page.getByRole('radio', { name: /^Ohne Preis/ })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByLabel('Pro Seite', { exact: true })).toHaveValue('25');
  await expect(pager).toContainText('26–28 von 28');
  // The first and last page buttons show a bar at the side they lead to.
  await expect(pager.getByRole('button', { name: 'Erste Seite', exact: true }).locator('path')).toHaveAttribute('d', 'M7 6v12M17 6l-6 6 6 6');
  await expect(pager.getByRole('button', { name: 'Letzte Seite', exact: true }).locator('path')).toHaveAttribute('d', 'M17 6v12M7 6l6 6-6 6');
  await page.reload();
  await expect(page.getByLabel('Pro Seite', { exact: true })).toHaveValue('25');
});

test('log and fetch runs keep their filter, search and page size across pages', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInToFixture(page);
  await navTo(page, 'Log');
  await page.getByRole('radiogroup', { name: 'Log nach Stufe filtern', exact: true }).getByRole('radio', { name: 'Warnung', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Log durchsuchen', exact: true }).fill('anmeldung');
  await page.getByLabel('Pro Seite', { exact: true }).selectOption('100');
  await navTo(page, 'Abrufstatus');
  await page.getByRole('radiogroup', { name: 'Abrufe nach Stufe filtern', exact: true }).getByRole('radio', { name: 'Fehler', exact: true }).click();
  await navTo(page, 'Wunschliste');
  await navTo(page, 'Log');
  await expect(
    page.getByRole('radiogroup', { name: 'Log nach Stufe filtern', exact: true }).getByRole('radio', { name: 'Warnung', exact: true }),
  ).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('searchbox', { name: 'Log durchsuchen', exact: true })).toHaveValue('anmeldung');
  await expect(page.getByLabel('Pro Seite', { exact: true })).toHaveValue('100');
  await navTo(page, 'Abrufstatus');
  await expect(
    page.getByRole('radiogroup', { name: 'Abrufe nach Stufe filtern', exact: true }).getByRole('radio', { name: 'Fehler', exact: true }),
  ).toHaveAttribute('aria-checked', 'true');
});

test('the cart shows the games left and the totals right again, with every remove button in view', async ({ page }) => {
  await signInToFixture(page);
  const offer = (cents: number) => ({
    cents,
    estimate_cents: Math.round(cents * 1.05),
    region: 'Global',
    observed_at: now() - 60,
    stale: false,
    fits_target: true,
    activation: 'confirmed',
  });
  const entry = (n: number, name: string, source: string | null) => ({
    id: String(n).repeat(32),
    game_id: String(n),
    platform_id: 169,
    created_at: 1,
    verification: 'manual_unverified',
    game: null,
    manual_title: name,
    added_at: 1,
    source,
    scope: 'home',
    offers: { eneba: { home: offer(2890), world: offer(1290) }, driffle: { home: offer(3100), world: offer(1500) } },
  });
  await page.route('**/api/v1/cart', route =>
    route.request().method() === 'GET'
      ? route.fulfill({
          json: [
            entry(1, 'Microsoft Flight Simulator 2024: Premium Deluxe Edition', 'driffle'),
            entry(2, 'Forza Horizon 5', null),
            entry(3, "Baldur's Gate 3", 'eneba'),
          ],
        })
      : route.continue(),
  );
  for (const width of [1500, 1680, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/?view=cart');
    const table = page.getByRole('table', { name: 'Spiele im Warenkorb', exact: true });
    await expect(table.locator('tbody tr')).toHaveCount(3);
    const tableBox = (await table.boundingBox())!;
    const sumBox = (await page.getByRole('region', { name: 'Gesamt', exact: true }).boundingBox())!;
    expect(sumBox.x, `totals right of the games at ${width} px`).toBeGreaterThan(tableBox.x + tableBox.width - 1);
    expect(Math.abs(sumBox.y - tableBox.y)).toBeLessThan(120);
    const wrap = table.locator('xpath=..');
    expect(await wrap.evaluate(el => el.scrollWidth - el.clientWidth), `table overflow at ${width} px`).toBeLessThanOrEqual(0);
    // DE/INT sits under the shop of each game.
    await expect(table.locator('tbody tr').first().locator('td.c-shop').getByRole('radiogroup')).toBeVisible();
  }
  await page.setViewportSize({ width: 1280, height: 1000 });
  const table = page.getByRole('table', { name: 'Spiele im Warenkorb', exact: true });
  const sumBox = (await page.getByRole('region', { name: 'Gesamt', exact: true }).boundingBox())!;
  expect(sumBox.y, 'below the games on a narrower screen').toBeGreaterThan((await table.boundingBox())!.y + 100);
});

test('the list counts the offers after edition and platform and marks mappings to review with a warning symbol', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInToFixture(page);
  await write(page, 'POST', '/api/v1/wishlist', { igdb_id: 1001, platform_id: 169 });
  await write(page, 'POST', '/api/v1/wishlist', { igdb_id: 1002, platform_id: 169 });
  await page.route(/\/api\/v1\/wishlist$/, async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const rows = await (await route.fetch()).json();
    await route.fulfill({
      json: rows.map((row: { game: { edition_name: string | null } }, n: number) => ({ ...row, offer_count: n === 0 ? 38 : 1, review_count: n === 0 ? 2 : 0 })),
    });
  });
  await page.reload();
  const rows = wishlistRows(page);
  await expect(rows.first()).toContainText(/Xbox Series X\|S \(38 Angebote\)/); // RESP-10: the platform instead of the year
  await expect(rows.nth(1)).toContainText(/\(1 Angebot\)/);
  await expect(rows.first().getByRole('img', { name: '2 ungeprüfte Zuordnungen', exact: true })).toBeVisible();
  await expect(rows.nth(1).getByRole('img', { name: /Zuordnung/ })).toHaveCount(0);
});

test('the search popup keeps its layout when the systems arrive on the first open', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInToFixture(page);
  await write(page, 'POST', '/api/v1/wishlist', { igdb_id: 1001, platform_id: 169 });
  await write(page, 'POST', '/api/v1/wishlist', { manual_title: 'Altes Spiel', platform_id: 12 });
  await page.route(/\/api\/v1\/wishlist$/, async route => {
    await new Promise(done => setTimeout(done, 400));
    await route.continue();
  });
  await page.reload();
  await expect(wishlistRows(page)).toHaveCount(2);
  await page.getByRole('searchbox', { name: 'Nach Spielen suchen', exact: true }).click();
  const results = page.getByRole('region', { name: 'Suchergebnisse', exact: true });
  const close = results.getByRole('button', { name: 'Suche schließen', exact: true });
  const first = (await close.boundingBox())!;
  await expect(results.getByLabel('Plattform wählen').locator('option')).toHaveText(['Alle', 'Xbox Series X|S', 'Xbox 360']);
  const after = (await close.boundingBox())!;
  expect([after.x, after.y]).toEqual([first.x, first.y]);
  expect(Math.abs(after.y - (await results.locator('.search-pop-head .label').boundingBox())!.y)).toBeLessThan(12);
});
