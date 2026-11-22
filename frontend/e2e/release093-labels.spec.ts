import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { signInToFixture } from './helpers';
import { openTab } from './detail-helpers';

/** A write to the API as the page would send it (origin and CSRF token). */
async function write(page: Page, method: 'POST' | 'DELETE', path: string, data?: object) {
  const { csrf_token: csrf } = await (await page.request.get('/api/v1/me')).json();
  return page.request.fetch(path, { method, data, headers: { 'X-CSRF-Token': csrf, Origin: new URL(page.url()).origin } });
}

// The suite shares one database: remove every wishlist entry a test leaves behind.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  for (const item of await (await page.request.get('/api/v1/wishlist')).json()) await write(page, 'DELETE', `/api/v1/wishlist/${item.id}`);
});

const now = () => Math.floor(Date.now() / 1000);
type State = 'current' | 'stale' | 'failed' | 'unknown';
const link = (id: number, region: string, cents: number, state: State, extra: object = {}) => ({
  id,
  source: 'eneba',
  url: `https://www.eneba.com/de/xbox-forza-horizon-5-${region.toLowerCase()}-key`,
  review: 'confirmed',
  can_confirm: true,
  eligible: state === 'current' && region === 'Global',
  queued: false,
  enabled: true,
  stale: state === 'stale',
  observed_at: now() - 3600,
  attempted_at: now() - 3600,
  last_error: state === 'failed' ? 'network' : null,
  retry_at: 0,
  reasons:
    state === 'stale'
      ? ['stale']
      : state === 'failed'
        ? ['source_error']
        : state === 'unknown'
          ? ['availability_unknown']
          : region === 'Global'
            ? []
            : ['activation_unknown'],
  data_state: state,
  current: state === 'current',
  fits_target: state === 'current' && region === 'Global',
  fresh_until: now() + 3600,
  mismatch: [],
  manual_allowed: true,
  product: { name: 'Forza Horizon 5 Xbox Key', region, market: 'DE', activation: region === 'Global' ? 'confirmed' : 'unknown', availability: 'in_stock' },
  quotes: [{ id: String(id), seller: null, base_cents: cents, estimated_total_cents: null }],
  ...extra,
});
const view = (links: object[], extra: object = {}) => ({
  links,
  histories: { preferred: [], all: [] },
  best_base: 2890,
  best_estimate: null,
  offer_count: links.length,
  target_country: 'DE',
  searches: [],
  sources: [],
  discovery_running: false,
  ...extra,
});
async function openOffers(page: Page, json: object, tab: 'preis' | 'angebote') {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInToFixture(page);
  const id = (await (await write(page, 'POST', '/api/v1/wishlist', { igdb_id: 1001, platform_id: 169 })).json()).item.id;
  await page.route('**/api/v1/wishlist/*/offers', route => (route.request().method() === 'GET' ? route.fulfill({ json }) : route.continue()));
  await page.goto(`/?item=${id}&tab=${tab}`);
  if (tab === 'angebote') await openTab(page, 'Angebote');
}

test('FUNC-03 / FUNC-12: stale, failed and unknown offers show no saving and no cart button, and never say "nicht in DE gültig"', async ({ page }) => {
  await openOffers(
    page,
    view([
      link(1, 'Global', 2890, 'current'),
      link(2, 'India', 500, 'stale'),
      link(3, 'Turkey', 600, 'failed'),
      link(4, 'Brazil', 700, 'unknown'),
      link(5, 'Peru', 1290, 'current'),
    ]),
    'angebote',
  );
  const table = page.getByRole('table', { name: 'Angebote nach Preis', exact: true });
  const rows = table.locator('tbody tr');
  await expect(rows).toHaveCount(5);
  const row = (name: RegExp) => rows.filter({ hasText: name });
  // Only the two current rows have a cart button and a saving column; the Global row is the best (3 rows: no saving).
  await expect(table.getByRole('button', { name: /in den Warenkorb$/ })).toHaveCount(2);
  for (const region of [/Indien/, /Türkei/, /Brasilien/]) {
    await expect(row(region).getByRole('button', { name: /in den Warenkorb$/ })).toHaveCount(0);
    await expect(row(region).locator('.save')).toHaveText('–');
  }
  await expect(row(/Indien/)).toContainText('veraltet');
  await expect(row(/Türkei/)).toContainText('Abruffehler');
  await expect(row(/Brasilien/)).toContainText('Verfügbarkeit unbekannt');
  await expect(row(/Peru/).locator('.save.big')).toContainText('−');
  await expect(page.getByText('nicht in DE gültig')).toHaveCount(0);
});

test('FUNC-03: the price tab ignores a stale or failed cheaper region and a missing valid price is no "nicht in DE gültig"', async ({ page }) => {
  await openOffers(page, view([link(1, 'Global', 2890, 'current'), link(2, 'India', 500, 'stale'), link(3, 'Turkey', 600, 'failed')]), 'preis');
  const compare = page.getByRole('group', { name: 'Preisvergleich', exact: true });
  await expect(compare.locator('.compare-side.world')).toContainText('28,90');
  await expect(compare.locator('.compare-mid')).toContainText('gleich');
  await expect(compare.locator('.compare-side.world')).not.toContainText('5,00');

  // Nothing current at all: the page says so and not that the offers are invalid in the target country.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.route('**/api/v1/wishlist/*/offers', route =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: view([link(2, 'India', 500, 'stale'), link(4, 'Brazil', 700, 'unknown')], { best_base: null }) })
      : route.continue(),
  );
  await page.reload();
  await expect(compare.locator('.compare-side.home')).toContainText('Kein aktueller Preis');
  await expect(page.getByText(/nicht in DE gültig|nichts in DE gültig|Kein gültiges Angebot/i)).toHaveCount(0);
  await expect(page.getByRole('main').getByText('Kein aktueller Preis', { exact: true }).first()).toBeVisible();
});

test('RESP-11: a failed fetch is called "Abruf fehlgeschlagen" in the detail, not "keine Angebote"', async ({ page }) => {
  const failed = view([], {
    best_base: null,
    offer_count: 0,
    searches: [{ source: 'eneba', status: 'error', checked_at: now() - 60, last_error: 'network', result_count: null }],
  });
  await openOffers(page, failed, 'preis');
  const compare = page.getByRole('group', { name: 'Preisvergleich', exact: true });
  await expect(compare.locator('.compare-side.home')).toContainText('Abruf fehlgeschlagen');
  await expect(page.getByRole('main').getByText('Abruf fehlgeschlagen', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Noch keine Angebote')).toHaveCount(0);
  await openTab(page, 'Angebote');
  await expect(page.getByRole('heading', { name: 'Abruf fehlgeschlagen', level: 3 })).toBeVisible();
  await expect(page.getByText('Noch keine regionalen Preise')).toHaveCount(0);
  await page.getByRole('region', { name: 'Angebotstabelle' }).getByRole('button', { name: 'Hilfe zum fehlgeschlagenen Abruf' }).hover();
  await expect(page.getByRole('tooltip').filter({ hasText: 'kein Ergebnis „keine Angebote“' })).toBeVisible();
});

test('RESP-14: the cart marks an INT offer that is not safely activatable in the target country and sums it apart', async ({ page }) => {
  await signInToFixture(page);
  const offer = (cents: number, region: string, fits: boolean, activation: string) => ({
    cents,
    estimate_cents: null,
    region,
    observed_at: now() - 60,
    stale: false,
    fits_target: fits,
    activation,
  });
  const entry = (n: number, name: string, scope: 'home' | 'world') => ({
    id: String(n).repeat(32),
    game_id: String(n),
    platform_id: 169,
    created_at: 1,
    verification: 'manual_unverified',
    game: null,
    manual_title: name,
    added_at: 1,
    source: 'eneba',
    scope,
    offers: { eneba: { home: offer(2890, 'Global', true, 'confirmed'), world: offer(1290, 'India', false, 'unknown') } },
  });
  await page.route('**/api/v1/cart', route =>
    route.request().method() === 'GET' ? route.fulfill({ json: [entry(1, 'Forza Horizon 5', 'world'), entry(2, 'Halo Infinite', 'home')] }) : route.continue(),
  );
  await page.goto('/?view=cart');
  const rows = page.getByRole('table', { name: 'Spiele im Warenkorb', exact: true }).locator('tbody tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator('.cart-risk')).toContainText('Aktivierung in DE ungeklärt');
  await expect(rows.nth(1).locator('.cart-risk')).toHaveCount(0);
  await rows.nth(0).getByRole('button', { name: 'Hilfe zur Aktivierung für Forza Horizon 5' }).focus();
  await expect(page.getByRole('tooltip').filter({ hasText: 'nicht sicher sagen' })).toBeVisible();
  // The totals stay (12,90 + 28,90), the unsafe part is named apart.
  const totals = page.getByRole('list', { name: 'Nach Shops' }).locator('..').getByRole('group', { name: 'Summe' }).or(page.locator('dl[aria-label="Summe"]'));
  await expect(totals).toContainText('41,80');
  await expect(totals).toContainText('davon nicht sicher in DE aktivierbar');
  await expect(totals.locator('dd.cart-risky')).toHaveText('12,90 €');
});
