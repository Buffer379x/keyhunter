import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { navTo, saveSettings, signInToFixture } from './helpers';
import { openTab } from './detail-helpers';
import { withState } from './offer-state';

/** A write to the API as the page would send it (origin and CSRF token). */
async function write(page: Page, method: 'POST' | 'PUT' | 'DELETE', path: string, data?: object) {
  const { csrf_token: csrf } = await (await page.request.get('/api/v1/me')).json();
  return page.request.fetch(path, { method, data, headers: { 'X-CSRF-Token': csrf, Origin: new URL(page.url()).origin } });
}

// The suite shares one database: remove every wishlist entry and put the offers columns back.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  for (const item of await (await page.request.get('/api/v1/wishlist')).json()) await write(page, 'DELETE', `/api/v1/wishlist/${item.id}`);
  const settings = await (await page.request.get('/api/v1/settings')).json();
  await write(page, 'PUT', '/api/v1/settings', {
    ...settings,
    offers_columns: ['shop', 'region', 'validity', 'price', 'diff', 'score', 'seen'],
    offers_hidden: ['score'],
  });
});

const now = () => Math.floor(Date.now() / 1000);
const rawLink = (id: number, region: string, cents: number, extra: object) => ({
  id,
  source: 'eneba',
  url: `https://www.eneba.com/de/xbox-forza-horizon-5-${region.toLowerCase()}-key`,
  review: 'confirmed',
  can_confirm: true,
  eligible: region === 'Global',
  queued: false,
  enabled: true,
  stale: false,
  observed_at: now() - 3600,
  attempted_at: now() - 3600,
  last_error: null,
  retry_at: 0,
  reasons: region === 'Global' ? [] : ['activation_unknown'],
  check_every: 14400,
  cheap_score: 0.1,
  product: { name: 'Forza Horizon 5 Xbox Key', region, market: 'DE', activation: region === 'Global' ? 'confirmed' : 'unknown', availability: 'in_stock' },
  quotes: [{ id: String(id), seller: null, base_cents: cents, estimated_total_cents: null }],
  ...extra,
});
const link = (...args: Parameters<typeof rawLink>) => withState(rawLink(...args));
const view = {
  links: [
    link(1, 'India', 1290, { score: 92 }),
    link(2, 'Global', 2890, { score: 41, cheap_score: 0.6, check_every: 33000 }),
    link(3, 'Turkey', 3100, { score: null, review: 'pending' }),
  ],
  histories: { preferred: [], all: [] },
  best_base: 2890,
  offer_count: 2,
  best_estimate: null,
  target_country: 'DE',
  searches: [],
  sources: [],
  discovery_running: false,
};

test('SCORE-03: the offers table hides the Prüftempo by default and shows häufig / normal / selten when it is turned on', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInToFixture(page);
  // No "Liste exportieren" on the wishlist any more; the export lives in the settings.
  await expect(page.getByRole('heading', { name: 'Wunschliste', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Liste exportieren' })).toHaveCount(0);

  const id = (await (await write(page, 'POST', '/api/v1/wishlist', { igdb_id: 1001, platform_id: 169 })).json()).item.id;
  await page.route('**/api/v1/wishlist/*/offers', route => (route.request().method() === 'GET' ? route.fulfill({ json: view }) : route.continue()));
  await page.goto(`/?item=${id}&tab=angebote`);
  await openTab(page, 'Angebote');
  const table = page.getByRole('table', { name: 'Angebote nach Preis', exact: true });
  // Default: the column is hidden; the name "Score" is gone everywhere.
  await expect(table.locator('thead th')).toHaveText(['Shop', 'Region', 'Gültigkeit', 'Preis', /^vs\. /, 'Gesehen', 'Link']);
  await expect(page.getByText('Score', { exact: false })).toHaveCount(0);
  expect((await (await page.request.get('/api/v1/settings')).json()).offers_hidden).toEqual(['score']);

  // Settings: Prüftempo on and first, Gesehen and Gültigkeit hidden; the price cannot be hidden.
  await navTo(page, 'Allgemein');
  await page.getByRole('tablist', { name: 'Tabelle', exact: true }).getByRole('tab', { name: 'Angebote', exact: true }).click();
  const list = page.getByRole('list', { name: 'Spaltenreihenfolge der Angebote', exact: true });
  await expect(list.getByRole('switch', { name: 'Preis anzeigen', exact: true })).toBeDisabled();
  await expect(list.getByRole('switch', { name: 'Prüftempo anzeigen', exact: true })).not.toBeChecked();
  await list.getByRole('switch', { name: 'Prüftempo anzeigen', exact: true }).click();
  await list.getByRole('switch', { name: 'Gesehen anzeigen', exact: true }).click();
  await list.getByRole('switch', { name: 'Gültigkeit anzeigen', exact: true }).click();
  for (let i = 0; i < 5; i++) await list.getByRole('button', { name: 'Prüftempo nach oben', exact: true }).click();
  await saveSettings(page);
  const saved = await (await page.request.get('/api/v1/settings')).json();
  expect(saved.offers_columns).toEqual(['score', 'shop', 'region', 'validity', 'price', 'diff', 'seen']);
  expect([...saved.offers_hidden].sort()).toEqual(['seen', 'validity']);

  await page.goto(`/?item=${id}&tab=angebote`);
  await openTab(page, 'Angebote');
  await expect(table.locator('thead th')).toHaveText([/^Prüftempo/, 'Shop', 'Region', 'Preis', /^vs\. /, 'Link']);
  const rows = table.locator('tbody tr');
  await expect(rows.nth(0).locator('td').first()).toHaveText('häufig');
  await expect(rows.nth(1).locator('td').first()).toHaveText('normal');
  await expect(rows.nth(0).locator('td').first().locator('span[title]')).toHaveAttribute('title', /^Prüftempo häufig · meist günstig · Abfrage alle 4 h/);
  // Unconfirmed: no Prüftempo.
  await expect(rows.nth(2).locator('td').first()).toHaveText('–');
  // The explanation sits behind the "?" of the column head, and says it is no rating.
  await table.getByRole('button', { name: 'Hilfe zum Prüftempo' }).hover();
  await expect(page.getByRole('tooltip').filter({ hasText: 'keine Bewertung' })).toBeVisible();
});
