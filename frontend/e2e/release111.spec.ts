import { test, expect } from '@playwright/test';
import type { Page, Request } from '@playwright/test';
import { navTo, signInToFixture } from './helpers';
import { clearWishlist } from './layout-mocks';
import { backToList, detailsButton, openTab, openWishlistRow, wishlistHeading, wishlistRows } from './detail-helpers';

// CODE-07: the frontend state moved into api.ts (CSRF, 401), route.ts (URL), useWishDetail and usePolled. These tests pin
// what the refactoring must keep: the requests and their pace, the history steps and the focus, and the sign-in after a 401.

test.afterEach(async ({ page }) => clearWishlist(page));

/** API requests as "GET /wishlist/{id}/offers" (ids and query left out), and a wait until none is in flight. */
function trackApi(page: Page) {
  const seen: string[] = [];
  let open = 0;
  const api = (request: Request) => new URL(request.url()).pathname.startsWith('/api/v1/');
  page.on('request', request => {
    if (!api(request)) return;
    open += 1;
    const path = new URL(request.url()).pathname
      .slice('/api/v1'.length)
      .split('/')
      .map(part => (/\d/.test(part) && part.length >= 8 ? '{id}' : part))
      .join('/');
    seen.push(`${request.method()} ${path}`);
  });
  const done = (request: Request) => {
    if (api(request)) open -= 1;
  };
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  return {
    /** Requests since the last call, counted per method and path. */
    take() {
      const counts: Record<string, number> = {};
      for (const entry of seen.splice(0)) counts[entry] = (counts[entry] ?? 0) + 1;
      return counts;
    },
    async idle() {
      await page.waitForTimeout(150);
      await expect.poll(() => open, { timeout: 10_000 }).toBe(0);
      await page.waitForTimeout(50);
    },
  };
}
type Tracker = ReturnType<typeof trackApi>;

/** Lets `ms` of page time pass in steps of `step`, each followed by the requests it started. */
async function advance(page: Page, tracker: Tracker, ms: number, step: number) {
  for (let passed = 0; passed < ms; passed += step) {
    await page.clock.fastForward(step);
    await tracker.idle();
  }
}

/** Puts Forza Horizon 5 (fixture catalog) on the wishlist and returns its id. */
async function addForza(page: Page) {
  const { csrf_token: csrf } = await (await page.request.get('/api/v1/me')).json();
  const response = await page.request.post('/api/v1/wishlist', {
    data: { igdb_id: 1001, platform_id: 169 },
    headers: { 'X-CSRF-Token': csrf, Origin: new URL(page.url()).origin },
  });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { item: { id: string } }).item.id;
}

test('CODE-07: polling keeps its requests and its pace; fast only while a fetch the owner asked for runs (PERF-02)', async ({ page }) => {
  test.setTimeout(240_000);
  // A badge is "pending" (due checks wait) but only "refreshing" after an action of the owner; the mocks switch that.
  let refreshing = false;
  const badge = (real: Record<string, unknown> | null | undefined) => ({ ...(real ?? {}), pending: true, refreshing });
  await page.route(/\/api\/v1\/wishlist\/price-badges(\?.*)?$/, async route => {
    const response = await route.fetch();
    const rows = (await response.json()) as Record<string, Record<string, unknown>>;
    await route.fulfill({ response, json: Object.fromEntries(Object.entries(rows).map(([id, row]) => [id, badge(row)])) });
  });
  await page.route('**/api/v1/wishlist/*/offers', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const view = await response.json();
    await route.fulfill({ response, json: { ...view, price_badge: badge(view.price_badge) } });
  });
  await page.clock.install();
  await signInToFixture(page);
  await addForza(page);
  const tracker = trackApi(page);
  await page.reload();
  await expect(wishlistHeading(page)).toBeVisible();
  await tracker.idle();
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
  await tracker.idle();
  // Loading the app: one read each; the badges come with the list, so their poll waits a full interval (PERF-06).
  expect(tracker.take(), 'loading').toEqual(
    Object.fromEntries(['/setup', '/me', '/settings', '/sources/status', '/status/fetch', '/alerts', '/wishlist', '/counts'].map(path => [`GET ${path}`, 1])),
  );

  // The list: badges and fetch status once a minute.
  await advance(page, tracker, 300_000, 10_000);
  expect(tracker.take(), 'list, 5 minutes').toEqual({ 'GET /wishlist/price-badges': 5, 'GET /status/fetch': 5 });

  // The game page: what opening reads, then offers, badges and fetch status once a minute.
  await openWishlistRow(page, 'Forza Horizon 5');
  await expect(page.getByRole('heading', { name: 'Forza Horizon 5', level: 1 })).toBeVisible();
  await tracker.idle();
  expect(tracker.take(), 'opening the game').toEqual({
    'GET /wishlist/price-badges': 1,
    'POST /wishlist/{id}/editions': 1,
    'GET /wishlist/{id}/alert': 1,
    'GET /wishlist/{id}/offers': 1,
  });
  await advance(page, tracker, 300_000, 10_000);
  expect(tracker.take(), 'game, 5 minutes').toEqual({ 'GET /wishlist/price-badges': 5, 'GET /wishlist/{id}/offers': 5, 'GET /status/fetch': 5 });

  // The owner asked for a check ("Jetzt prüfen", a new wish): the next read says so, then every 3 s until it is done.
  refreshing = true;
  await advance(page, tracker, 60_000, 10_000);
  expect(tracker.take(), 'until the refresh shows').toEqual({ 'GET /wishlist/price-badges': 1, 'GET /wishlist/{id}/offers': 1, 'GET /status/fetch': 1 });
  await advance(page, tracker, 15_000, 1000);
  expect(tracker.take(), 'while refreshing').toEqual({ 'GET /wishlist/price-badges': 5, 'GET /wishlist/{id}/offers': 5 });
  refreshing = false;
  await advance(page, tracker, 3000, 1000);
  expect(tracker.take(), 'the read that ends it').toEqual({ 'GET /wishlist/price-badges': 1, 'GET /wishlist/{id}/offers': 1 });
  await advance(page, tracker, 120_000, 10_000);
  expect(tracker.take(), 'after the refresh').toEqual({ 'GET /wishlist/price-badges': 2, 'GET /wishlist/{id}/offers': 2, 'GET /status/fetch': 2 });

  // Back to the list: only the badges are read again, then once a minute.
  await page.goBack();
  await expect(wishlistHeading(page)).toBeVisible();
  await tracker.idle();
  expect(tracker.take(), 'back to the list').toEqual({ 'GET /wishlist/price-badges': 1 });
  await advance(page, tracker, 120_000, 10_000);
  expect(tracker.take(), 'list again, 2 minutes').toEqual({ 'GET /wishlist/price-badges': 2, 'GET /status/fetch': 2 });

  // Cart and price alerts: the cart once a minute, the alerts once (no delivery pending).
  await navTo(page, 'Warenkorb');
  await expect(page.getByRole('heading', { name: 'Warenkorb', level: 1 })).toBeVisible();
  await tracker.idle();
  expect(tracker.take(), 'opening the cart').toEqual({ 'GET /cart': 1, 'GET /counts': 1 });
  await advance(page, tracker, 120_000, 10_000);
  expect(tracker.take(), 'cart, 2 minutes').toEqual({ 'GET /cart': 2, 'GET /status/fetch': 2 });
  await navTo(page, 'Preisalarme');
  await expect(page.getByRole('heading', { name: 'Preisalarme', level: 1 })).toBeVisible();
  await tracker.idle();
  expect(tracker.take(), 'opening the alerts').toEqual({ 'GET /alerts': 1, 'GET /wishlist/price-badges': 1, 'GET /wishlist': 1, 'GET /counts': 1 });
  await advance(page, tracker, 120_000, 10_000);
  expect(tracker.take(), 'alerts, 2 minutes').toEqual({ 'GET /status/fetch': 2 });

  // Settings: the log every 30 s; Abrufstatus reads the fetch status and the runs every 30 s, the sidebar shares the status.
  await navTo(page, 'Log');
  await expect(page.getByRole('tab', { name: 'Log', exact: true })).toHaveAttribute('aria-selected', 'true');
  await tracker.idle();
  // The sources once for the settings button and once for the tab.
  expect(tracker.take(), 'opening the log').toEqual({ 'GET /sources/status': 2, 'GET /status/fetch': 1, 'GET /counts': 1, 'GET /log': 1 });
  await advance(page, tracker, 120_000, 10_000);
  expect(tracker.take(), 'log, 2 minutes').toEqual({ 'GET /log': 4, 'GET /status/fetch': 2 });
  await navTo(page, 'Abrufstatus');
  await expect(page.getByRole('tab', { name: 'Abrufstatus', exact: true })).toHaveAttribute('aria-selected', 'true');
  await tracker.idle();
  expect(tracker.take(), 'opening Abrufstatus').toEqual({ 'GET /sources/status': 1, 'GET /status/fetch/runs': 1, 'GET /status/fetch': 1 });
  await advance(page, tracker, 120_000, 10_000);
  expect(tracker.take(), 'Abrufstatus, 2 minutes').toEqual({ 'GET /status/fetch/runs': 4, 'GET /status/fetch': 4 });
  await navTo(page, 'Wunschliste');
  await expect(wishlistHeading(page)).toBeVisible();
});

test('CODE-07: opening a game is one history step, each tab one more; the breadcrumb returns to the list and its row', async ({ page }) => {
  await signInToFixture(page);
  const id = await addForza(page);
  await page.reload();
  const before = await page.evaluate(() => history.length);
  const details = detailsButton(wishlistRows(page).first());
  await details.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`[?&]item=${id}$`));
  await openTab(page, 'Angebote');
  await openTab(page, 'Verlauf');
  await expect(page).toHaveURL(new RegExp(`[?&]item=${id}&tab=verlauf$`));
  expect(await page.evaluate(() => history.length)).toBe(before + 3);
  // "Wunschliste" in the breadcrumb goes back to the list entry (no new entry) and gives its row the focus again.
  await backToList(page);
  await expect(page).not.toHaveURL(/[?&]item=/);
  await expect(details).toBeFocused();
  expect(await page.evaluate(() => history.length)).toBe(before + 3);
  // Forward: the game again, on the tab it was opened with, then the tabs in their order.
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`[?&]item=${id}$`));
  await expect(page.getByRole('tab', { name: /^Preis/ })).toHaveAttribute('aria-selected', 'true');
  await page.goForward();
  await expect(page.getByRole('tab', { name: /^Angebote/ })).toHaveAttribute('aria-selected', 'true');
  await page.goBack();
  await page.goBack();
  await expect(wishlistHeading(page)).toBeVisible();
  // A deep link has no list behind it: the breadcrumb adds the list as a new entry.
  await page.goto(`/?item=${id}&tab=alarm`);
  await expect(page.getByRole('tab', { name: /^Alarm/ })).toHaveAttribute('aria-selected', 'true');
  const deep = await page.evaluate(() => history.length);
  await backToList(page);
  await expect(wishlistHeading(page)).toBeVisible();
  await expect(page).not.toHaveURL(/[?&](item|tab)=/);
  expect(await page.evaluate(() => history.length)).toBe(deep + 1);
});

test('CODE-07: a 401 in the middle of an action signs out once, shows why, and the next sign-in returns to the same game', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await signInToFixture(page);
  const id = await addForza(page);
  await page.goto(`/?item=${id}`);
  const cart = page.getByRole('button', { name: 'In den Warenkorb', exact: true });
  await expect(cart).toBeVisible();
  // Another device ends every session; this page does not know yet.
  const { csrf_token: csrf } = await (await page.request.get('/api/v1/me')).json();
  expect((await page.request.delete('/api/v1/sessions', { headers: { 'X-CSRF-Token': csrf, Origin: new URL(page.url()).origin } })).ok()).toBe(true);
  await cart.click();
  await expect(page.getByRole('heading', { name: 'Anmelden', level: 1 })).toBeVisible();
  await expect(page.getByText(/^(Sitzung abgelaufen\. )?Bitte anmelden\.$/)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`[?&]item=${id}`));
  // Signing in again opens the same game, and its actions carry the new session's token.
  await page.getByLabel('Passphrase', { exact: true }).fill('browser test passphrase only');
  await page.getByLabel('Passphrase', { exact: true }).press('Enter');
  await expect(page.getByRole('heading', { name: 'Forza Horizon 5', level: 1 })).toBeVisible();
  await cart.click();
  await expect(page.getByRole('button', { name: 'Im Warenkorb', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(errors).toEqual([]);
});
