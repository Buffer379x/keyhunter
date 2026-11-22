import { test, expect } from '@playwright/test';
import { signInToFixture, navTo } from './helpers';
import { editionSelect, openTab, openWishlistRow, removeCurrent, wishlistRows } from './detail-helpers';
import { withState } from './offer-state';

test('saved prices appear on the first list response and edition tags are prepared before switching', async ({ page }) => {
  await signInToFixture(page);
  await page.getByRole('searchbox', { name: 'Nach Spielen suchen', exact: true }).fill('forza');
  await page.getByRole('region', { name: 'Suchergebnisse' }).getByRole('button', { name: 'Forza Horizon 5 (Xbox Series X|S) vormerken', exact: true }).click();
  await expect(page).toHaveURL(/[?&]item=/);
  const rows = await (await page.request.get('/api/v1/wishlist')).json();
  const badge = { state: 'price', cents: 1234, observed_at: 1795107000, checked_at: 1795107000, stale: true, pending: false };
  await page.route('**/api/v1/wishlist', route =>
    route.request().method() === 'GET' ? route.fulfill({ json: rows.map((item: object) => ({ ...item, price_badge: badge })) }) : route.continue(),
  );
  // A slow follow-up read must not replace an already known price by Unknown.
  await page.route(/\/api\/v1\/wishlist\/price-badges(?:\?.*)?$/, async route => {
    await new Promise(resolve => setTimeout(resolve, 500));
    await route.fulfill({ json: Object.fromEntries(rows.map((item: { id: string }) => [item.id, badge])) });
  });
  await page.route('**/api/v1/wishlist/*/editions', async route => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({
      json: {
        ...data,
        items: data.items.map((item: { game?: { kind: string } }) => ({
          ...item,
          price_badge: { ...badge, cents: item.game?.kind === 'edition' ? 2000 : 1234 },
        })),
      },
    });
  });
  await navTo(page, 'Wunschliste');
  await page.reload();
  await expect(wishlistRows(page).first().locator('.c-de')).toContainText('12,34');
  await expect(wishlistRows(page).first().locator('.c-status')).toContainText('Veraltet');
  await page.waitForTimeout(600);
  await expect(wishlistRows(page).first().locator('.c-de')).toContainText('12,34');
  await openWishlistRow(page, 'Forza Horizon 5');
  // The Editionen tab lists both editions with their saved prices before the owner switches.
  await openTab(page, 'Editionen');
  const editions = page.locator('.ed-row');
  await expect(editions).toHaveCount(2);
  await expect(editions.filter({ hasText: 'Standard Edition' })).toContainText('12,34');
  await expect(editions.filter({ hasText: 'Standard Edition' })).toContainText('gemerkt');
  const premium = editions.filter({ hasText: 'Premium Edition' });
  await expect(premium).toContainText('20,00');
  await page.getByRole('button', { name: 'Premium Edition ansehen', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Forza Horizon 5: Premium Edition', level: 1, exact: true })).toBeVisible();
  await expect(editionSelect(page).locator('option:checked')).toHaveText('Premium Edition · Vorschau');
  await expect(premium).toContainText('Vorschau · wird angezeigt');
  expect(await (await page.request.get('/api/v1/wishlist')).json()).toHaveLength(1);
  await page.setViewportSize({ width: 320, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole('button', { name: 'Zur gemerkten Edition', exact: true }).click();
  await removeCurrent(page);
});

test('library exposes system filters and alphabet (default) or acquisition sorting without touching saved games', async ({ page }) => {
  await signInToFixture(page);
  const data = [
    { id: 'a', game_id: 'a', platform_id: 169, created_at: 500, acquired_at: 40, game: null, manual_title: 'Zelda', verification: 'manual_unverified' },
    { id: 'b', game_id: 'b', platform_id: 49, created_at: 1, acquired_at: 30, game: null, manual_title: 'Älterer Titel', verification: 'manual_unverified' },
    { id: 'c', game_id: 'c', platform_id: 169, created_at: 300, acquired_at: 20, game: null, manual_title: 'Forza', verification: 'manual_unverified' },
  ];
  await page.route('**/api/v1/library', route => route.fulfill({ json: data }));
  await navTo(page, 'Bibliothek');
  const list = page.getByRole('list', { name: 'Meine Spiele' });
  const sort = page.getByRole('radiogroup', { name: 'Bibliothek sortieren', exact: true });
  // 0.6.5: A–Z is the default and the first option.
  await expect(sort.getByRole('radio')).toHaveText(['A–Z', 'Zuletzt gekauft']);
  await expect(sort.getByRole('radio', { name: 'A–Z', exact: true })).toBeChecked();
  await expect(list.locator('.lib-info b')).toHaveText(['Älterer Titel', 'Forza', 'Zelda']);
  await sort.getByRole('radio', { name: 'Zuletzt gekauft', exact: true }).click();
  await expect(list.locator('.lib-info b')).toHaveText(['Zelda', 'Älterer Titel', 'Forza']);
  await page.getByLabel('Bibliothek nach System filtern', { exact: true }).selectOption('169');
  await expect(list.locator('.lib-info b')).toHaveText(['Zelda', 'Forza']);
  await page.reload();
  await expect(page.getByLabel('Bibliothek nach System filtern', { exact: true })).toHaveValue('169');
  await expect(sort.getByRole('radio', { name: 'Zuletzt gekauft', exact: true })).toBeChecked();
  await sort.getByRole('radio', { name: 'A–Z', exact: true }).click();
  await expect(list.locator('.lib-info b')).toHaveText(['Forza', 'Zelda']);
  await page.setViewportSize({ width: 320, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('offers are ordered by price and the cheapest region is compared with the target country', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInToFixture(page);
  await page.getByRole('searchbox', { name: 'Nach Spielen suchen', exact: true }).fill('forza');
  await page.getByRole('region', { name: 'Suchergebnisse' }).getByRole('button', { name: 'Forza Horizon 5 (Xbox Series X|S) vormerken', exact: true }).click();
  await expect(page).toHaveURL(/[?&]item=/);
  const rawLink = (id: number, region: string, cents: number) => ({
    id,
    source: 'eneba',
    url: 'https://www.eneba.com/de/xbox-fixture-key-global',
    review: 'confirmed',
    can_confirm: true,
    eligible: region === 'DE',
    queued: false,
    enabled: true,
    stale: false,
    observed_at: Math.floor(Date.now() / 1000) - 3600,
    attempted_at: 1795107000,
    last_error: null,
    retry_at: 0,
    reasons: region === 'DE' ? [] : ['activation_unknown', 'purchase_context_mismatch'],
    product: { name: 'Synthetic', region, market: 'DE', activation: region === 'DE' ? 'confirmed' : 'unknown', availability: 'in_stock' },
    quotes: [{ id: String(id), seller: null, base_cents: cents, estimated_total_cents: region === 'India' ? null : cents + 100 }],
  });
  const link = (...args: Parameters<typeof rawLink>) => withState(rawLink(...args));
  await page.route('**/api/v1/wishlist/*/offers', route =>
    route.request().method() === 'GET'
      ? route.fulfill({
          json: {
            links: [link(1, 'DE', 3000), link(2, 'USA', 1000), link(3, 'India', 500)],
            histories: { preferred: [], all: [] },
            best_base: 3000,
            offer_count: 3,
            best_estimate: 3100,
            target_country: 'DE',
            searches: [],
            sources: [],
            discovery_running: false,
          },
        })
      : route.continue(),
  );
  await page.reload();
  // The Preis tab always shows the target country next to the cheapest region, with the difference and the verdict.
  const compare = page.getByRole('group', { name: 'Preisvergleich', exact: true });
  await expect(compare.locator('.compare-side.home')).toContainText('30,00');
  await expect(compare.locator('.compare-side.world')).toContainText('5,00');
  await expect(compare.locator('.compare-side.world')).toContainText('Indien');
  await expect(compare.locator('.compare-side.world .reg')).toHaveAttribute('aria-label', 'Indien');
  await expect(compare.locator('.compare-side.world')).toContainText('Aktivierung in DE ungeklärt');
  await expect(compare.locator('.delta')).toContainText('−25,00');
  await expect(compare.locator('.delta')).toContainText('−83 %');
  await expect(page.locator('.verdict p')).toContainText(/Indien spart 25,00\s€ \(83 %\)\./);
  await expect(page.locator('.verdict p')).toContainText('meist braucht es eine Regionsumstellung im Konto. Der Unterschied ist groß.');
  await expect(page.getByRole('link', { name: /^Angebot DE öffnen/ })).toHaveAttribute('target', '_blank');
  await expect(page.getByRole('link', { name: /^Angebot Indien/ })).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(page.locator('#why-list')).toContainText('Indien ist günstiger, Aktivierung in DE ungeklärt');
  await expect(page.locator('#why-list')).toContainText('Vereinigte Staaten ist günstiger');
  // The offer table: the cheapest region comes first wherever it is, and says why it does not count for DE.
  await openTab(page, 'Angebote');
  const rows = page.getByRole('table', { name: 'Angebote nach Preis' }).locator('tbody tr');
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText('Indien');
  await expect(rows.first()).toContainText('Aktivierung in DE ungeklärt');
  await expect(rows.first()).toContainText('Anderer Kaufkontext');
  await expect(rows.nth(1)).toContainText('Vereinigte Staaten');
  await expect(rows.last()).toContainText('Deutschland');
  await expect(rows.last()).toContainText('in DE aktivierbar');
  // The "only valid" filter is off by default and, once on, can be undone from the strip that names the hidden offers.
  await expect(page.getByRole('switch', { name: 'Nur in DE aktivierbar' })).not.toBeChecked();
  await page.getByRole('switch', { name: 'Nur in DE aktivierbar' }).click();
  await expect(rows).toHaveCount(1);
  await expect(page.locator('.panel-head .count')).toHaveText('1 von 3');
  await expect(rows.first().locator('.price')).toHaveClass(/hot/);
  await expect(page.getByRole('button', { name: /2 Angebote in DE nicht aktivierbar.*Indien/ })).toBeVisible();
  await page.getByRole('button', { name: /2 Angebote in DE nicht aktivierbar/ }).click();
  await expect(rows).toHaveCount(3);
  // Estimated totals: India has no fee estimate and moves to the end.
  await page.getByRole('radio', { name: 'Gesamtpreis geschätzt' }).click();
  await expect(rows.first()).toContainText('Vereinigte Staaten');
  await expect(rows.nth(1)).toContainText('Deutschland');
  await expect(rows.last()).toContainText('Indien');
  await openTab(page, 'Preis');
  await expect(compare.locator('.compare-side.home')).toContainText('31,00');
  await expect(compare.locator('.compare-side.world')).toContainText('11,00');
  await removeCurrent(page);
});
