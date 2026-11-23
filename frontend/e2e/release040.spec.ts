import { test, expect } from '@playwright/test';
import { mockPriceBadges, saveSettings, signInToFixture, navTo, navItem } from './helpers';
import { editionSelect, openTab, openWishlistRow, removeCurrent, wishlistRows, wishlistTable } from './detail-helpers';
import { withState } from './offer-state';

test('settings separate key shops from games index and persist source intervals', async ({ page }) => {
  await signInToFixture(page);
  await navTo(page, 'Allgemein');
  await navTo(page, 'Key-Shops');
  await expect(navItem(page, 'Key-Shops')).toHaveAttribute('aria-selected', 'true');
  const eneba = page.getByRole('article', { name: 'Eneba', exact: true });
  await expect(eneba.getByLabel('Produktseiten abfragen alle', { exact: true })).toHaveValue(String(8 * 3600));
  await expect(page.getByRole('region', { name: 'IGDB-Zugang' })).not.toBeVisible();
  await eneba.getByLabel('Produktseiten abfragen alle', { exact: true }).selectOption(String(2 * 3600));
  await saveSettings(page);
  await page.reload();
  await expect(eneba.getByLabel('Produktseiten abfragen alle', { exact: true })).toHaveValue(String(2 * 3600));
  // 0.7.4: every built-in shop is listed and switched with "Aktiv"; there is no adding or removing.
  // 0.8.3: one tab per shop; a shop that is off says so in its tab.
  await page.getByRole('tablist', { name: 'Key-Shops', exact: true }).getByRole('tab', { name: 'Driffle · aus', exact: true }).click();
  const driffle = page.getByRole('article', { name: 'Driffle', exact: true });
  await expect(driffle).toBeVisible();
  await expect(eneba).toBeHidden();
  await expect(driffle.getByRole('switch', { name: 'Driffle Aktiv' })).not.toBeChecked();
  await expect(page.getByRole('heading', { name: 'Weiteren Shop hinzufügen' })).toHaveCount(0);
  await expect(page.getByLabel('Shop-URL', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Entfernen', exact: true })).toHaveCount(0);
  await expect(driffle.getByRole('button', { name: 'Hilfe zu Gebühren', exact: true })).toBeVisible();
  await navTo(page, 'Spieleindex');
  await expect(page.getByRole('region', { name: 'IGDB-Zugang' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Editionsinhalte von Microsoft / Xbox' })).toBeVisible();
});

test('edition previews keep the saved version, offers keep price order and history connects scoped minima', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInToFixture(page);
  await page.getByRole('searchbox', { name: 'Nach Spielen suchen', exact: true }).fill('forza');
  await page.getByRole('region', { name: 'Suchergebnisse' }).getByRole('button', { name: 'Forza Horizon 5 (Xbox Series X|S) vormerken', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Forza Horizon 5', exact: true, level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/[?&]item=[a-f0-9]{32}/);
  const originalUrl = page.url();
  const now = Math.floor(Date.now() / 1000),
    day = 86400;
  const rawLink = (id: number, region: string, cents: number) => ({
    id,
    source: 'eneba',
    url: 'https://www.eneba.com/de/xbox-fixture-key-global',
    review: 'confirmed',
    can_confirm: true,
    eligible: region === 'Global',
    queued: false,
    enabled: true,
    stale: false,
    observed_at: now - day,
    attempted_at: now - day,
    last_error: null,
    retry_at: 0,
    product: { name: 'Synthetic offer', region, market: 'DE', activation: region === 'Global' ? 'confirmed' : 'unknown', availability: 'in_stock' },
    quotes: [{ id: String(id), seller: 'Synthetic seller', base_cents: cents, estimated_total_cents: null }],
  });
  const link = (...args: Parameters<typeof rawLink>) => withState(rawLink(...args));
  const point = (at: number, cents: number, region: string) => ({ observed_at: at, base_cents: cents, link_id: 1, region, source: 'eneba' });
  await page.route('**/api/v1/wishlist/*/offers', route =>
    route.request().method() === 'GET'
      ? route.fulfill({
          json: {
            links: [
              link(1, 'United States', 1000),
              link(2, 'USA', 1100),
              link(3, 'Global', 900),
              link(4, 'NA', 1300),
              link(5, 'North America', 1400),
              { ...link(6, 'USA', 1), can_confirm: false, review: 'pending' },
            ],
            histories: {
              preferred: [point(now - 8 * day, 1400, 'Global'), point(now - day, 1200, 'Global')],
              all: [point(now - 8 * day, 1000, 'India'), point(now - day, 900, 'Global')],
            },
            best_base: 900,
            offer_count: 5,
            best_estimate: null,
            target_country: 'DE',
            discovery_running: false,
            searches: [],
            sources: [],
          },
        })
      : route.continue(),
  );
  await page.reload();
  await openTab(page, 'Angebote');
  const rows = page.getByRole('table', { name: 'Angebote nach Preis' }).locator('tbody tr');
  // Five prices and one product that still has to be reviewed, cheapest first; the review row has no price and comes last.
  await expect(rows).toHaveCount(6);
  await expect(rows.first()).toContainText('Global');
  await expect(rows.nth(1)).toContainText('Vereinigte Staaten');
  await expect(rows.nth(1)).toContainText('10,00');
  await expect(rows.last()).toContainText('Zuordnung prüfen');
  // Region code badges instead of flags; regions without a country keep a short code.
  await expect(rows.first().locator('.reg')).toHaveAttribute('data-code', 'GL');
  await expect(rows.filter({ hasText: 'Nordamerika' }).first().locator('.reg')).toHaveAttribute('data-code', 'NA');
  // Global and Nordamerika get the globe, never the flags of Greenland (GL) or Namibia (NA).
  await expect(rows.first().locator('.reg.area svg')).toBeVisible();
  await expect(rows.filter({ hasText: 'Nordamerika' }).first().locator('.reg.area svg')).toBeVisible();
  await expect(page.locator('.reg.flag[data-code="GL"], .reg.flag[data-code="NA"]')).toHaveCount(0);
  await expect(page.locator('.country-flag')).toHaveCount(0);
  const stamp = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' }).format((now - day) * 1000);
  await expect(rows.first().locator('time')).toHaveAttribute('title', new RegExp(stamp.replace(/\./g, '\\.')));
  await editionSelect(page).selectOption({ label: 'Premium Edition' });
  await expect(page.getByRole('heading', { name: 'Forza Horizon 5: Premium Edition', exact: true, level: 1 })).toBeVisible();
  expect(await (await page.request.get('/api/v1/wishlist')).json()).toHaveLength(1);
  expect(new URL(page.url()).searchParams.get('item')).toBe(new URL(originalUrl).searchParams.get('item'));
  await expect(editionSelect(page).locator('option')).toHaveText(['Standard Edition · gemerkt', 'Premium Edition · Vorschau']);
  await expect(page.getByRole('status').filter({ hasText: 'Vorschau: Premium Edition' })).toBeVisible();
  // Verlauf: KPI tiles from the daily minima of both scopes and the dot-matrix chart.
  await openTab(page, 'Verlauf');
  await expect(page.locator('.kpi').filter({ hasText: 'Tiefstwert weltweit' })).toContainText('9,00');
  await expect(page.locator('.kpi').filter({ hasText: 'Tiefstwert DE' })).toContainText('12,00');
  await expect(page.locator('.kpi').filter({ hasText: 'Höchstwert DE' })).toContainText('14,00');
  const chart = page.getByRole('img', { name: /^Preisverlauf .* und weltweit, 30 Tage$/ });
  await expect(chart).toBeVisible();
  // One column per day; days without a valid measurement stay empty, nothing is interpolated.
  const data = page.locator('.matrix .sr-only table tbody tr'); // 1.0: the box is visually hidden, not the table (RESP-04)
  await expect(data).toHaveCount(30);
  await expect(data.nth(29)).toContainText('12,00');
  await expect(data.nth(29)).toContainText('9,00');
  await expect(data.nth(29 - 4)).toContainText('keine Messung');
  await expect(page.getByRole('button', { name: 'Hilfe zu leeren Spalten', exact: true })).toHaveAccessibleDescription(/keine gültige Messung/);
  // Keyboard and pointer highlight a column and show its prices in the tooltip.
  await chart.focus();
  await page.keyboard.press('End');
  const tip = page.locator('.matrix .tip');
  await expect(tip).toContainText('12,00');
  await expect(tip).toContainText(/INT\s*GL\s*9,00/); // 1.0: one name for the cheapest region worldwide (RESP-18)
  await expect(tip).toContainText(/Differenz\s*−3,00/);
  await page.keyboard.press('Escape');
  await expect(tip).toHaveCount(0);
  const box = (await chart.boundingBox())!;
  await page.mouse.move(box.x + box.width - 6, box.y + box.height / 2);
  await expect(tip).toContainText('12,00');
  await page.mouse.move(0, 0);
  await expect(tip).toHaveCount(0);
  // No alarm target: no target line.
  await expect(page.locator('.matrix line.target')).toHaveCount(0);
  // Range switch: 90 days in 30 columns of three days, 180 days in columns of six.
  await page.getByRole('radio', { name: '90 T', exact: true }).click();
  await expect(page.getByRole('img', { name: /90 Tage$/ })).toBeVisible();
  await expect(data).toHaveCount(30);
  await expect(data.first().locator('th')).toContainText('–');
  await expect(page.locator('.kpi').filter({ hasText: 'Höchstwert DE' })).toContainText('in 90 Tagen');
  await page.getByRole('radio', { name: '180 T', exact: true }).click();
  await expect(page.getByRole('img', { name: /180 Tage$/ })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(data).toHaveCount(15);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openTab(page, 'Editionen');
  await expect(page.getByRole('table', { name: 'Editionsinhalte', exact: true })).toBeVisible();
  await expect(page.getByRole('rowheader', { name: 'Zusatzpaket', exact: true })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Angebote nach Preis' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Zur gemerkten Edition', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Forza Horizon 5', exact: true, level: 1 })).toBeVisible();
  await removeCurrent(page);
});

test('wishlist column headers sort by name, price, saving and target distance and the choice survives reload', async ({ page }) => {
  await signInToFixture(page);
  const input = page.getByRole('searchbox', { name: 'Nach Spielen suchen', exact: true });
  await input.fill('forza');
  await page.getByRole('region', { name: 'Suchergebnisse' }).getByRole('button', { name: 'Forza Horizon 5 (Xbox Series X|S) vormerken', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Forza Horizon 5', exact: true, level: 1 })).toBeVisible();
  await input.fill('neu');
  await page.getByRole('region', { name: 'Suchergebnisse' }).getByRole('button', { name: 'Neuer Treffer vormerken', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Neuer Treffer', exact: true })).toBeVisible();
  const rows = await (await page.request.get('/api/v1/wishlist')).json();
  const forza = (item: { game: { igdb_id: number } }) => item.game.igdb_id === 1001;
  // Forza: 12,99 € with India at 5,99 € (saving 7,00 €) and a target of 13,00 € (reached). Neuer Treffer: 9,99 €, no saving, target 5,00 €.
  const badge = (item: { game: { igdb_id: number } }) => ({
    state: 'price',
    cents: forza(item) ? 1299 : 999,
    observed_at: 1795107000,
    checked_at: 1795107000,
    stale: false,
    pending: false,
    world: forza(item) ? { cents: 599, region: 'India', observed_at: 1795107000 } : { cents: 999, region: 'Global', observed_at: 1795107000 },
  });
  await mockPriceBadges(page, () => Object.fromEntries(rows.map((item: { id: string; game: { igdb_id: number } }) => [item.id, badge(item)])));
  await page.route('**/api/v1/alerts', route =>
    route.request().method() === 'GET'
      ? route.fulfill({
          json: {
            configured: true,
            events: [],
            rules: rows.map((item: { id: string; game: { igdb_id: number } }) => ({
              wish_id: item.id,
              mode: 'target',
              basis: 'base',
              target_cents: forza(item) ? 1300 : 500,
              enabled: true,
            })),
          },
        })
      : route.continue(),
  );
  await navTo(page, 'Wunschliste');
  const first = () => wishlistRows(page).first();
  // No sort select any more: the column headers sort (natural direction, reversed, back to newest first).
  await expect(page.getByLabel('Sortieren', { exact: true })).toHaveCount(0);
  const head = wishlistTable(page).locator('thead');
  const header = (name: string | RegExp) => head.getByRole('button', { name, exact: typeof name === 'string' });
  const sorted = (name: string | RegExp) => head.getByRole('columnheader', { name });
  await expect(head.getByRole('button')).toHaveText(['Spiel', /^Preis [A-Z]{2}$/, 'Preis INT', 'Ersparnis', 'Ziel', 'Status']);
  await expect(first()).toContainText('Neuer Treffer');
  await header('Ersparnis').click();
  await expect(sorted('Ersparnis')).toHaveAttribute('aria-sort', 'descending');
  await expect(first()).toContainText('Forza Horizon 5');
  await expect(first().locator('.c-save')).toContainText('−7,00 €');
  await page.reload();
  await expect(sorted('Ersparnis')).toHaveAttribute('aria-sort', 'descending');
  await header(/^Preis [A-Z]{2}$/).click();
  await expect(first()).toContainText('Neuer Treffer');
  await expect(sorted(/^Preis [A-Z]{2}$/)).toHaveAttribute('aria-sort', 'ascending');
  await expect(sorted('Ersparnis')).toHaveAttribute('aria-sort', 'none');
  await expect(first().locator('.c-de')).toContainText('9,99');
  // The target country is cheapest: the cell shows region and price like any other row, slightly highlighted.
  const homeBest = first().locator('.c-world .world-cell.home-best');
  await expect(homeBest).toContainText('9,99');
  await expect(homeBest.getByRole('img', { name: 'Global' })).toBeVisible();
  await expect(first().locator('.c-world')).not.toContainText('ist weltweit am günstigsten');
  await header(/^Preis [A-Z]{2}$/).click();
  await expect(first()).toContainText('Forza Horizon 5');
  await expect(sorted(/^Preis [A-Z]{2}$/)).toHaveAttribute('aria-sort', 'descending');
  await header('Status').click();
  await expect(first()).toContainText('Forza Horizon 5');
  await expect(first().locator('.c-status')).toContainText('Ziel erreicht');
  await expect(wishlistRows(page).nth(1).locator('.c-status')).toContainText('4,99 € über Ziel');
  await header('Spiel').click();
  await expect(first()).toContainText('Forza Horizon 5');
  await header('Spiel').click();
  await expect(first()).toContainText('Neuer Treffer');
  await header('Spiel').click();
  await expect(first()).toContainText('Neuer Treffer');
  await expect(head.locator('[aria-sort="ascending"], [aria-sort="descending"]')).toHaveCount(0);
  for (const name of ['Neuer Treffer', 'Forza Horizon 5']) {
    await openWishlistRow(page, name);
    await removeCurrent(page);
  }
});
