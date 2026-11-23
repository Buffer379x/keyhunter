import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { WISHES, clearWishlist, prepareLayout, settle } from './layout-mocks';
import { fetchBudget, signInToFixture } from './helpers';

// Release 1.0, Phase D part 2: one state language (DS-04), one cover (DS-09), no layout shift from the KPI tiles (PERF-05),
// the first steps of a new owner (PROD-02 / RESP-15), the Zuordnungen tab (PROD-03), a visible budget bottleneck (PROD-14),
// the modal drawer (RESP-08), the wish's platform (RESP-10), "Gekauft" with a question (RESP-13) and the a11y details (RESP-20).

test.afterEach(async ({ page }) => clearWishlist(page));

/** The source states of a set-up instance (other specs on the shared server change the IGDB access). */
const mockSources = (page: Page, igdb: string) =>
  page.route('**/api/v1/sources/status', route =>
    route.fulfill({
      json: {
        eneba: { enabled: true, last_error: null, last_success_at: null, retry_at: 0, state: 'idle' },
        igdb: { configured: igdb !== 'not_configured', enabled: true, last_success_at: null, retry_at: null, state: igdb },
      },
    }),
  );

const row = (page: Page, title: string) =>
  page
    .locator('table.wl tbody tr')
    .filter({ has: page.locator('.game-cell b', { hasText: new RegExp(`^${title}$`) }) })
    .first();

/** A write to the API as the page sends it (origin and CSRF token). */
async function write(page: Page, method: 'POST' | 'DELETE', path: string, data?: object) {
  const { csrf_token: csrf } = await (await page.request.get('/api/v1/me')).json();
  const response = await page.request.fetch(path, { method, data, headers: { 'X-CSRF-Token': csrf, Origin: new URL(page.url()).origin } });
  expect(response.ok(), `${method} ${path}`).toBe(true);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

test.describe('desktop, 1366 px', () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test('DS-04: every state has one tone, icon and text; a missing price is "–" with the reason only in the status column', async ({ page }) => {
    const id = await prepareLayout(page);
    // A target above the price: "Ziel erreicht" on the price tab is the green tick, as in the list and the alarms (was orange).
    await page.route('**/api/v1/wishlist/*/alert', route =>
      route.request().method() === 'GET'
        ? route.fulfill({ json: { rule: { mode: 'target', basis: 'base', target_cents: 3000, enabled: true }, configured: true } })
        : route.continue(),
    );
    await page.goto('/');
    await expect(page.locator('table.wl tbody tr')).toHaveCount(WISHES);
    const stale = row(page, 'Hogwarts Legacy').locator('.c-status .pill', { hasText: /^Veraltet/ });
    await expect(stale).toHaveClass(/\bdim\b/);
    await expect(stale.locator('svg')).toHaveCount(1);
    // No price yet: both price cells "–", the status column names the cause.
    const unknown = row(page, 'Avowed');
    await expect(unknown.locator('.c-de')).toHaveText('–');
    await expect(unknown.locator('.c-world')).toHaveText('–');
    await expect(unknown.locator('.c-status')).toHaveText('Kein Angebot');
    await page.goto(`/?item=${id}`);
    const reached = page.locator('.compare-side.home .pill', { hasText: 'Ziel erreicht' });
    await expect(reached).toHaveClass(/\bok\b/);
    await expect(page.locator('.game-head .pill', { hasText: 'Ziel erreicht' })).toHaveClass(/\bok\b/);
    // The offers' "Gesehen": a stale time is the same grey clock pill, no amber text; never seen is "–".
    await page.goto(`/?item=${id}&tab=angebote`);
    const turkey = page.locator('table.offers tbody tr', { hasText: 'Türkei' });
    await expect(turkey.locator('.c-seen .pill.dim')).toHaveText(/^vor /);
    expect(await turkey.locator('.c-seen').evaluate(cell => getComputedStyle(cell.querySelector('time')!).color)).not.toBe('rgb(242, 193, 78)');
  });

  test('DS-09: one cover component with one fallback everywhere', async ({ page }) => {
    const id = await prepareLayout(page);
    await write(page, 'POST', '/api/v1/cart', { wish_id: id });
    await page.goto('/');
    await expect(page.locator('table.wl tbody tr')).toHaveCount(WISHES);
    expect(await page.locator('.gcover, .game-cover, .cover-initials, .cover-fallback').count()).toBe(0);
    const cover = row(page, 'Forza Horizon 5').locator('.cover');
    await expect(cover).toHaveText('FH');
    const look = await cover.evaluate(el => ({
      box: `${el.getBoundingClientRect().width}x${el.getBoundingClientRect().height}`,
      hue: (el as HTMLElement).style.getPropertyValue('--hue'),
      background: getComputedStyle(el).backgroundImage,
    }));
    expect(look.box).toBe('34x44');
    expect(Number(look.hue)).toBeGreaterThanOrEqual(0);
    expect(look.background).toContain('linear-gradient');
    await page.goto(`/?item=${id}`);
    expect(await page.locator('.game-head .cover').evaluate(el => `${el.getBoundingClientRect().width}x${el.getBoundingClientRect().height}`)).toBe('72x96');
    await page.goto('/?view=cart');
    await expect(page.locator('.cart-table .cover')).toHaveText('FH');
    expect(await page.locator('.cart-table .cover').evaluate(el => `${el.getBoundingClientRect().width}x${el.getBoundingClientRect().height}`)).toBe('30x40');
    // Search results without an image get the same initials (before: a key mark).
    await page.getByRole('searchbox', { name: 'Nach Spielen suchen', exact: true }).fill('forza');
    await expect(page.getByRole('region', { name: 'Suchergebnisse' }).locator('.catalog-result .cover').first()).toHaveText('FH');
  });

  test('PERF-05: the KPI tiles keep their room while the list loads, the list does not jump', async ({ page }) => {
    await prepareLayout(page);
    await page.route('**/api/v1/wishlist', async route => {
      if (route.request().method() === 'GET') await new Promise(done => setTimeout(done, 800));
      await route.fallback();
    });
    await page.goto('/');
    const panel = page.getByRole('region', { name: 'Spiele', exact: true });
    await expect(page.locator('.kpis[aria-hidden="true"] .kpi')).toHaveCount(4);
    const before = (await panel.boundingBox())!.y;
    await expect(page.locator('table.wl tbody tr')).toHaveCount(WISHES);
    await expect(page.locator('.kpis[aria-hidden="true"]')).toHaveCount(0);
    expect((await panel.boundingBox())!.y, `panel top while loading: ${before}`).toBe(before);
    // No layout shift entry moves the list panel's top edge (the tiles were the cause, CLS 0.42 in the audit).
    const moved = await page.evaluate(
      () =>
        new Promise<number>(done => {
          let count = 0;
          const panel = document.querySelector('section[aria-label="Spiele"]');
          new PerformanceObserver(list => {
            for (const entry of list.getEntries() as (PerformanceEntry & { sources: { node?: Node; previousRect: DOMRect; currentRect: DOMRect }[] })[])
              count += entry.sources.filter(s => s.node === panel && s.previousRect.y !== s.currentRect.y).length;
          }).observe({ type: 'layout-shift', buffered: true });
          setTimeout(() => done(count), 200);
        }),
    );
    expect(moved, 'shifts of the list panel').toBe(0);
  });

  test('PROD-02: the first steps show what is missing, lead there, can be hidden and go away when all is done', async ({ page }) => {
    await mockSources(page, 'not_configured');
    await page.route('**/api/v1/wishlist', route => (route.request().method() === 'GET' ? route.fulfill({ json: [] }) : route.continue()));
    await page.route('**/api/v1/alerts', route =>
      route.request().method() === 'GET' ? route.fulfill({ json: { configured: false, channels: [], rules: [], events: [] } }) : route.continue(),
    );
    await signInToFixture(page);
    const steps = page.getByRole('region', { name: 'Erste Schritte', exact: true });
    await expect(steps).toBeVisible();
    const step = (name: string) => steps.locator('li', { has: page.getByRole('button', { name, exact: true }) });
    await expect(step('Zielland wählen')).toContainText('Deutschland');
    await expect(step('Zielland wählen')).toContainText('Erledigt');
    await expect(step('Spieleindex (IGDB) einrichten')).toContainText('Offen');
    await expect(step('Erstes Spiel vormerken')).toContainText('Offen');
    await expect(step('Benachrichtigungskanal einrichten')).toContainText('Offen');
    await expect(steps).toContainText('2 von 5');
    await steps.getByRole('button', { name: 'Benachrichtigungskanal einrichten', exact: true }).click();
    await expect(page).toHaveURL(/view=settings&section=notifications/);
    await page.goBack();
    await steps.getByRole('button', { name: 'Erstes Spiel vormerken', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Spiel hinzufügen' })).toBeVisible();
    await page.keyboard.press('Escape');
    // Hidden by the owner: stays hidden after a reload.
    await steps.getByRole('button', { name: 'Erste Schritte ausblenden', exact: true }).click();
    await expect(steps).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Wunschliste', level: 1 })).toBeVisible();
    await expect(page.locator('table.wl, .empty').first()).toBeVisible();
    await expect(steps).toHaveCount(0);
  });

  test('PROD-02: with every step done there is no checklist', async ({ page }) => {
    await prepareLayout(page);
    await mockSources(page, 'ready');
    await page.route('**/api/v1/alerts', route =>
      route.request().method() === 'GET' ? route.fulfill({ json: { configured: true, channels: ['ntfy'], rules: [], events: [] } }) : route.continue(),
    );
    await page.goto('/');
    await expect(page.locator('table.wl tbody tr')).toHaveCount(WISHES);
    await settle(page);
    await expect(page.getByRole('region', { name: 'Erste Schritte', exact: true })).toHaveCount(0);
  });

  test('PROD-03: the tab is called Zuordnungen and the old ?tab=infos link opens it', async ({ page }) => {
    const id = await prepareLayout(page);
    await page.goto(`/?item=${id}&tab=infos`);
    const tab = page.getByRole('tablist', { name: 'Spieldetails', exact: true }).getByRole('tab', { name: /^Zuordnungen/ });
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: /^Infos/ })).toHaveCount(0);
    await page
      .getByRole('tab', { name: /^Preis/ })
      .first()
      .click();
    await tab.click();
    await expect(page).toHaveURL(/tab=zuordnungen/);
    await page.goto('/');
    await expect(row(page, 'Forza Horizon 5').locator('.wish-review')).toHaveAttribute('title', /unter Zuordnungen$/);
  });

  test('PROD-14: a shop whose demand is above its own limit shows on the fetch tile with a link to Key-Shops', async ({ page }) => {
    await prepareLayout(page);
    const shop = (source: string, limit: number, demand: number) => ({
      source,
      enabled: true,
      last_success_at: null,
      last_error: null,
      paused_until: null,
      budget: fetchBudget({ used: 10, limit, demand_per_day: demand }),
      backlog: { due: 0, requested: 0, products: 0, searches: 0 },
      oldest_due_at: null,
      next_due_at: null,
      worker_seen_at: null,
    });
    // Enough in sum (560 of 620), but Driffle needs 160 with a limit of 120.
    await page.route('**/api/v1/status/fetch', route =>
      route.fulfill({ json: { shops: [shop('eneba', 500, 400), shop('driffle', 120, 160)], errors_24h: 0, recent_runs: [], upcoming: [] } }),
    );
    await page.goto('/');
    const tile = page.locator('.kpi', { hasText: 'Abrufe heute' });
    await expect(tile).toHaveClass(/\bshort\b/);
    await tile.getByRole('button', { name: 'zu knapp: Driffle', exact: true }).click();
    await expect(page).toHaveURL(/view=settings&section=shops/);
  });

  test("RESP-10: list, game page, cart and alarms name the wish's own platform", async ({ page }) => {
    const id = await prepareLayout(page);
    await write(page, 'POST', '/api/v1/cart', { wish_id: id });
    await page.goto('/');
    await expect(row(page, 'Hogwarts Legacy').locator('.game-cell small')).toHaveText('Standard Edition · Xbox One (6 Angebote)');
    await expect(row(page, 'Forza Horizon 5').locator('.game-cell small')).toContainText('Xbox Series X|S');
    await page.goto(`/?item=${id}`);
    await expect(page.locator('.game-meta .label')).toHaveText('Xbox Series X|S · 2021');
    await page.goto('/?view=cart');
    await expect(page.locator('.cart-table .game-cell small')).toHaveText('Xbox Series X|S');
  });

  test('RESP-13: "Gekauft" asks first; cancel keeps the wish', async ({ page }) => {
    const id = await prepareLayout(page);
    await page.goto(`/?item=${id}`);
    await page.getByRole('button', { name: 'Gekauft', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Als gekauft markieren?' });
    await expect(dialog).toContainText('Forza Horizon 5');
    await dialog.getByRole('button', { name: 'Abbrechen', exact: true }).click();
    await expect(dialog).toBeHidden();
    expect((await (await page.request.get('/api/v1/library')).json()).length).toBe(0);
    await page.getByRole('button', { name: 'Gekauft', exact: true }).click();
    await dialog.getByRole('button', { name: 'In die Bibliothek verschieben', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Wunschliste', level: 1 })).toBeVisible();
    const library = await (await page.request.get('/api/v1/library')).json();
    expect(library.map((item: { id: string }) => item.id)).toEqual([id]);
    await write(page, 'DELETE', `/api/v1/wishlist/${id}`);
  });

  test('RESP-20: toaster region, focusable scroll tables, help and search popups wait for an explicit action', async ({ page }) => {
    await prepareLayout(page);
    await page.goto('/');
    await expect(page.getByRole('region', { name: 'Meldungen', exact: true })).toHaveCount(1);
    // A Tab stop on "?" only describes it; the popup waits for a click.
    const help = page.getByRole('button', { name: 'Hilfe zur Wunschliste', exact: true });
    await page.keyboard.press('Tab');
    await help.focus();
    await expect(help).toHaveAttribute('aria-expanded', 'false');
    await help.click();
    await expect(help).toHaveAttribute('aria-expanded', 'true');
    // A Tab stop into the empty top search does not open the results popup; typing does.
    const search = page.getByRole('searchbox', { name: 'Nach Spielen suchen', exact: true });
    await search.focus();
    await expect(page.getByRole('region', { name: 'Suchergebnisse' })).toHaveCount(0);
    await search.pressSequentially('f');
    await expect(page.getByRole('region', { name: 'Suchergebnisse' })).toBeVisible();
    for (const [section, name] of [
      ['log', 'Ereignistabelle'],
      ['status', 'Tabelle der letzten Abrufe'],
    ]) {
      await page.goto(`/?view=settings&section=${section}`);
      await expect(page.getByRole('region', { name, exact: true })).toHaveAttribute('tabindex', '0');
    }
  });
});

test.describe('setup, 1366 px', () => {
  test('RESP-15: the setup screen says what KeyHunter does and where the setup code is', async ({ page }) => {
    await page.route('**/api/v1/setup', route => (route.request().method() === 'GET' ? route.fulfill({ json: { required: true } }) : route.continue()));
    await page.goto('/');
    await expect(page.getByText('Vergleicht Xbox-Key-Preise aller Regionen mit deinem Land und meldet Zielpreise.')).toBeVisible();
    const help = page.getByRole('button', { name: 'Hilfe zum Einrichtungscode', exact: true });
    await help.click();
    await expect(page.getByRole('tooltip')).toContainText('/mnt/user/appdata/keyhunter/bootstrap-token');
    await expect(page.getByRole('tooltip')).toContainText('docker exec KeyHunter cat /data/bootstrap-token');
  });
});

test.describe('tablet, 768 px', () => {
  test.use({ viewport: { width: 768, height: 1024 } });

  test('RESP-08: the open drawer is modal; Tab stays in it and the first Escape closes it', async ({ page }) => {
    await prepareLayout(page);
    await page.goto('/');
    const menu = page.getByRole('button', { name: 'Menü öffnen', exact: true });
    await menu.click();
    const drawer = page.getByRole('dialog', { name: 'Seitenleiste' });
    await expect(drawer).toHaveAttribute('aria-modal', 'true');
    expect(await page.locator('.main').evaluate(el => (el as HTMLElement).inert)).toBe(true);
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => !document.activeElement?.closest('.main')), `Tab ${i + 1} stays out of the page`).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Seitenleiste' })).toHaveCount(0);
    await expect(menu).toBeFocused();
    expect(await page.locator('.main').evaluate(el => (el as HTMLElement).inert)).toBe(false);
  });
});
