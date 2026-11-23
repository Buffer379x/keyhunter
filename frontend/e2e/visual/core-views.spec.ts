import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fetchBudget, signInToFixture } from '../helpers';
import { withState } from '../offer-state';

// Visual regression of the seven core views at three viewports. Run only through deploy/visual-check.sh.
// Determinism: fixed clock, all price data mocked (the fixture has no shop prices), animations and caret off.

const NOW_MS = Date.UTC(2026, 10, 20, 12, 0, 0); // fixed "now" for page.clock and for every mocked timestamp
const now = NOW_MS / 1000,
  H = 3600,
  D = 86400;

const rawLink = (id: number, source: string, region: string, cents: number, reasons: string[], extra = {}) => ({
  id,
  source,
  url: 'https://www.eneba.com/de/xbox-fixture-key-global',
  review: 'confirmed',
  can_confirm: true,
  eligible: reasons.length === 0,
  queued: false,
  enabled: true,
  stale: false,
  observed_at: now - 2 * H,
  attempted_at: now - 2 * H,
  last_error: null,
  retry_at: 0,
  reasons,
  product: {
    name: `Forza Horizon 5 ${region} Key`,
    region,
    market: 'DE',
    activation: reasons.includes('activation_blocked') ? 'blocked' : reasons.length ? 'unknown' : 'confirmed',
    availability: reasons.includes('sold_out') ? 'sold_out' : 'in_stock',
  },
  quotes: reasons.includes('sold_out')
    ? []
    : [
        {
          id: String(id),
          seller: id === 2 ? 'Zero Zero' : null,
          base_cents: cents,
          estimated_total_cents: region === 'Argentina' ? null : Math.round(cents * 1.02),
        },
      ],
  ...extra,
});
const link = (...args: Parameters<typeof rawLink>) => withState(rawLink(...args));
const pt = (days: number, cents: number, region: string, source = 'eneba') => ({ observed_at: now - days * D, base_cents: cents, link_id: 1, region, source });
const offers = {
  links: [
    link(1, 'eneba', 'India', 1290, ['activation_unknown', 'purchase_context_mismatch']),
    link(2, 'driffle', 'Argentina', 1490, ['activation_blocked']),
    link(3, 'eneba', 'Global', 2890, []),
    link(4, 'driffle', 'DE', 3000, []),
    link(5, 'eneba', 'Europe', 0, ['sold_out']),
  ],
  histories: {
    preferred: [pt(21, 3499, 'DE'), pt(14, 3299, 'DE', 'driffle'), pt(8, 3099, 'Global'), pt(1, 2890, 'Global')],
    all: [pt(21, 1590, 'India'), pt(14, 1490, 'Argentina', 'driffle'), pt(8, 1390, 'India'), pt(1, 1290, 'India')],
  },
  best_base: 2890,
  best_estimate: 2948,
  last_known: null,
  offer_count: 4,
  target_country: 'DE',
  searches: [{ source: 'eneba', status: 'complete', checked_at: now - 2 * H, result_count: 3, last_error: null }],
  sources: [],
  discovery_running: false,
};
const badge = {
  state: 'price',
  cents: 2890,
  observed_at: now - 2 * H,
  checked_at: now - 2 * H,
  stale: false,
  pending: false,
  source: 'eneba',
  region: 'Global',
  world: { cents: 1290, source: 'eneba', region: 'India', observed_at: now - 2 * H },
  trend: [3499, 3499, 3299, 3299, 3299, 3299, 3299, 3099, 3099, 3099, 3099, 3099, 3099, 2890],
};
const fetchStatus = {
  shops: [
    {
      source: 'eneba',
      enabled: true,
      last_success_at: now - 60,
      last_error: null,
      paused_until: null,
      budget: fetchBudget({
        used: 64,
        limit: 500,
        limit_source: 'setting',
        demand_per_day: 430,
        pace_seconds: 170,
        next_at: now + 170,
        by_hour: [3, 4, 3, 2, 3, 4, 5, 4, 5, 6, 6, 5, 14, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      }),
      backlog: { due: 14, requested: 3, products: 9, searches: 5 },
      oldest_due_at: now - 1500,
      next_due_at: now + 900,
      worker_seen_at: now - 2,
    },
    {
      source: 'driffle',
      enabled: true,
      last_success_at: now - 7200,
      last_error: 'rate_limited',
      paused_until: now + 2400,
      budget: fetchBudget({
        used: 41,
        limit: 120,
        limit_source: 'env',
        demand_per_day: 160,
        pace_seconds: 540,
        next_at: now + 2400,
        by_hour: [2, 2, 3, 3, 3, 4, 3, 4, 4, 5, 4, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      }),
      backlog: { due: 6, requested: 0, products: 4, searches: 2 },
      oldest_due_at: now - 5400,
      next_due_at: now + 3200,
      worker_seen_at: now - 1,
    },
  ],
  errors_24h: 5,
  recent_runs: [
    { source: 'eneba', kind: 'product', wish_id: null, link_id: 1, started_at: now - 40, duration_ms: 1180, outcome: 'ok', detail: 'Forza Horizon 5' },
    { source: 'driffle', kind: 'search', wish_id: null, link_id: null, started_at: now - 300, duration_ms: 210, outcome: 'rate_limited', detail: null },
    { source: 'eneba', kind: 'discovery', wish_id: null, link_id: null, started_at: now - 900, duration_ms: 8300, outcome: 'ok', detail: null },
  ],
  upcoming: [
    {
      source: 'eneba',
      kind: 'product',
      wish_id: null,
      link_id: 2,
      game: 'Forza Horizon 5',
      region: 'India',
      search_page: null,
      due_at: now + 170,
      requested: true,
    },
    {
      source: 'eneba',
      kind: 'search',
      wish_id: 'a'.repeat(32),
      link_id: null,
      game: 'Starfield',
      region: null,
      search_page: 2,
      due_at: now + 340,
      requested: false,
    },
    {
      source: 'driffle',
      kind: 'product',
      wish_id: null,
      link_id: 3,
      game: 'Forza Horizon 5',
      region: 'Global',
      search_page: null,
      due_at: now + 2400,
      requested: false,
    },
  ],
};
/** GET /status/fetch/runs (0.8.3): the same runs with their game, one page. */
const runPage = {
  runs: fetchStatus.recent_runs.map((run, id) => ({
    ...run,
    id,
    game: run.kind === 'discovery' ? null : 'Forza Horizon 5',
    region: run.kind === 'product' ? 'Global' : null,
  })),
  total: 3,
  page: 1,
  per_page: 50,
};

async function freeze(page: Page) {
  await page.clock.install({ time: NOW_MS });
  await page.clock.setFixedTime(NOW_MS); // Date.now() never advances, timers keep running: "vor 2 Std.", "Stand 12:00:00" and chart windows stay put
}

async function mockPrices(page: Page) {
  const ids: string[] = [];
  await page.route('**/api/v1/wishlist/*/offers', r => (r.request().method() === 'GET' ? r.fulfill({ json: offers }) : r.continue()));
  await page.route(/\/api\/v1\/wishlist\/price-badges(\?.*)?$/, r => r.fulfill({ json: Object.fromEntries(ids.map(id => [id, badge])) }));
  await page.route('**/api/v1/wishlist', async r => {
    if (r.request().method() !== 'GET') return r.continue();
    const rows = await (await r.fetch()).json();
    ids.splice(0, ids.length, ...rows.map((x: { id: string }) => x.id));
    await r.fulfill({ json: rows.map((x: object) => ({ ...x, price_badge: badge, offer_count: offers.offer_count })) });
  });
  await page.route('**/api/v1/wishlist/*/alert', r =>
    r.request().method() === 'GET'
      ? r.fulfill({ json: { rule: { mode: 'target', basis: 'base', target_cents: 2900, enabled: true }, configured: true } })
      : r.continue(),
  );
  await page.route('**/api/v1/alerts', r => (r.request().method() === 'GET' ? r.fulfill({ json: { configured: true, rules: [], events: [] } }) : r.continue()));
  await page.route('**/api/v1/status/fetch', r => r.fulfill({ json: fetchStatus }));
  await page.route('**/api/v1/status/fetch/runs?*', r => r.fulfill({ json: runPage }));
}

/** Signs in, makes sure exactly Forza Horizon 5 is on the wishlist and returns its id. */
async function prepare(page: Page): Promise<string> {
  await freeze(page);
  await mockPrices(page);
  await signInToFixture(page);
  let rows = await (await page.request.get('/api/v1/wishlist')).json();
  if (!rows.length) {
    // The new game opens and asks the server to prepare its editions. Leaving the page before the answer drops that
    // request half way and the server keeps the preparation "running" for three minutes: every detail view in that time
    // would show "Editionen werden vorbereitet …". So wait for the answer first.
    const answered = page.waitForResponse(r => r.request().method() === 'POST' && /\/wishlist\/[^/]+\/editions$/.test(new URL(r.url()).pathname));
    await page.getByRole('searchbox', { name: 'Nach Spielen suchen', exact: true }).fill('forza');
    await page
      .getByRole('region', { name: 'Suchergebnisse' })
      .getByRole('button', { name: 'Forza Horizon 5 (Xbox Series X|S) vormerken', exact: true })
      .click();
    await expect(page).toHaveURL(/[?&]item=/);
    await answered;
    rows = await (await page.request.get('/api/v1/wishlist')).json();
  }
  return rows[0].id;
}

// DS-08: stress data. Many wishes with very long titles, an offers table with eleven rows of mixed states, a filled cart and a log page.
const LONG_TITLES = [
  'Microsoft Flight Simulator 2024: Premium Deluxe Edition mit allen Flugzeugen und Flughäfen sowie dem Weltraumpaket',
  'The Elder Scrolls IV: Oblivion Remastered Deluxe Edition inklusive aller Erweiterungen und Zusatzinhalte',
  'Halo Infinite',
  'Call of Duty: Black Ops 6 Vault Edition – Kampagne, Mehrspieler, Zombies und Warzone Zusatzpaket',
  'Lies of P',
  'Assassin’s Creed Valhalla Complete Edition inklusive Season Pass und allen Erweiterungen der Saga',
  'Forza Horizon 5',
  'Star Wars Jedi: Survivor Deluxe Edition',
  'A Plague Tale: Requiem',
  'Sid Meier’s Civilization VII Founders Edition mit Vorbestellerbonus und digitalem Artbook',
];
const wishRows = Array.from({ length: 32 }, (_, i) => {
  const n = i + 1;
  const kind = n % 5;
  const price = kind === 1 || kind === 2 || kind === 4;
  const cents = 1500 + n * 137;
  return {
    id: n.toString(16).padStart(32, '0'),
    game_id: String(n),
    platform_id: n % 7 === 0 ? 49 : 169,
    created_at: now - n * D,
    verification: n % 11 === 0 ? 'needs_review' : 'manual_unverified',
    game: null,
    manual_title: `${LONG_TITLES[i % LONG_TITLES.length]}${i >= LONG_TITLES.length ? ` (Eintrag ${n})` : ''}`,
    in_cart: n % 9 === 0,
    paused: n % 13 === 0,
    paused_until: null,
    // The count follows the badge: rows without any price (kinds 0 and 3) have no offers.
    offer_count: price ? kind + 1 : 0,
    review_count: n % 11 === 0 ? 2 : 0,
    price_badge: price
      ? { ...badge, cents, world: kind === 2 ? null : { ...badge.world, cents: Math.round(cents * 0.6) }, stale: kind === 4 }
      : { ...badge, state: kind === 3 ? 'no_offer' : 'unknown', cents: null, world: null, trend: undefined, pending: n % 4 === 0 },
  };
});
const offerLink = (id: number, source: string, region: string, name: string, cents: number, reasons: string[], extra: object = {}) =>
  link(id, source, region, cents, reasons, { product: { name, region, market: 'DE', activation: 'confirmed', availability: 'in_stock' }, ...extra });
const manyOffers = {
  ...offers,
  offer_count: 8,
  links: [
    offerLink(11, 'eneba', 'Global', 'Forza Horizon 5 Premium Edition Xbox Series X|S / Windows PC Key (Global, Aktivierung weltweit)', 2890, []),
    offerLink(12, 'driffle', 'DE', 'Forza Horizon 5 Xbox Key DE', 3000, [], { check_every: 3 * H, cheap_score: 0.1 }),
    offerLink(13, 'eneba', 'Europe', 'Forza Horizon 5 Europe Key', 3190, [], { stale: true, reasons: ['stale'], eligible: false, observed_at: now - 3 * D }),
    offerLink(14, 'driffle', 'India', 'Forza Horizon 5 India Key', 1290, ['activation_unknown', 'purchase_context_mismatch'], { cheap_score: 0.9 }),
    offerLink(15, 'eneba', 'Argentina', 'Forza Horizon 5 Argentina Key', 1490, ['activation_blocked']),
    offerLink(16, 'eneba', 'Turkey', 'Forza Horizon 5 Turkey Key', 1190, ['activation_unknown']),
    offerLink(17, 'driffle', 'Global', 'Forza Horizon 5 Global Key', 0, ['sold_out']),
    offerLink(18, 'eneba', 'Europe', 'Forza Horizon 5 Standard Edition EU', 0, ['source_error'], {
      last_error: 'http_500',
      retry_at: now + H,
      observed_at: null,
      quotes: [],
    }),
    offerLink(19, 'driffle', 'Global', 'Forza Horizon 5 Key (Zuordnung offen)', 0, [], {
      review: 'needs_review',
      eligible: false,
      quotes: [],
      observed_at: null,
    }),
    offerLink(20, 'eneba', 'Brazil', 'Forza Horizon 5 Brazil Key', 1390, ['availability_unknown'], { queued: true }),
    offerLink(21, 'driffle', 'Global', 'Forza Horizon 5 Global Key (von Hand bestätigt)', 3250, [], {
      manual_match: true,
      renamed: { from: 'Forza Horizon 5', to: 'Forza Horizon 5 Deluxe' },
    }),
  ],
};
const cartOffer = (cents: number, region: string, stale = false) => ({
  cents,
  estimate_cents: Math.round(cents * 1.03),
  region,
  observed_at: now - 2 * H,
  stale,
  fits_target: true,
  activation: 'confirmed',
});
const cartEntry = (n: number, title: string, source: string | null, scope: 'home' | 'world', offers: object) => ({
  id: n.toString(16).padStart(32, '0'),
  game_id: String(n),
  platform_id: 169,
  created_at: now - n * D,
  verification: 'manual_unverified',
  game: null,
  manual_title: title,
  in_cart: true,
  added_at: now - n * H,
  source,
  scope,
  offers,
});
const cartEntries = [
  cartEntry(1, 'Forza Horizon 5', 'eneba', 'home', {
    eneba: { home: cartOffer(2890, 'Global'), world: cartOffer(1290, 'India') },
    driffle: { home: cartOffer(3000, 'DE'), world: null },
  }),
  cartEntry(2, 'Microsoft Flight Simulator 2024: Premium Deluxe Edition mit allen Flugzeugen', null, 'world', {
    eneba: { home: cartOffer(5490, 'Europe'), world: cartOffer(3990, 'Argentina') },
    driffle: { home: cartOffer(5790, 'Global'), world: cartOffer(4190, 'Turkey') },
  }),
  cartEntry(3, 'Halo Infinite', 'driffle', 'home', { driffle: { home: cartOffer(1990, 'DE', true), world: null } }),
  cartEntry(4, 'Lies of P', 'eneba', 'home', { eneba: { home: cartOffer(2490, 'Global'), world: null } }),
  cartEntry(5, 'Starfield', null, 'world', {}),
  cartEntry(6, 'A Plague Tale: Requiem', 'driffle', 'world', { driffle: { home: null, world: cartOffer(1490, 'India') } }),
];
const logEntries = Array.from({ length: 24 }, (_, i) => {
  const level = i % 7 === 3 ? 'error' : i % 4 === 1 ? 'warn' : 'info';
  const messages = {
    info: [
      'Angemeldet',
      'Wunschliste: „Forza Horizon 5“ hinzugefügt',
      'Warenkorb geändert',
      'Einstellungen gespeichert',
      'Zuordnung bestätigt: Eneba, Forza Horizon 5 Global Key',
    ],
    warn: ['Driffle: Rate-Limit erreicht, Pause bis 13:10', 'Benachrichtigung konnte nicht zugestellt werden, neuer Versuch in 15 Minuten'],
    error: [
      'Eneba: Abruf fehlgeschlagen (HTTP 500) für Forza Horizon 5 Premium Edition Xbox Series X|S / Windows PC Key mit sehr langem Produktnamen aus dem Shop',
    ],
  }[level];
  return {
    id: 100 - i,
    at: now - i * 1800,
    level,
    area: ['Anmeldung', 'Wunschliste', 'Abruf', 'Warenkorb', 'Benachrichtigung'][i % 5],
    message: messages[i % messages.length],
  };
});
const logPage = { entries: logEntries, total: 61, page: 1, per_page: 25 };
const mockLog = async (page: Page) => {
  await page.route(/\/api\/v1\/log(\?.*)?$/, r => r.fulfill({ json: logPage }));
};

// Volatile: the app version (sidebar, Einstellungen › System) changes with every release.
const masks = (page: Page) => [page.locator('.version, .app-version')];

async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300); // charts and lazy rows finish painting
}

/**
 * Opens a game and waits for its editions to be settled: the page asks the server to prepare them on every open, and
 * while another request still holds the preparation the answer is "preparing" and the hint "Editionen werden vorbereitet …"
 * shows until the next poll (3 s). A fixed pause could capture it; waiting for the answer and for the hint to go cannot.
 */
async function openGame(page: Page, query: string) {
  const answered = page.waitForResponse(r => r.request().method() === 'POST' && /\/wishlist\/[^/]+\/editions$/.test(new URL(r.url()).pathname));
  await page.goto(`/?${query}`);
  await page.getByRole('tablist', { name: 'Spieldetails' }).waitFor();
  await answered;
  await expect(page.getByText('Editionen werden vorbereitet …')).toHaveCount(0, { timeout: 15_000 });
}

const viewports = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1024', width: 1024, height: 768 },
  { name: '768', width: 768, height: 1024 },
  { name: '390', width: 390, height: 844 },
];

// The setup screen only exists on a never-initialised server, so it is captured first, at all viewports in one test
// (tests run in file order with one worker; every later test signs in and thereby creates the account).
test('setup screen', async ({ page }) => {
  await freeze(page);
  for (const vp of viewports) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Privaten Bereich einrichten', exact: true })).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot(`setup-${vp.name}.png`);
  }
});

for (const vp of viewports) {
  test.describe(`viewport ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    const detail = (tab: string, file: string) =>
      test(`wishlist ${tab || 'preis'}`, async ({ page }) => {
        const id = await prepare(page);
        await openGame(page, `item=${id}${tab ? `&tab=${tab}` : ''}`);
        await settle(page);
        await expect(page).toHaveScreenshot(`${file}-${vp.name}.png`, { mask: masks(page) });
      });
    test('wishlist list', async ({ page }) => {
      await prepare(page);
      await page.goto('/');
      await expect(page.getByRole('main').getByRole('heading', { name: 'Wunschliste', level: 1 })).toBeVisible();
      await expect(page.locator('table.wl tbody tr')).toHaveCount(1);
      await settle(page);
      await expect(page).toHaveScreenshot(`wishlist-${vp.name}.png`, { mask: masks(page) });
    });
    detail('', 'wishlist-preis');
    detail('angebote', 'angebote');
    detail('verlauf', 'verlauf');

    const settings = (section: string, file: string, tabName: string, ready = '', mock?: (page: Page) => Promise<void>) =>
      test(`settings ${file}`, async ({ page }) => {
        await prepare(page);
        await mock?.(page);
        await page.goto(`/?view=settings${section ? `&section=${section}` : ''}`);
        await expect(page.getByRole('main').getByRole('heading', { name: 'Einstellungen', level: 1 })).toBeVisible();
        await expect(page.getByRole('tablist', { name: 'Einstellungen', exact: true }).getByRole('tab', { name: tabName, exact: true })).toHaveAttribute(
          'aria-selected',
          'true',
        );
        if (ready) await expect(page.getByText(ready).first()).toBeVisible();
        await settle(page);
        await expect(page).toHaveScreenshot(`${file}-${vp.name}.png`, { mask: masks(page) });
      });
    test('library unlocked', async ({ page }) => {
      await prepare(page);
      const entry = (n: number, title: string, platform: number, acquired: number) => ({
        id: String(n).repeat(32),
        game_id: String(n),
        platform_id: platform,
        created_at: n,
        acquired_at: acquired,
        verification: 'manual_unverified',
        game: null,
        manual_title: title,
      });
      await page.route('**/api/v1/library', r =>
        r.fulfill({
          json: [
            entry(1, 'Halo Infinite', 169, 1795107000),
            entry(2, 'Microsoft Flight Simulator 2024: Premium Deluxe Edition mit allen Flugzeugen', 169, 1790000000),
            entry(3, 'Lies of P', 49, 1780000000),
          ],
        }),
      );
      await page.goto('/?view=library');
      await expect(page.getByRole('main').getByRole('heading', { name: 'Bibliothek', level: 1 })).toBeVisible();
      await page.getByRole('button', { name: 'Bearbeiten entsperren', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Halo Infinite aus der Bibliothek entfernen', exact: true })).toBeVisible();
      await settle(page);
      await expect(page).toHaveScreenshot(`library-${vp.name}.png`, { mask: masks(page) });
    });
    settings('', 'settings-allgemein', 'Allgemein');
    settings('status', 'settings-abrufstatus', 'Abrufstatus', 'Nächste Abfragen');
    settings('system', 'settings-system', 'System', 'Passphrase ändern');

    test('wishlist many long titles', async ({ page }) => {
      await prepare(page);
      await page.route('**/api/v1/wishlist', r => (r.request().method() === 'GET' ? r.fulfill({ json: wishRows }) : r.continue()));
      await page.goto('/');
      await expect(page.getByRole('main').getByRole('heading', { name: 'Wunschliste', level: 1 })).toBeVisible();
      await expect(page.locator('table.wl tbody tr')).toHaveCount(25); // the first page at the default size of 25 (1.0.2)
      await settle(page);
      await expect(page).toHaveScreenshot(`wishlist-long-${vp.name}.png`, { mask: masks(page) });
    });
    test('offers many rows', async ({ page }) => {
      const id = await prepare(page);
      await page.route('**/api/v1/wishlist/*/offers', r => (r.request().method() === 'GET' ? r.fulfill({ json: manyOffers }) : r.continue()));
      await openGame(page, `item=${id}&tab=angebote`);
      await expect(page.getByRole('table', { name: 'Angebote nach Preis' }).getByRole('cell', { name: 'Brasilien', exact: true })).toBeVisible();
      await settle(page);
      await expect(page).toHaveScreenshot(`angebote-many-${vp.name}.png`, { mask: masks(page) });
    });
    test('cart', async ({ page }) => {
      await prepare(page);
      await page.route(/\/api\/v1\/cart$/, r => (r.request().method() === 'GET' ? r.fulfill({ json: cartEntries }) : r.continue()));
      await page.goto('/?view=cart');
      await expect(page.getByRole('main').getByRole('heading', { name: 'Warenkorb', level: 1 })).toBeVisible();
      await expect(page.getByText('Lies of P').first()).toBeVisible();
      await settle(page);
      await expect(page).toHaveScreenshot(`cart-${vp.name}.png`, { mask: masks(page) });
    });
    settings('log', 'settings-log', 'Log', 'Ereignisse', mockLog);
    // 1.0 (PROD-02): the first steps of a new owner below the empty list: no game yet, no notification channel.
    test('wishlist first steps', async ({ page }) => {
      await prepare(page);
      await page.route('**/api/v1/wishlist', r => (r.request().method() === 'GET' ? r.fulfill({ json: [] }) : r.continue()));
      await page.route('**/api/v1/alerts', r =>
        r.request().method() === 'GET' ? r.fulfill({ json: { configured: false, channels: [], rules: [], events: [] } }) : r.continue(),
      );
      await page.goto('/');
      await expect(page.getByRole('region', { name: 'Erste Schritte', exact: true })).toBeVisible();
      await settle(page);
      await expect(page).toHaveScreenshot(`wishlist-first-steps-${vp.name}.png`, { mask: masks(page) });
    });
    // 1.1: the delivery cards of the alarms (only below 720 px): title and price, time, then the status with the channel line over the full width.
    if (vp.name === '390')
      test('alerts deliveries', async ({ page }) => {
        await prepare(page);
        await page.route('**/api/v1/alerts', r =>
          r.request().method() !== 'GET'
            ? r.continue()
            : r.fulfill({
                json: {
                  configured: true,
                  channels: ['Telegram', 'E-Mail'],
                  rules: [],
                  events: [
                    {
                      id: 1,
                      wish_id: null,
                      state: 'sent',
                      observed_at: now - 2 * H,
                      sent_at: now - 2 * H + 60,
                      cents: 1290,
                      attempts: 3,
                      deliveries: [
                        { channel: 'telegram', name: 'Telegram', state: 'sent', attempts: 1, error: null },
                        { channel: 'email', name: 'E-Mail', state: 'failed', attempts: 3, error: 'SMTP: permanent error (535)' },
                      ],
                    },
                  ],
                },
              }),
        );
        await page.goto('/?view=alerts');
        const deliveries = page.getByRole('table', { name: 'Letzte Zustellungen' });
        await expect(deliveries.locator('.delivery-channels')).toBeVisible();
        await deliveries.scrollIntoViewIfNeeded();
        await settle(page);
        await expect(page).toHaveScreenshot(`alerts-deliveries-${vp.name}.png`, { mask: masks(page) });
      });
  });
}
