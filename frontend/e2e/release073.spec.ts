import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { signInToFixture } from './helpers';
import { openTab, wishlistRows } from './detail-helpers';

const now = () => Math.floor(Date.now() / 1000);
const link = (id: number, name: string, extra: object = {}) => ({
  id, source: 'eneba', url: `https://www.eneba.com/de/xbox-${id}-key`, review: 'confirmed', can_confirm: true,
  eligible: true, queued: false, enabled: true, stale: false, observed_at: now() - 3600, attempted_at: now() - 3600, last_error: null, retry_at: 0, reasons: [],
  product: { name, region: 'Global', market: 'DE', activation: 'confirmed', availability: 'in_stock' },
  quotes: [{ id: String(id), seller: null, base_cents: 2890, estimated_total_cents: null }], ...extra,
});
const view = (links: object[]) => ({ links, histories: { preferred: [], all: [] }, history: [], best_base: 2890, best_estimate: null, target_country: 'DE', searches: [], sources: [], discovery_running: false });

async function addForza(page: Page) {
  await signInToFixture(page);
  await page.getByRole('searchbox', { name: 'Nach Spielen suchen', exact: true }).fill('forza');
  await page.getByRole('region', { name: 'Suchergebnisse' }).getByRole('button', { name: 'Forza Horizon 5 vormerken', exact: true }).click();
  await expect(page).toHaveURL(/[?&]item=/);
  return new URL(page.url()).searchParams.get('item')!;
}

// The suite shares one database: remove every wishlist entry a test leaves behind.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  const { csrf_token: csrf } = await (await page.request.get('/api/v1/me')).json();
  const origin = new URL(page.url()).origin;
  for (const item of await (await page.request.get('/api/v1/wishlist')).json()) {
    await page.request.delete(`/api/v1/wishlist/${item.id}`, { headers: { 'X-CSRF-Token': csrf, Origin: origin } });
  }
});

test('a completely wrong product mapping can be deleted after a confirmation, active or set aside', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await addForza(page);
  const right = link(1, 'Forza Horizon 5 Xbox Key GLOBAL');
  const wrong = link(7, 'Forza Motorsport 7 Xbox Key GLOBAL', { review: 'rejected' });
  let deleted = false;
  const methods: string[] = [];
  await page.route('**/api/v1/wishlist/*/offers', route => route.request().method() === 'GET'
    ? route.fulfill({ json: view(deleted ? [right] : [right, wrong]) }) : route.continue());
  await page.route('**/api/v1/wishlist/*/offers/7', async route => {
    methods.push(route.request().method());
    deleted = true;
    await route.fulfill({ status: 204, body: '' });
  });
  await page.reload();
  await openTab(page, 'Infos');
  // Both the active mapping and the one set aside ("Verworfen") can be deleted.
  await expect(page.getByRole('button', { name: 'Zuordnung Forza Horizon 5 Xbox Key GLOBAL löschen', exact: true })).toBeVisible();
  const setAside = page.locator('.match').filter({ hasText: 'Forza Motorsport 7' });
  await expect(setAside).toContainText('Verworfen');
  await setAside.getByRole('button', { name: 'Zuordnung Forza Motorsport 7 Xbox Key GLOBAL löschen', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Zuordnung löschen?', exact: true });
  await expect(dialog).toContainText('mit allen gespeicherten Preisen');
  await expect(dialog).toContainText('nicht mehr vor');
  // Cancel sends nothing.
  await dialog.getByRole('button', { name: 'Abbrechen', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(methods).toEqual([]);
  await setAside.getByRole('button', { name: /löschen$/ }).click();
  await dialog.getByRole('button', { name: 'Löschen bestätigen', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(methods).toEqual(['DELETE']);
  await expect(page.locator('.match').filter({ hasText: 'Forza Motorsport 7' })).toHaveCount(0);
  await expect(page.locator('.match').filter({ hasText: 'Forza Horizon 5 Xbox Key' })).toBeVisible();
});

test('the wishlist shows prices without or with fees; without, the title of a price names the estimate', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const id = await addForza(page);
  const t = now() - 3600;
  const badge = {
    state: 'price', cents: 2890, source: 'eneba', region: 'Global', observed_at: t, checked_at: t, stale: false, pending: false, estimate_cents: 3147,
    world: { cents: 1290, base_cents: 1290, estimate_cents: 1405, source: 'eneba', region: 'India', observed_at: t },
    with_fees: { cents: 3100, base_cents: 3000, observed_at: t, stale: false, source: 'driffle', region: 'Global', trend: [],
      world: { cents: 1405, base_cents: 1290, estimate_cents: 1405, source: 'eneba', region: 'India', observed_at: t } },
  };
  let fees = true;
  await page.route(/\/api\/v1\/wishlist\/price-badges(?:\?.*)?$/, route => route.fulfill({ json: { [id]: fees ? badge
    : { ...badge, estimate_cents: null, world: { ...badge.world, estimate_cents: null }, with_fees: { ...badge.with_fees, cents: null, base_cents: null, source: null, world: null } } } }));
  await page.goto('/');
  const switcher = page.getByRole('radiogroup', { name: 'Preise', exact: true });
  await expect(switcher.getByRole('radio', { name: 'Ohne Gebühren', exact: true })).toHaveAttribute('aria-checked', 'true');
  const row = wishlistRows(page).first();
  await expect(row.locator('.c-de')).toContainText('28,90');
  await expect(row.locator('.c-de')).toHaveAttribute('title', /^Mit Gebühren geschätzt: 31,47\s€ · Tiefster aktivierbarer Grundpreis/);
  await expect(row.locator('.c-world .world-cell')).toHaveAttribute('title', /Mit Gebühren geschätzt: 14,05\s€$/);

  // With fees: estimated totals, the cheapest total may come from another shop; the title names the base price.
  await switcher.getByRole('radio', { name: 'Mit Gebühren', exact: true }).click();
  await expect(row.locator('.c-de')).toContainText('31,00');
  await expect(row.locator('.c-de .wl-sub')).toHaveText('Driffle');
  await expect(row.locator('.c-de')).toHaveAttribute('title', /^Tiefster aktivierbarer Gesamtpreis mit geschätzten Gebühren .* · Grundpreis 30,00\s€$/);
  await expect(row.locator('.c-world')).toContainText('14,05');
  await expect(row.locator('.c-save')).toContainText('16,95');

  // The choice stays; without any fee estimate the totals are unknown, not the base prices.
  fees = false;
  await page.reload();
  await expect(page.getByRole('radiogroup', { name: 'Preise', exact: true }).getByRole('radio', { name: 'Mit Gebühren', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(row.locator('.c-de')).toContainText('Gebühren unbekannt');
  await expect(row.locator('.c-de')).toHaveAttribute('title', /keine Gebührenschätzung eingestellt/);
  await page.getByRole('radiogroup', { name: 'Preise', exact: true }).getByRole('radio', { name: 'Ohne Gebühren', exact: true }).click();
  await expect(row.locator('.c-de')).toContainText('28,90');
  await expect(row.locator('.c-de')).toHaveAttribute('title', /^Mit Gebühren: unbekannt, für Eneba ist keine Gebührenschätzung eingestellt · /);
});
