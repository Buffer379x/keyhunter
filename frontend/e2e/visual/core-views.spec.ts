import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { signInToFixture } from '../helpers';

// Visual regression of the seven core views at three viewports. Run only through deploy/visual-check.sh.
// Determinism: fixed clock, all price data mocked (the fixture has no shop prices), animations and caret off.

const NOW_MS = Date.UTC(2026, 10, 20, 12, 0, 0); // fixed "now" for page.clock and for every mocked timestamp
const now = NOW_MS / 1000, H = 3600, D = 86400;

const link = (id: number, source: string, region: string, cents: number, reasons: string[], extra = {}) => ({
  id, source, url: 'https://www.eneba.com/de/xbox-fixture-key-global', review: 'confirmed', can_confirm: true, eligible: reasons.length === 0,
  queued: false, enabled: true, stale: false, observed_at: now - 2 * H, attempted_at: now - 2 * H, last_error: null, retry_at: 0, reasons,
  product: { name: `Forza Horizon 5 ${region} Key`, region, market: 'DE', activation: reasons.includes('activation_blocked') ? 'blocked' : reasons.length ? 'unknown' : 'confirmed', availability: reasons.includes('sold_out') ? 'sold_out' : 'in_stock' },
  quotes: reasons.includes('sold_out') ? [] : [{ id: String(id), seller: id === 2 ? 'Zero Zero' : null, base_cents: cents, estimated_total_cents: region === 'Argentina' ? null : Math.round(cents * 1.02) }],
  ...extra,
});
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
  history: [], best_base: 2890, best_estimate: 2948, last_known: null, target_country: 'DE',
  searches: [{ source: 'eneba', status: 'complete', checked_at: now - 2 * H, result_count: 3, last_error: null }], sources: [], discovery_running: false,
};
const badge = { state: 'price', cents: 2890, observed_at: now - 2 * H, checked_at: now - 2 * H, stale: false, pending: false, source: 'eneba', region: 'Global', world: { cents: 1290, source: 'eneba', region: 'India', observed_at: now - 2 * H },
  trend: [3499, 3499, 3299, 3299, 3299, 3299, 3299, 3099, 3099, 3099, 3099, 3099, 3099, 2890] };
const fetchStatus = {
  shops: [
    { source: 'eneba', enabled: true, last_success_at: now - 60, last_error: null, paused_until: null, budget: { used: 64, limit: 500, limit_source: 'setting', demand_per_day: 430, pace_seconds: 170, next_at: now + 170, by_hour: [3, 4, 3, 2, 3, 4, 5, 4, 5, 6, 6, 5, 14, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }, backlog: { due: 14, requested: 3, products: 9, searches: 5 }, oldest_due_at: now - 1500, next_due_at: now + 900, worker_seen_at: now - 2 },
    { source: 'driffle', enabled: true, last_success_at: now - 7200, last_error: 'rate_limited', paused_until: now + 2400, budget: { used: 41, limit: 120, limit_source: 'env', demand_per_day: 160, pace_seconds: 540, next_at: now + 2400, by_hour: [2, 2, 3, 3, 3, 4, 3, 4, 4, 5, 4, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }, backlog: { due: 6, requested: 0, products: 4, searches: 2 }, oldest_due_at: now - 5400, next_due_at: now + 3200, worker_seen_at: now - 1 },
  ],
  errors_24h: 5,
  recent_runs: [
    { source: 'eneba', kind: 'product', wish_id: null, link_id: 1, started_at: now - 40, duration_ms: 1180, outcome: 'ok', detail: 'Forza Horizon 5' },
    { source: 'driffle', kind: 'search', wish_id: null, link_id: null, started_at: now - 300, duration_ms: 210, outcome: 'rate_limited', detail: null },
    { source: 'eneba', kind: 'discovery', wish_id: null, link_id: null, started_at: now - 900, duration_ms: 8300, outcome: 'ok', detail: null },
  ],
};

async function freeze(page: Page) {
  await page.clock.install({ time: NOW_MS });
  await page.clock.setFixedTime(NOW_MS); // Date.now() never advances, timers keep running: "vor 2 Std.", "Stand 12:00:00" and chart windows stay put
}

async function mockPrices(page: Page) {
  const ids: string[] = [];
  await page.route('**/api/v1/wishlist/*/offers', r => r.request().method() === 'GET' ? r.fulfill({ json: offers }) : r.continue());
  await page.route(/\/api\/v1\/wishlist\/price-badges(\?.*)?$/, r => r.fulfill({ json: Object.fromEntries(ids.map(id => [id, badge])) }));
  await page.route('**/api/v1/wishlist', async r => {
    if (r.request().method() !== 'GET') return r.continue();
    const rows = await (await r.fetch()).json();
    ids.splice(0, ids.length, ...rows.map((x: { id: string }) => x.id));
    await r.fulfill({ json: rows.map((x: object) => ({ ...x, price_badge: badge })) });
  });
  await page.route('**/api/v1/wishlist/*/alert', r => r.request().method() === 'GET' ? r.fulfill({ json: { rule: { mode: 'target', basis: 'base', target_cents: 2900, enabled: true }, configured: true } }) : r.continue());
  await page.route('**/api/v1/alerts', r => r.request().method() === 'GET' ? r.fulfill({ json: { configured: true, rules: [], events: [] } }) : r.continue());
  await page.route('**/api/v1/status/fetch', r => r.fulfill({ json: fetchStatus }));
}

/** Signs in, makes sure exactly Forza Horizon 5 is on the wishlist and returns its id. */
async function prepare(page: Page): Promise<string> {
  await freeze(page);
  await mockPrices(page);
  await signInToFixture(page);
  let rows = await (await page.request.get('/api/v1/wishlist')).json();
  if (!rows.length) {
    await page.getByRole('searchbox', { name: 'Nach Spielen suchen', exact: true }).fill('forza');
    await page.getByRole('region', { name: 'Suchergebnisse' }).getByRole('button', { name: 'Forza Horizon 5 vormerken', exact: true }).click();
    await expect(page).toHaveURL(/[?&]item=/);
    rows = await (await page.request.get('/api/v1/wishlist')).json();
  }
  return rows[0].id;
}

// Volatile: the app version in the sidebar changes with every release.
const masks = (page: Page) => [page.locator('.version')];

async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300); // charts and lazy rows finish painting
}

const viewports = [{ name: '1440', width: 1440, height: 900 }, { name: '1024', width: 1024, height: 768 }, { name: '390', width: 390, height: 844 }];

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

    const detail = (tab: string, file: string) => test(`wishlist ${tab || 'preis'}`, async ({ page }) => {
      const id = await prepare(page);
      await page.goto(`/?item=${id}${tab ? `&tab=${tab}` : ''}`);
      await page.getByRole('tablist', { name: 'Spieldetails' }).waitFor();
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

    const settings = (section: string, file: string, tabName: string, ready = '') => test(`settings ${file}`, async ({ page }) => {
      await prepare(page);
      await page.goto(`/?view=settings${section ? `&section=${section}` : ''}`);
      await expect(page.getByRole('main').getByRole('heading', { name: tabName, level: 1 })).toBeVisible();
      if (ready) await expect(page.getByText(ready).first()).toBeVisible();
      await settle(page);
      await expect(page).toHaveScreenshot(`${file}-${vp.name}.png`, { mask: masks(page) });
    });
    settings('', 'settings-allgemein', 'Allgemein');
    settings('status', 'settings-abrufstatus', 'Abrufstatus', 'Letzte Abrufe');
  });
}
