import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { navItem, navTo, signInToFixture } from './helpers';
import { openTab } from './detail-helpers';
import { withState } from './offer-state';

/** A write to the API as the page would send it (origin and CSRF token). */
async function write(page: Page, method: 'POST' | 'DELETE', path: string, data?: object) {
  const { csrf_token: csrf } = await (await page.request.get('/api/v1/me')).json();
  return page.request.fetch(path, { method, data, headers: { 'X-CSRF-Token': csrf, Origin: new URL(page.url()).origin } });
}

// The suite shares one database: remove every wishlist and library entry a test leaves behind.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  for (const path of ['/api/v1/wishlist', '/api/v1/library']) {
    for (const item of await (await page.request.get(path)).json()) await write(page, 'DELETE', `/api/v1/wishlist/${item.id}`);
  }
});

const now = () => Math.floor(Date.now() / 1000);
const rawLink = (id: number, region: string, cents: number) => ({
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
  product: { name: 'Forza Horizon 5 Xbox Key', region, market: 'DE', activation: region === 'Global' ? 'confirmed' : 'unknown', availability: 'in_stock' },
  quotes: [{ id: String(id), seller: null, base_cents: cents, estimated_total_cents: null }],
});
const link = (...args: Parameters<typeof rawLink>) => withState(rawLink(...args));
const view = {
  links: [link(1, 'Global', 2890), link(2, 'India', 1290)],
  histories: { preferred: [], all: [] },
  best_base: 2890,
  offer_count: 2,
  best_estimate: null,
  target_country: 'DE',
  searches: [],
  sources: [],
  discovery_running: false,
};

test('an offer from the Angebote tab goes into the cart with its shop and price scope', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInToFixture(page);
  const id = (await (await write(page, 'POST', '/api/v1/wishlist', { igdb_id: 1001, platform_id: 169 })).json()).item.id;
  await page.route('**/api/v1/wishlist/*/offers', route => (route.request().method() === 'GET' ? route.fulfill({ json: view }) : route.continue()));
  const bodies: { method: string; body: unknown }[] = [];
  page.on('request', request => {
    if (/\/api\/v1\/cart(\/|$)/.test(request.url()) && request.method() !== 'GET') bodies.push({ method: request.method(), body: request.postDataJSON() });
  });
  await page.goto(`/?item=${id}&tab=angebote`);
  await openTab(page, 'Angebote');
  const table = page.getByRole('table', { name: 'Angebote nach Preis', exact: true });
  // India is not valid in the target country: any region. Global counts there: the target-country price.
  // Price order: India first, Global second.
  const carts = table.getByRole('button', { name: /^Eneba · .+ in den Warenkorb$/ });
  await expect(carts).toHaveCount(2);
  await carts.nth(0).click();
  await expect(page.getByRole('status').filter({ hasText: 'liegt im Warenkorb: Eneba, Preis INT' })).toBeVisible();
  await expect(navItem(page, 'Warenkorb')).toContainText('1');
  await expect(page.getByRole('button', { name: 'Im Warenkorb', exact: true })).toBeVisible();
  await carts.nth(1).click();
  await expect(page.getByRole('status').filter({ hasText: /liegt im Warenkorb: Eneba, Preis (DE|Zielland)/ })).toBeVisible();
  expect(bodies).toEqual([
    { method: 'POST', body: { wish_id: id, source: 'eneba', scope: 'world' } },
    { method: 'PUT', body: { source: 'eneba', scope: 'home' } },
  ]);
  const [entry] = await (await page.request.get('/api/v1/cart')).json();
  expect([entry.id, entry.source, entry.scope]).toEqual([id, 'eneba', 'home']);
  await expect(navItem(page, 'Warenkorb')).toContainText('1');
});

test('the add dialog searches all systems by default and offers a system once a game for it is in the list', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInToFixture(page);
  await navTo(page, 'Bibliothek');
  const open = () => page.getByRole('banner').getByRole('button', { name: 'Spiel hinzufügen', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Zur Bibliothek hinzufügen', exact: true });
  const system = dialog.getByLabel('Plattform wählen', { exact: true });
  await open();
  await expect(system).toHaveValue('0');
  await expect(system.locator('option')).toHaveText(['Alle']);
  // "Alle": every hit once per system, each with its system.
  await dialog.getByLabel('Spiel im Katalog suchen').fill('forza');
  await expect(dialog.getByRole('status')).toContainText('Treffer für alle Xbox-Systeme');
  await expect(dialog.getByRole('button', { name: 'Forza Horizon 5 (Xbox Series X|S) zur Bibliothek hinzufügen', exact: true })).toBeVisible();
  await expect(dialog.getByRole('listitem').filter({ hasText: 'Xbox One' })).toHaveCount(2);

  // A title without a catalog hit for the Xbox 360.
  await dialog.getByLabel('Spiel im Katalog suchen').fill('kein Katalogspiel 360');
  await dialog.getByLabel('System', { exact: true }).selectOption({ label: 'Xbox 360' });
  await dialog.getByRole('button', { name: 'Ohne Katalog hinzufügen', exact: true }).click();
  await expect(dialog).toBeHidden();
  const [owned] = await (await page.request.get('/api/v1/library')).json();
  expect(owned.platform_id).toBe(12);
  await expect(page.getByRole('list', { name: 'Meine Spiele' })).toContainText('kein Katalogspiel 360');

  // Now the Xbox 360 is a filter of its own; it goes with the last game for it.
  await open();
  await expect(system.locator('option')).toHaveText(['Alle', 'Xbox 360']);
  await expect(system).toHaveValue('0');
  await dialog.getByRole('button', { name: 'Suche schließen', exact: true }).click();
  await page.getByRole('button', { name: 'Bearbeiten entsperren', exact: true }).click();
  await page.getByRole('button', { name: 'kein Katalogspiel 360 aus der Bibliothek entfernen', exact: true }).click();
  await page.getByRole('dialog', { name: 'Aus der Bibliothek entfernen?' }).getByRole('button', { name: 'Entfernen bestätigen', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Noch keine Spiele in der Bibliothek' })).toBeVisible();
  await open();
  await expect(system.locator('option')).toHaveText(['Alle']);
});
