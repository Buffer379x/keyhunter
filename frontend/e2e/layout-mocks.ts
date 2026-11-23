import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { signInToFixture } from './helpers';
import { withState } from './offer-state';

/**
 * Data for the layout checks of release094-responsive.spec.ts (from the release-1.0 design preview): the real Forza Horizon 5
 * wish of the fixture plus twelve mocked wishes (very long titles, paused, cart, warnings, manual titles, every price state)
 * and an offers view with eleven links in many regions. Fixed clock; every request that leaves the fixture is aborted.
 */
const NOW_MS = Date.UTC(2026, 10, 20, 12, 0, 0);
const now = NOW_MS / 1000,
  H = 3600,
  D = 86400;

type Badge = Record<string, unknown>;
const trend = (from: number, to: number) => Array.from({ length: 14 }, (_, k) => Math.round(from + (to - from) * Math.min(1, k / 10)));
const priceBadge = (cents: number, world: [number, string], extra: Badge = {}): Badge => ({
  state: 'price',
  cents,
  observed_at: now - 2 * H,
  checked_at: now - 2 * H,
  stale: false,
  pending: false,
  source: 'eneba',
  region: 'Europe',
  estimate_cents: Math.round(cents * 1.04),
  world: { cents: world[0], source: 'driffle', region: world[1], observed_at: now - 3 * H, base_cents: world[0], estimate_cents: Math.round(world[0] * 1.05) },
  trend: trend(cents + 900, cents),
  ...extra,
});
const empty = (state: string, extra: Badge = {}): Badge => ({
  state,
  cents: null,
  observed_at: null,
  checked_at: state === 'unknown' ? null : now - H,
  stale: false,
  pending: false,
  world: null,
  trend: [],
  ...extra,
});
const game = (igdb: number, name: string, platform: number, extra: Record<string, unknown> = {}) => ({
  igdb_id: igdb,
  name,
  slug: null,
  summary: null,
  first_release_date: 1700000000,
  platforms: [{ id: platform, name: '' }],
  aliases: [],
  cover_url: null,
  version_parent: null,
  edition_name: null,
  kind: 'base_game',
  fetched_at: now,
  ...extra,
});

const synthetic: { title: string; badge: Badge; platform?: number; manual?: boolean; extra?: Record<string, unknown>; game?: Record<string, unknown> }[] = [
  { title: 'Starfield', badge: priceBadge(3499, [1840, 'TR']), extra: { in_cart: true } },
  { title: 'Indiana Jones und der Große Kreis', badge: priceBadge(4490, [4490, 'DE']) },
  { title: 'Hogwarts Legacy', badge: priceBadge(2150, [1190, 'AR'], { stale: true, observed_at: now - 9 * D, checked_at: now - 4 * D }), platform: 49 },
  {
    title: 'Microsoft Flight Simulator 2024: Premium Deluxe Edition mit allen Flugzeugen und Flughäfen',
    badge: empty('unknown'),
    platform: 49,
    manual: true,
    extra: { paused: true, paused_until: null },
  },
  { title: 'Avowed', badge: empty('no_offer') },
  { title: 'Halo: The Master Chief Collection', badge: empty('review'), platform: 49, manual: true, extra: { review_count: 2 } },
  { title: 'Lies of P', badge: priceBadge(1899, [1250, 'IN']), extra: { paused: true, paused_until: now + 6 * D, in_cart: true } },
  { title: 'South of Midnight', badge: empty('error') },
  { title: "Senua's Saga: Hellblade II", badge: priceBadge(1999, [980, 'AR'], { estimate_cents: null }), extra: { in_cart: true } },
  { title: 'Hollow Knight', badge: empty('unknown', { pending: true }), manual: true },
  {
    title: "Tom Clancy's Splinter Cell: Chaos Theory – Abwärtskompatible Classic Edition",
    badge: priceBadge(799, [499, 'PL']),
    platform: 12,
    extra: { review_count: 1 },
  },
  { title: 'Starfield', badge: priceBadge(5999, [3990, 'BR']), game: { edition_name: 'Premium Edition', kind: 'edition' } },
];
const syntheticRows = synthetic.map((s, i) => ({
  id: (0xa000 + i).toString(16).padStart(32, '0'),
  game_id: `layout-${i}`,
  platform_id: s.platform ?? 169,
  created_at: now - (i + 2) * D,
  verification: s.manual ? 'manual_unverified' : 'catalog',
  game: s.manual ? null : game(5000 + i, s.title, s.platform ?? 169, s.game),
  manual_title: s.manual ? s.title : null,
  offer_count: s.badge.state === 'price' ? 4 + i : 0,
  review_count: 0,
  in_cart: false,
  paused: false,
  ...s.extra,
  price_badge: s.badge,
}));
/** Rows of the mocked wishlist: the real wish of the fixture first. */
export const WISHES = synthetic.length + 1;

const link = (id: number, source: string, region: string, quotes: [number, string | null][], reasons: string[], extra: Record<string, unknown> = {}) =>
  withState({
    id,
    source,
    url: `https://shop.invalid/${source}/${id}`,
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
    score: 55,
    check_every: 3 * H,
    product: {
      name: `Forza Horizon 5 ${region} Key`,
      region,
      market: 'DE',
      activation: reasons.includes('activation_blocked') ? 'blocked' : reasons.some(r => r.startsWith('activation')) ? 'unknown' : 'confirmed',
      availability: reasons.includes('sold_out') ? 'sold_out' : 'in_stock',
    },
    quotes: reasons.includes('sold_out')
      ? []
      : quotes.map(([cents, seller], k) => ({ id: `${id}-${k}`, seller, base_cents: cents, estimated_total_cents: Math.round(cents * 1.04) })),
    ...extra,
  });
const seller = 'GameKeys Express Store International Ltd.';
const offers = {
  links: [
    link(1, 'eneba', 'India', [[1290, seller]], ['activation_unknown', 'purchase_context_mismatch']),
    link(2, 'driffle', 'Argentina', [[1490, null]], ['activation_blocked']),
    link(7, 'eneba', 'Brazil', [[1650, 'Brasil Games Digital']], ['activation_blocked']),
    link(3, 'driffle', 'Turkey', [[1750, null]], ['activation_unknown', 'stale'], { stale: true, observed_at: now - 9 * D }),
    link(8, 'eneba', 'US', [[2200, 'US Keys']], ['activation_blocked']),
    link(9, 'driffle', 'Poland', [[2650, null]], ['activation_unknown']),
    link(
      4,
      'eneba',
      'Global',
      [
        [2890, seller],
        [3010, 'Zweiter Händler'],
      ],
      [],
    ),
    link(5, 'driffle', 'DE', [[3000, null]], []),
    link(10, 'driffle', 'Europe', [[2399, null]], [], { stale: true, observed_at: now - 6 * D }),
    link(6, 'eneba', 'Europe', [], ['sold_out']),
    link(11, 'eneba', 'Global', [[2490, null]], [], { review: 'pending', score: null }),
  ],
  histories: { preferred: [], all: [] },
  best_base: 2890,
  best_estimate: 3006,
  last_known: null,
  offer_count: 10,
  target_country: 'DE',
  searches: [{ source: 'eneba', status: 'complete', checked_at: now - 2 * H, result_count: 6, last_error: null }],
  sources: [],
  discovery_running: false,
};
const forzaBadge = priceBadge(2890, [1290, 'IN'], { region: 'Global' });

/** A write to the API as the page sends it (origin and CSRF token). */
async function write(page: Page, method: 'POST' | 'DELETE', path: string, data?: object) {
  const { csrf_token: csrf } = await (await page.request.get('/api/v1/me')).json();
  return page.request.fetch(path, { method, data, headers: { 'X-CSRF-Token': csrf, Origin: new URL(page.url()).origin } });
}

/** Fixed clock, outside requests aborted, list, badges, offers and alarm mocked. */
async function mockAll(page: Page) {
  await page.clock.install({ time: NOW_MS });
  await page.clock.setFixedTime(NOW_MS);
  let forzaId = '';
  await page.route(
    url => !['127.0.0.1', 'localhost'].includes(url.hostname),
    route => route.abort(),
  );
  await page.route('**/api/v1/wishlist', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const rows = await (await route.fetch()).json();
    forzaId = rows[0]?.id ?? '';
    const real = rows.map((row: object) => ({ ...row, price_badge: forzaBadge, offer_count: 10, in_cart: true, review_count: 1 }));
    await route.fulfill({ json: [...real, ...syntheticRows] });
  });
  await page.route(/\/api\/v1\/wishlist\/price-badges(\?.*)?$/, route =>
    route.fulfill({ json: Object.fromEntries([[forzaId, forzaBadge], ...syntheticRows.map(row => [row.id, row.price_badge])]) }),
  );
  await page.route('**/api/v1/wishlist/*/offers', route => (route.request().method() === 'GET' ? route.fulfill({ json: offers }) : route.continue()));
  await page.route('**/api/v1/wishlist/*/alert', route =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: { rule: { mode: 'target', basis: 'base', target_cents: 2500, enabled: true }, configured: true } })
      : route.continue(),
  );
}

/** Mocks, signs in, puts Forza Horizon 5 on the wishlist when it is not there yet and returns its id. */
export async function prepareLayout(page: Page): Promise<string> {
  await mockAll(page);
  await signInToFixture(page);
  let rows = await (await page.request.get('/api/v1/wishlist')).json();
  if (!rows.length) {
    await write(page, 'POST', '/api/v1/wishlist', { igdb_id: 1001, platform_id: 169 });
    rows = await (await page.request.get('/api/v1/wishlist')).json();
  }
  expect(rows.length).toBe(1);
  return rows[0].id;
}

/** Removes every wishlist entry (the suite shares one database). */
export async function clearWishlist(page: Page) {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  const response = await page.request.get('/api/v1/wishlist');
  if (!response.ok()) return; // not signed in
  for (const item of await response.json()) await write(page, 'DELETE', `/api/v1/wishlist/${item.id}`);
}

/** Fonts loaded, charts painted. */
export async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}
