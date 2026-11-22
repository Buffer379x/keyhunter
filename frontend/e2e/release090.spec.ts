import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { navTo, saveSettings, settingsCountry, signInToFixture } from './helpers';
import { backToList, wishlistRows } from './detail-helpers';

/** A write to the API as the page would send it (origin and CSRF token). */
async function write(page: Page, method: 'POST' | 'PUT' | 'DELETE', path: string, data?: object) {
  const { csrf_token: csrf } = await (await page.request.get('/api/v1/me')).json();
  return page.request.fetch(path, { method, data, headers: { 'X-CSRF-Token': csrf, Origin: new URL(page.url()).origin } });
}

// The suite shares one database: remove every wish and library entry, and put the target country back.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  for (const path of ['/api/v1/wishlist', '/api/v1/library']) {
    for (const item of await (await page.request.get(path)).json()) await write(page, 'DELETE', `/api/v1/wishlist/${item.id}`);
  }
  await write(page, 'POST', '/api/v1/status/fetch/pause', { paused: false });
  const settings = await (await page.request.get('/api/v1/settings')).json();
  if (settings.target_country !== 'DE') await write(page, 'PUT', '/api/v1/settings', { ...settings, target_country: 'DE' });
});

const now = () => Math.floor(Date.now() / 1000);

test('a wish is paused on its own for weeks or until resumed, and stays paused through the global pause', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInToFixture(page);
  const id = (await (await write(page, 'POST', '/api/v1/wishlist', { igdb_id: 1001, platform_id: 169 })).json()).item.id;
  await write(page, 'POST', '/api/v1/wishlist', { igdb_id: 1002, platform_id: 169 });
  await page.goto(`/?item=${id}`);
  // No limit any more: the head counts the games only.
  await page.getByRole('button', { name: 'Abfragen pausieren', exact: true }).click();
  await expect(page.getByRole('menu', { name: 'Abfragen pausieren' }).getByRole('menuitem')).toHaveText(['1 Woche', '2 Wochen', '4 Wochen', '8 Wochen', 'Bis ich fortsetze']);
  await page.getByRole('menuitem', { name: '2 Wochen', exact: true }).click();
  const end = new Date((now() + 14 * 86400) * 1000).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  await expect(page.locator('.pause-pill')).toHaveText(`Abfragen pausiert bis ${end}`);
  const item = (await (await page.request.get('/api/v1/wishlist')).json()).find((row: { id: string }) => row.id === id);
  expect(item.paused).toBe(true);
  expect(Math.abs(item.paused_until - (now() + 14 * 86400))).toBeLessThan(120);

  // The global pause and its end leave the wish paused.
  await page.getByRole('button', { name: 'Automatische Abfragen pausieren', exact: true }).click();
  await page.getByRole('button', { name: 'Automatische Abfragen fortsetzen', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Automatische Abfragen pausieren', exact: true })).toBeVisible();

  // In the list: a yellow pause symbol after the title, like the basket, and a chip with the paused wishes.
  await backToList(page);
  await expect(page.locator('.page-head p')).toHaveText(/^2 Spiele · Zielland /);
  const paused = wishlistRows(page).filter({ hasText: 'Standard Edition' }).getByRole('img', { name: `Abfragen pausiert bis ${end}`, exact: true });
  await expect(paused).toBeVisible();
  const warn = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--warn').trim());
  expect(await paused.evaluate(el => getComputedStyle(el).color)).toBe(await page.evaluate(color => { const probe = document.createElement('i'); probe.style.color = color; document.body.append(probe); const value = getComputedStyle(probe).color; probe.remove(); return value; }, warn));
  await expect(wishlistRows(page).filter({ hasText: 'Premium' }).getByRole('img', { name: /pausiert/ })).toHaveCount(0);
  await page.getByRole('button', { name: /^Pausiert/ }).click();
  await expect(wishlistRows(page)).toHaveCount(1);

  // Until resumed by hand, then resumed.
  await page.goto(`/?item=${id}`);
  await page.getByRole('button', { name: 'Fortsetzen', exact: true }).click();
  await expect(page.locator('.pause-pill')).toHaveCount(0);
  await page.getByRole('button', { name: 'Abfragen pausieren', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Bis ich fortsetze', exact: true }).click();
  await expect(page.locator('.pause-pill')).toHaveText('Abfragen pausiert, bis du sie fortsetzt');
  await navTo(page, 'Log');
  await expect(page.getByRole('table', { name: 'Ereignisse', exact: true })).toContainText('Abfragen pausiert, bis sie fortgesetzt werden');
});

test('the cart takes games only from the wishlist and shows the remove button without scrolling on desktops', async ({ page }) => {
  await signInToFixture(page);
  const offer = (cents: number) => ({ cents, estimate_cents: Math.round(cents * 1.05), region: 'Global', observed_at: now() - 60, stale: false });
  const entry = (n: number, name: string, source: string | null) => ({ id: String(n).repeat(32), game_id: String(n), platform_id: 169, created_at: 1, verification: 'manual_unverified', game: null,
    manual_title: name, added_at: 1, source, scope: 'home', offers: { eneba: { home: offer(2890), world: offer(1290) }, driffle: { home: offer(3100), world: offer(1500) } } });
  await page.route('**/api/v1/cart', route => route.request().method() === 'GET'
    ? route.fulfill({ json: [entry(1, 'Microsoft Flight Simulator 2024: Premium Deluxe Edition', 'driffle'), entry(2, 'Forza Horizon 5', null), entry(3, "Baldur's Gate 3", 'eneba')] })
    : route.continue());
  for (const width of [1280, 1500, 1680, 1920, 2560]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/?view=cart');
    const table = page.getByRole('table', { name: 'Spiele im Warenkorb', exact: true });
    await expect(table.locator('tbody tr')).toHaveCount(3);
    await expect(page.getByLabel('Spiel aus der Wunschliste wählen')).toHaveCount(0);
    for (const button of await table.getByRole('button', { name: /aus dem Warenkorb nehmen$/ }).all()) {
      const box = (await button.boundingBox())!;
      expect(box.x + box.width, `remove button at ${width} px`).toBeLessThanOrEqual(width);
    }
    const wrap = table.locator('xpath=..');
    expect(await wrap.evaluate(el => el.scrollWidth - el.clientWidth), `table overflow at ${width} px`).toBeLessThanOrEqual(0);
  }
});

test('the library shows the system under each title and filters tiles and list by text', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInToFixture(page);
  const entry = (n: number, title: string, platform: number) => ({ id: String(n).repeat(32), game_id: String(n), platform_id: platform, created_at: n, acquired_at: n, verification: 'manual_unverified', game: null, manual_title: title });
  await page.route('**/api/v1/library', route => route.fulfill({ json: [entry(1, 'Halo Infinite', 169), entry(2, 'Pokémon Legends', 49), entry(3, 'Halo 3', 12)] }));
  await page.goto('/?view=library');
  const items = page.getByRole('list', { name: 'Meine Spiele' }).getByRole('listitem');
  await expect(items).toHaveCount(3);
  await expect(items.filter({ hasText: 'Halo 3' }).locator('.lib-sub')).toHaveText('Xbox 360');
  await expect(items.filter({ hasText: 'Halo Infinite' }).locator('.lib-sub')).toHaveText('Xbox Series X|S');
  const filter = page.getByRole('searchbox', { name: 'Bibliothek filtern', exact: true });
  await filter.fill('halo');
  await expect(items).toHaveCount(2);
  await expect(page.locator('.page-head p')).toHaveText('2 von 3 Spiele');
  // Without accents, and the system counts too.
  await filter.fill('pokemon');
  await expect(items).toHaveText([/Pokémon Legends/]);
  await filter.fill('halo 360');
  await expect(items).toHaveText([/Halo 3/]);
  await page.getByRole('button', { name: 'Liste', exact: true }).click();
  await expect(items).toHaveText([/Halo 3.*Xbox 360/]);
  await filter.fill('zelda');
  await expect(page.getByText('Kein Spiel passt zu diesem Filter.')).toBeVisible();
  await filter.fill('');
  await expect(items).toHaveCount(3);
});

test('the HTTPS notice can be closed and stays closed', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInToFixture(page);
  await navTo(page, 'Allgemein');
  const notice = page.getByRole('note').filter({ hasText: 'Verbindung ohne HTTPS.' });
  await expect(notice).toBeVisible();
  await notice.getByRole('button', { name: 'Hinweis ausblenden', exact: true }).click();
  await expect(notice).toHaveCount(0);
  await page.reload();
  await navTo(page, 'Key-Shops');
  await expect(page.getByRole('heading', { name: 'Einstellungen', level: 1 })).toBeVisible();
  await expect(notice).toHaveCount(0);
  await page.evaluate(() => localStorage.removeItem('keyhunter.httpsNotice.dismissed'));
});

test('another EU target country follows the same rules and every label names it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInToFixture(page);
  await navTo(page, 'Allgemein');
  await settingsCountry(page).selectOption('AT');
  await expect(page.getByTestId('activation-note')).toHaveCount(0);
  await saveSettings(page);
  const id = (await (await write(page, 'POST', '/api/v1/wishlist', { igdb_id: 1001, platform_id: 169 })).json()).item.id;
  await write(page, 'POST', '/api/v1/cart', { wish_id: id });
  await navTo(page, 'Wunschliste');
  await expect(page.locator('.page-head p')).toContainText('Zielland Österreich');
  await expect(page.getByRole('columnheader', { name: /Preis AT/ })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: /Preis DE/ })).toHaveCount(0);
  await page.goto('/?view=cart');
  await expect(page.getByRole('radiogroup', { name: /^Preisgrundlage für / }).getByRole('radio')).toHaveText(['AT', 'INT']);
  await expect(page.getByRole('main')).not.toContainText(/\bDE\b/);
});
