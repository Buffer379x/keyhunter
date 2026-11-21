import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { signInToFixture, navTo } from './helpers';
import { detailsButton, openWishlistRow, removeCurrent, wishlistHeading, wishlistRows, wishlistTable } from './detail-helpers';

// The wishlist page of design v4: KPI tiles from real data only, filter chips, sorting and the game as its own page.
type Item = { id: string; game: { igdb_id: number; name: string } };
const day = 86400;

/** Puts Forza Horizon 5, its Premium Edition and "Neuer Treffer" on the list (through the header search) and returns them. */
async function addThree(page: Page): Promise<Item[]> {
  const search = page.getByRole('searchbox', { name: 'Nach Spielen suchen', exact: true });
  const results = page.getByRole('region', { name: 'Suchergebnisse' });
  for (const [query, name] of [['forza', 'Forza Horizon 5'], ['forza', 'Forza Horizon 5: Premium Edition'], ['neu', 'Neuer Treffer']]) {
    await search.fill(query);
    await results.getByRole('button', { name: `${name} vormerken`, exact: true }).click();
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  }
  return (await page.request.get('/api/v1/wishlist')).json();
}
async function removeAll(page: Page) {
  for (const name of ['Forza Horizon 5', 'Forza Horizon 5: Premium Edition', 'Neuer Treffer']) {
    await navTo(page, 'Wunschliste');
    await openWishlistRow(page, name);
    await removeCurrent(page);
  }
  await expect(page.getByText(/^0 von 100 Plätzen/)).toBeVisible();
}
const kpi = (page: Page, label: string) => page.locator('.kpi').filter({ has: page.locator('.label', { hasText: new RegExp(`^${label}$`) }) });
const chip = (page: Page, name: string) => page.getByRole('group', { name: 'Filter', exact: true }).getByRole('button', { name: new RegExp(`^${name}`) });

test('KPI tiles, filter chips, row details and row → game → back keep filter, sort and scroll', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await signInToFixture(page);
  const items = await addThree(page);
  const now = Math.floor(Date.now() / 1000);
  // "Alarm gesendet" means sent today (local day): ten minutes ago, but never before midnight, so the test also passes at 00:05.
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const sentAt = Math.max(now - 590, Math.floor(midnight.getTime() / 1000) + 1);
  const byName = (name: string) => items.find(item => item.game.name === name)!;
  const forza = byName('Forza Horizon 5'), premium = byName('Forza Horizon 5: Premium Edition'), fresh = byName('Neuer Treffer');
  const trend = (yesterday: number, today: number) => [...Array(12).fill(3200), yesterday, today];
  const badges = {
    // 28,90 € in the target country, India 12,90 € (−55 %), reached the target of 29,00 € only today.
    [forza.id]: { state: 'price', cents: 2890, observed_at: now - 3600, checked_at: now - 3600, stale: false, pending: false, world: { cents: 1290, region: 'India', observed_at: now - 3600 }, trend: trend(3100, 2890) },
    // 40,00 €, the cheapest region only 5 % below, a stale price, no trend from this (older) server.
    [premium.id]: { state: 'price', cents: 4000, observed_at: now - 3 * day, checked_at: now - 3600, stale: true, pending: false, world: { cents: 3800, region: 'Turkey', observed_at: now - 3600 } },
    [fresh.id]: { state: 'no_offer', cents: null, observed_at: null, checked_at: now - 3600, stale: false, pending: false, world: null, trend: Array(14).fill(null) },
  };
  await page.route(/\/api\/v1\/wishlist\/price-badges(?:\?.*)?$/, route => route.fulfill({ json: badges }));
  await page.route('**/api/v1/alerts', route => route.request().method() === 'GET' ? route.fulfill({ json: { configured: true,
    rules: [{ wish_id: forza.id, mode: 'target', basis: 'base', target_cents: 2900, enabled: true }, { wish_id: premium.id, mode: 'target', basis: 'base', target_cents: 3500, enabled: true }],
    events: [{ id: 1, wish_id: forza.id, state: 'sent', observed_at: sentAt - 10, sent_at: sentAt, cents: 2890, attempts: 1 }] } }) : route.continue());
  const hours = Array.from({ length: 24 }, (_, hour) => hour < 2 ? 10 : 0);
  await page.route('**/api/v1/status/fetch', route => route.fulfill({ json: { errors_24h: 0, recent_runs: [], shops: [
    { source: 'eneba', enabled: true, last_success_at: now, last_error: null, paused_until: null, budget: { used: 300, limit: 400, demand_per_day: 450, by_hour: hours }, backlog: { due: 0, requested: 0, products: 0, searches: 0 }, oldest_due_at: null, next_due_at: null, worker_seen_at: now },
    { source: 'driffle', enabled: true, last_success_at: now, last_error: null, paused_until: null, budget: { used: 12, limit: 100 }, backlog: { due: 0, requested: 0, products: 0, searches: 0 }, oldest_due_at: null, next_due_at: null, worker_seen_at: now },
  ] } }));
  // The game view reports the real (unpriced) badges of the fixture; keep the mocked ones so the list does not change meanwhile.
  await page.route('**/api/v1/wishlist/*/offers', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const { price_badge: _badge, ...data } = await (await route.fetch()).json();
    await route.fulfill({ json: data });
  });
  const targets: Record<string, number> = { [forza.id]: 2900, [premium.id]: 3500 };
  await page.route('**/api/v1/wishlist/*/alert', route => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2)!;
    if (route.request().method() !== 'GET') return route.continue();
    return route.fulfill({ json: { configured: true, rule: targets[id] ? { mode: 'target', basis: 'base', target_cents: targets[id], enabled: true } : null } });
  });
  await page.route('**/api/v1/wishlist/*/editions', async route => {
    const data = await (await route.fetch()).json();
    await route.fulfill({ json: { ...data, items: data.items.map(({ price_badge: _badge, ...item }: Record<string, unknown>) => item) } });
  });
  await navTo(page, 'Wunschliste');
  await page.reload(); // alarm rules and the fetch status are read when the page loads
  await expect(page).not.toHaveURL(/item=/);
  await expect(page.locator('.page-head p')).toHaveText(/^3 von 100 Plätzen · Zielland .+ · Preise verglichen mit allen Regionen$/);

  // KPI tiles
  await expect(kpi(page, 'Wünsche').locator('.kpi-val')).toHaveText('3Spiele');
  await expect(kpi(page, 'Wünsche').locator('.kpi-foot')).toHaveText('2 mit Preis1 offen');
  await expect(kpi(page, 'Ziel erreicht').locator('.kpi-val')).toHaveText('1Spiele');
  await expect(kpi(page, 'Ziel erreicht').locator('.kpi-foot')).toHaveText('+1 seit gesternAlarm gesendet');
  await expect(kpi(page, 'Ziel erreicht').locator('.ticks i')).toHaveCount(9);
  await expect(kpi(page, 'Weltweit günstiger').locator('.kpi-val')).toHaveText('1ab 20 %');
  await expect(kpi(page, 'Weltweit günstiger').locator('.kpi-foot')).toHaveText('bis−16,00 € · Forza Horizon');
  await expect(kpi(page, 'Abrufe heute').locator('.kpi-val')).toHaveText('312/ 500');
  await expect(kpi(page, 'Abrufe heute').locator('.kpi-foot')).toHaveText('Bedarf ≈ 450 pro Tagreicht');

  // Rows: price, cheapest region, saving, target, status pills (hints included), sparkline
  const row = (item: Item) => wishlistTable(page).locator(`tbody tr[data-id="${item.id}"]`);
  await expect(row(forza).locator('.c-de')).toContainText('28,90 €');
  await expect(row(forza).locator('.c-world')).toHaveText('12,90 €');
  await expect(row(forza).locator('.c-world .reg.flag img')).toBeVisible();
  await expect(row(forza).locator('.c-world .reg')).toHaveAttribute('aria-label', 'Indien');
  await expect(row(forza).locator('.c-save .save.big')).toHaveText('−16,00 €');
  await expect(row(forza).locator('.c-save')).toContainText('−55 %');
  await expect(row(forza).locator('.c-target')).toHaveText('29,00 €');
  await expect(row(forza).locator('.c-status')).toHaveText('Ziel erreicht');
  await expect(row(forza).locator('.spark i')).toHaveCount(14);
  await expect(row(forza).locator('.spark i.last')).toHaveCount(1);
  await expect(row(premium).locator('.c-save .save')).not.toHaveClass(/big/);
  await expect(row(premium).locator('.c-world')).toHaveText('38,00 €');
  await expect(row(premium).locator('.c-world .reg.flag img')).toBeVisible();
  await expect(row(premium).locator('.c-world .reg')).toHaveAttribute('aria-label', 'Türkei');
  await expect(row(premium).locator('.c-status')).toContainText('5,00 € über Ziel');
  await expect(row(premium).locator('.c-status')).toContainText('Veraltet');
  await expect(row(premium).locator('.spark')).toHaveCount(0);
  await expect(row(fresh).locator('.c-world')).toHaveText('In keinem Shop gefunden');
  await expect(row(fresh).locator('.c-status')).toHaveText('Kein Angebot');
  await expect(row(fresh).locator('.c-target')).toHaveText('–');

  // Filter chips with counts
  await expect(chip(page, 'Alle')).toHaveText('Alle3');
  await expect(chip(page, 'Ziel erreicht')).toHaveText('Ziel erreicht1');
  await expect(chip(page, 'Weltweit günstiger')).toHaveText('Weltweit günstiger1');
  await expect(chip(page, 'Ohne Preis')).toHaveText('Ohne Preis1');
  await chip(page, 'Ohne Preis').click();
  await expect(chip(page, 'Ohne Preis')).toHaveAttribute('aria-pressed', 'true');
  await expect(wishlistRows(page)).toHaveCount(1);
  await expect(wishlistRows(page)).toContainText('Neuer Treffer');
  await chip(page, 'Weltweit günstiger').click();
  await expect(wishlistRows(page)).toHaveCount(1);
  await expect(wishlistRows(page)).toContainText('Forza Horizon 5');
  await chip(page, 'Ziel erreicht').click();
  await page.getByLabel('Liste filtern').fill('Neuer');
  await expect(page.getByText('Kein Spiel passt zu diesem Filter.')).toBeVisible();
  await chip(page, 'Alle').click();
  await expect(wishlistRows(page)).toHaveCount(1);

  // Row → game → back: filter, sort and scroll position are kept, the row gets the focus again
  await page.getByLabel('Liste filtern').fill('Forza');
  const priceHeader = wishlistTable(page).locator('thead').getByRole('button', { name: /^Preis [A-Z]{2}$/ });
  await priceHeader.click();
  await expect(wishlistRows(page)).toHaveCount(2);
  await expect(wishlistRows(page).first()).toContainText('Forza Horizon 5');
  // At 1024 px the table scrolls inside its panel; nothing (not even screen-reader labels) widens the page
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 390, height: 640 });
  // Cards; the headers stay as a row of sort buttons above them, the price column is still the sorted one
  await expect(wishlistTable(page).locator('thead')).toBeVisible();
  await expect(wishlistTable(page).locator('thead').getByRole('button')).toHaveCount(6);
  await expect(wishlistTable(page).locator('thead th[aria-sort="ascending"]')).toHaveText(/^Preis [A-Z]{2}/);
  await expect(row(forza).locator('.c-save')).toBeHidden();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const main = page.locator('#main-content');
  await main.evaluate(element => element.scrollTo(0, element.scrollHeight));
  await detailsButton(row(premium)).focus();
  const scrolled = await main.evaluate(element => element.scrollTop);
  expect(scrolled).toBeGreaterThan(100);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Forza Horizon 5: Premium Edition', exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`[?&]item=${premium.id}`));
  await expect(wishlistTable(page)).toHaveCount(0); // no split view: the game replaces the list
  expect(await main.evaluate(element => element.scrollTop)).toBe(0);
  await page.goBack();
  await expect(wishlistTable(page)).toBeVisible();
  await expect(page).not.toHaveURL(/item=/);
  await expect(page.getByLabel('Liste filtern')).toHaveValue('Forza');
  await expect(wishlistTable(page).locator('thead th[aria-sort="ascending"]')).toHaveText(/^Preis [A-Z]{2}/);
  await expect.poll(() => main.evaluate(element => element.scrollTop)).toBe(scrolled);
  await expect(detailsButton(row(premium))).toBeFocused();

  // A click on the row itself opens nothing; the details button does, and the breadcrumb leads back the same way.
  await page.setViewportSize({ width: 1280, height: 720 });
  await row(forza).locator('.c-de').click();
  await expect(wishlistTable(page)).toBeVisible();
  await expect(page).not.toHaveURL(/item=/);
  await detailsButton(row(forza)).click();
  const crumbs = page.getByRole('navigation', { name: 'Pfad' });
  await expect(crumbs).toHaveText(/Wunschliste.*Forza Horizon 5/);
  await crumbs.getByRole('button', { name: 'Wunschliste', exact: true }).click();
  await expect(page.getByLabel('Liste filtern')).toHaveValue('Forza');
  await expect(detailsButton(row(forza))).toBeFocused();
  // The sidebar entry always shows the list, also from a game.
  await detailsButton(row(forza)).click();
  await navTo(page, 'Wunschliste');
  await expect(wishlistTable(page)).toBeVisible();
  await page.getByLabel('Liste filtern').fill('');
  await priceHeader.click(); await priceHeader.click(); // descending, then back to newest first
  await expect(wishlistTable(page).locator('thead th[aria-sort="none"]')).toHaveCount(6);
  await removeAll(page);
  await expect(wishlistHeading(page)).toBeFocused();
  expect(errors).toEqual([]);
});

test('KPI tiles leave out what an older server or a failed read does not provide', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await signInToFixture(page);
  const items = await addThree(page);
  const now = Math.floor(Date.now() / 1000);
  // 0.6.0 badges: no trend, no world price; no alarm rules; the fetch status cannot be read.
  await page.route(/\/api\/v1\/wishlist\/price-badges(?:\?.*)?$/, route => route.fulfill({ json: Object.fromEntries(items.map(item =>
    [item.id, { state: 'price', cents: 1999, observed_at: now, checked_at: now, stale: false, pending: false }])) }));
  await page.route('**/api/v1/alerts', route => route.request().method() === 'GET' ? route.fulfill({ json: { configured: false, rules: [], events: [] } }) : route.continue());
  await page.route('**/api/v1/status/fetch', route => route.fulfill({ status: 500, json: { error: 'Test' } }));
  await navTo(page, 'Wunschliste');
  await page.reload();
  await expect(wishlistRows(page)).toHaveCount(3);
  await expect(kpi(page, 'Wünsche').locator('.kpi-val')).toHaveText('3Spiele');
  await expect(kpi(page, 'Wünsche').locator('.ticks')).toHaveCount(1); // added today: one cumulative bar
  await expect(kpi(page, 'Ziel erreicht').locator('.kpi-val')).toHaveText('0Spiele');
  await expect(kpi(page, 'Ziel erreicht').locator('.ticks')).toHaveCount(0);
  await expect(kpi(page, 'Ziel erreicht').locator('.kpi-foot')).toHaveText(/^\s*$/); // an empty row keeps the tiles level
  await expect(kpi(page, 'Weltweit günstiger').locator('.kpi-val')).toHaveText('0ab 20 %');
  await expect(kpi(page, 'Weltweit günstiger').locator('.kpi-foot')).toHaveText(/^\s*$/); // an empty row keeps the tiles level
  await expect(kpi(page, 'Abrufe heute').locator('.kpi-val')).toHaveText('–');
  await expect(kpi(page, 'Abrufe heute').locator('.kpi-foot')).toHaveText(/^\s*$/); // an empty row keeps the tiles level
  await expect(wishlistTable(page).locator('.spark')).toHaveCount(0);
  await expect(wishlistRows(page).first().locator('.c-world')).toHaveText('–');
  await expect(wishlistRows(page).first().locator('.c-target')).toHaveText('–');
  await removeAll(page);
  expect(errors).toEqual([]);
});
