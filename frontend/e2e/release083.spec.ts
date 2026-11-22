import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { navItem, navTo, settingsButton, signInToFixture } from './helpers';

/** A write to the API as the page would send it (origin and CSRF token). */
async function write(page: Page, method: 'POST' | 'DELETE', path: string, data?: object) {
  const { csrf_token: csrf } = await (await page.request.get('/api/v1/me')).json();
  return page.request.fetch(path, { method, data, headers: { 'X-CSRF-Token': csrf, Origin: new URL(page.url()).origin } });
}

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  for (const item of await (await page.request.get('/api/v1/wishlist')).json()) await write(page, 'DELETE', `/api/v1/wishlist/${item.id}`);
});

const now = () => Math.floor(Date.now() / 1000);

test('the settings are tabs behind the symbol button below the fetch status; both column lists share one panel', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInToFixture(page);
  const sidebar = page.getByRole('complementary', { name: 'Seitenleiste' });
  // The main navigation keeps only the pages; Einstellungen and Abmelden are symbol buttons in the footer.
  await expect(page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('button')).toHaveText([/Wunschliste/, /Warenkorb/, /Bibliothek/, /Preisalarme/]);
  await expect(sidebar.getByRole('button', { name: 'Abmelden', exact: true })).toBeVisible();
  const settings = settingsButton(page);
  await settings.click();
  await expect(page).toHaveURL(/view=settings/);
  await expect(settings).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { name: 'Einstellungen', level: 1 })).toBeVisible();
  await expect(page.getByRole('tablist', { name: 'Einstellungen', exact: true }).getByRole('tab'))
    .toHaveText(['Allgemein', 'Key-Shops', 'Spieleindex', 'Benachrichtigungen', 'Abrufstatus', 'Log', 'System']);
  // Below the fetch status: the fetch box first, then the two buttons side by side.
  const fetchBox = await sidebar.locator('.fetch-mini').boundingBox();
  const settingsBox = await settings.boundingBox();
  const logoutBox = await sidebar.getByRole('button', { name: 'Abmelden', exact: true }).boundingBox();
  if (fetchBox) expect(settingsBox!.y).toBeGreaterThan(fetchBox.y + fetchBox.height - 1);
  expect(Math.abs(settingsBox!.y - logoutBox!.y)).toBeLessThan(1);

  const columns = page.getByRole('region', { name: 'Tabellenspalten', exact: true });
  const tables = columns.getByRole('tablist', { name: 'Tabelle', exact: true });
  await expect(tables.getByRole('tab')).toHaveText(['Wunschliste', 'Angebote']);
  await expect(columns.getByRole('list', { name: 'Spaltenreihenfolge der Wunschliste', exact: true })).toBeVisible();
  await tables.getByRole('tab', { name: 'Angebote', exact: true }).click();
  await expect(columns.getByRole('list', { name: 'Spaltenreihenfolge der Angebote', exact: true })).toBeVisible();
  await expect(columns.getByRole('list', { name: 'Spaltenreihenfolge der Wunschliste', exact: true })).toHaveCount(0);

  // Key-Shops: one tab per shop.
  await navTo(page, 'Key-Shops');
  await expect(navItem(page, 'Key-Shops')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tablist', { name: 'Key-Shops', exact: true }).getByRole('tab')).toHaveCount(2);
  await expect(page.getByRole('article')).toHaveCount(1);
});

test('explanations sit behind the same help symbol and open on hover, focus and tap', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInToFixture(page);
  const help = page.getByRole('button', { name: 'Hilfe zur Wunschliste', exact: true });
  await expect(help).toHaveAccessibleDescription(/günstigste Region weltweit/);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await help.hover();
  const tip = page.getByRole('tooltip');
  await expect(tip).toBeVisible();
  // Inside the viewport, never under the table.
  const box = (await tip.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(1440);
  await page.mouse.move(700, 800);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  // The old inline help texts are gone from the settings.
  await navTo(page, 'Key-Shops');
  await expect(page.getByText('Empfohlen: 8 Stunden pro Produktseite')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Wie werden Gebühren behandelt?' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Hilfe zum Intervall', exact: true }).click();
  await expect(page.getByRole('tooltip').filter({ hasText: 'Empfohlen: 8 Stunden pro Produktseite' })).toBeVisible();
  await page.mouse.click(700, 850);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
});

test('the log lists the events of the last days by level and full text, page by page', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInToFixture(page);
  await write(page, 'POST', '/api/v1/wishlist', { igdb_id: 1001, platform_id: 169 });
  const requests: URL[] = [];
  page.on('request', request => { if (request.url().includes('/api/v1/log')) requests.push(new URL(request.url())); });
  await navTo(page, 'Log');
  await expect(page).toHaveURL(/section=log/);
  const table = page.getByRole('table', { name: 'Ereignisse', exact: true });
  await expect(table.getByRole('columnheader')).toHaveText(['Zeit', 'Stufe', 'Bereich', 'Meldung']);
  await expect(table).toContainText('Angemeldet');
  await expect(table.getByRole('row').filter({ hasText: 'Forza Horizon 5' }).first()).toContainText('Wunschliste');

  const search = page.getByRole('searchbox', { name: 'Log durchsuchen', exact: true });
  await search.fill('forza');
  await expect.poll(() => requests.at(-1)?.searchParams.get('q')).toBe('forza');
  await expect(table.getByRole('row')).not.toHaveCount(1);
  for (const row of await table.getByRole('row').all()) if (await row.locator('td').count()) await expect(row).toContainText(/forza/i);
  await page.getByRole('radiogroup', { name: 'Log nach Stufe filtern', exact: true }).getByRole('radio', { name: 'Fehler', exact: true }).click();
  await expect.poll(() => requests.at(-1)?.searchParams.get('level')).toBe('error');
  await expect(page.getByText('Kein Eintrag passt zu diesem Filter.')).toBeVisible();

  // The page size is remembered.
  await page.getByRole('radiogroup', { name: 'Log nach Stufe filtern', exact: true }).getByRole('radio', { name: 'Alle', exact: true }).click();
  await search.fill('');
  await page.getByLabel('Pro Seite', { exact: true }).selectOption('25');
  await expect.poll(() => requests.at(-1)?.searchParams.get('per_page')).toBe('25');
  await page.reload();
  await expect(page.getByLabel('Pro Seite', { exact: true })).toHaveValue('25');
});

test('Abrufstatus pages through the runs with their game and shows the next five fetches', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const run = (id: number) => ({ id, source: id % 2 ? 'eneba' : 'driffle', kind: 'product', wish_id: null, link_id: id, game: id % 3 ? 'Forza Horizon 5' : 'Starfield', region: 'Global',
    started_at: now() - id * 60, duration_ms: 400, outcome: id % 5 ? 'ok' : 'network', detail: '2890 ct' });
  const requests: URL[] = [];
  await page.route('**/api/v1/status/fetch/runs?*', route => {
    const url = new URL(route.request().url()); requests.push(url);
    const page = Number(url.searchParams.get('page')); const per = Number(url.searchParams.get('per_page'));
    return route.fulfill({ json: { runs: Array.from({ length: Math.min(per, 120 - (page - 1) * per) }, (_, i) => run((page - 1) * per + i + 1)), total: 120, page, per_page: per } });
  });
  await page.route('**/api/v1/status/fetch', async route => {
    const json = await (await route.fetch()).json();
    json.upcoming = [
      { source: 'eneba', kind: 'product', wish_id: null, link_id: 7, game: 'Forza Horizon 5', region: 'India', search_page: null, due_at: now() + 30, requested: true },
      { source: 'eneba', kind: 'search', wish_id: 'a'.repeat(32), link_id: null, game: 'Starfield', region: null, search_page: 2, due_at: now() + 400, requested: false },
      { source: 'eneba', kind: 'discovery', wish_id: null, link_id: null, game: null, region: null, search_page: null, due_at: now() + 4000, requested: false },
    ];
    await route.fulfill({ json });
  });
  await signInToFixture(page);
  await page.evaluate(() => localStorage.setItem('keyhunter.runs.perPage', '25'));
  await navTo(page, 'Abrufstatus');
  const next = page.getByRole('table', { name: 'Nächste Abfragen', exact: true });
  await expect(next.getByRole('columnheader')).toHaveText(['Wann', 'Shop', 'Art', 'Spiel', 'Ziel']);
  await expect(next.getByRole('row').nth(1)).toContainText(/jetzt.*Eneba.*Preis.*angefordert.*Forza Horizon 5.*India/);
  await expect(next.getByRole('row').nth(2)).toContainText(/in 7 Min\..*Suche.*Starfield.*Seite 2/);
  await expect(next.getByRole('row').nth(3)).toContainText(/Discovery.*–.*Neue Produkte/);

  const runs = page.getByRole('table', { name: 'Letzte Abrufe', exact: true });
  await expect(runs.getByRole('row')).toHaveCount(26);
  const pager = page.getByRole('navigation', { name: 'Seiten Abrufe', exact: true });
  await expect(pager).toContainText('1–25 von 120');
  await expect(pager).toContainText('Seite 1 von 5');
  await pager.getByRole('button', { name: 'Nächste Seite', exact: true }).click();
  await expect(pager).toContainText('26–50 von 120');
  await expect.poll(() => requests.at(-1)?.searchParams.get('page')).toBe('2');
  await pager.getByRole('button', { name: 'Letzte Seite', exact: true }).click();
  await expect(pager).toContainText('101–120 von 120');
  await expect(pager.getByRole('button', { name: 'Nächste Seite', exact: true })).toBeDisabled();
  // A filter or a search goes back to the first page.
  await page.getByRole('radiogroup', { name: 'Abrufe nach Stufe filtern', exact: true }).getByRole('radio', { name: 'Fehler', exact: true }).click();
  await expect.poll(() => [requests.at(-1)?.searchParams.get('tone'), requests.at(-1)?.searchParams.get('page')]).toEqual(['error', '1']);
  await page.getByRole('searchbox', { name: 'Abrufe durchsuchen', exact: true }).fill('starfield');
  await expect.poll(() => requests.at(-1)?.searchParams.get('q')).toBe('starfield');
  await expect(runs.getByRole('row').nth(1)).toContainText(/Forza Horizon 5|Starfield/);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('the cart totals stand in a box of their own, every amount in one column', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInToFixture(page);
  const offer = (cents: number) => ({ cents, estimate_cents: Math.round(cents * 1.05), region: 'Global', observed_at: now() - 60, stale: false });
  await page.route('**/api/v1/cart', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const entry = (id: string, name: string, eneba: number, driffle: number) => ({ id, game_id: id, platform_id: 169, created_at: 1, verification: 'manual_unverified', game: null, manual_title: name,
      added_at: 1, source: null, scope: 'world', offers: { eneba: { home: offer(eneba), world: offer(eneba) }, driffle: { home: offer(driffle), world: offer(driffle) } } });
    await route.fulfill({ json: [entry('a'.repeat(32), 'Forza Horizon 5', 2890, 3100), entry('b'.repeat(32), 'Starfield', 4200, 3900)] });
  });
  await page.goto('/?view=cart');
  const sum = page.getByRole('region', { name: 'Gesamt', exact: true });
  const totals = sum.locator('.cart-totals').getByRole('definition');
  await expect(sum.locator('.cart-totals')).toContainText(/Reine Key-Kosten\s*67,90/);
  await expect(sum.getByRole('button', { name: 'Hilfe zu den Gebühren', exact: true })).toBeVisible();
  // The totals have a border like each shop, and all amounts end at the same right edge.
  expect(await sum.locator('.cart-totals').evaluate(el => getComputedStyle(el).borderTopStyle)).toBe('solid');
  const right = async (selector: string) => sum.locator(selector).evaluateAll(els => els.map(el => Math.round(el.getBoundingClientRect().right)));
  const edges = new Set([...await right('.cart-shop-head .mono'), ...await right('.cart-totals dd')]);
  expect(edges.size, `right edges ${[...edges].join(', ')}`).toBe(1);
  await expect(totals).toHaveCount(3);
  await expect(page.getByText('Gesamt ohne Gebühren')).toHaveCount(0);
});
