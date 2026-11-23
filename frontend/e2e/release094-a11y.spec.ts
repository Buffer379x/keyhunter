import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { WISHES, clearWishlist, prepareLayout, settle } from './layout-mocks';

// K21 (release 1.0): axe-core over the main views at 1366 and 375 px, WCAG 2.0 to 2.2 A and AA plus best practice.
// Required: no `serious` and no `critical` violation, colour contrast included. Phones emulate touch (pointer: coarse).
// Justified exclusions: none. The table cells of the price chart that only screen readers get (`.sr-only`) are checked too.
// The log is mocked with a dozen entries of every level: with the hundreds the suite writes, axe 4.14 aborts its contrast rule
// on a phone ("Element midpoint exceeds the grid bounds"); `scan` fails whenever the contrast rule checked nothing.

test.afterEach(async ({ page }) => clearWishlist(page));

/** Violations of impact serious or critical, as readable lines (rule, impact, first targets and the summary of the first node). */
async function scan(page: Page, view: string): Promise<string[]> {
  await settle(page);
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
  expect(result.passes.find(rule => rule.id === 'color-contrast')?.nodes.length ?? 0, `${view}: axe checked the text contrast`).toBeGreaterThan(0);
  return result.violations
    .filter(v => v.impact === 'serious' || v.impact === 'critical')
    .map(
      v =>
        `${v.id} (${v.impact}, ${v.nodes.length}×): ${v.nodes
          .slice(0, 4)
          .map(n => n.target.join(' '))
          .join(' | ')} – ${v.nodes[0]?.failureSummary?.split('\n').slice(0, 2).join(' ')}`,
    );
}

/** A write to the API as the page sends it (origin and CSRF token). */
async function write(page: Page, method: 'POST' | 'DELETE', path: string, data?: object) {
  const { csrf_token: csrf } = await (await page.request.get('/api/v1/me')).json();
  const response = await page.request.fetch(path, { method, data, headers: { 'X-CSRF-Token': csrf, Origin: new URL(page.url()).origin } });
  expect(response.ok(), `${method} ${path}`).toBe(true);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

const DETAIL_TABS = ['', 'angebote', 'verlauf', 'editionen', 'alarm', 'zuordnungen'];
const SETTINGS = ['', 'shops', 'index', 'notifications', 'status', 'log', 'system'];

for (const vp of [
  { name: '1366', width: 1366, height: 768, touch: false },
  { name: '375', width: 375, height: 812, touch: true },
]) {
  test.describe(`axe at ${vp.name} px`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.touch, isMobile: vp.touch });

    test('setup and sign-in screens', async ({ page }) => {
      // The server of the suite is set up already: the two screens come from mocked answers.
      await page.route('**/api/v1/setup', route => (route.request().method() === 'GET' ? route.fulfill({ json: { required: true } }) : route.continue()));
      await page.goto('/');
      await expect(page.getByRole('button', { name: 'Privaten Bereich einrichten', exact: true })).toBeVisible();
      expect(await scan(page, 'setup'), 'setup').toEqual([]);
      await page.unroute('**/api/v1/setup');
      await page.route('**/api/v1/setup', route => (route.request().method() === 'GET' ? route.fulfill({ json: { required: false } }) : route.continue()));
      await page.route('**/api/v1/me', route => route.fulfill({ status: 401, json: { error: 'Nicht angemeldet.' } }));
      await page.goto('/');
      await expect(page.getByRole('button', { name: 'Anmelden', exact: true })).toBeVisible();
      expect(await scan(page, 'login'), 'login').toEqual([]);
    });

    test('wishlist, first steps and the game page with every tab', async ({ page }) => {
      const id = await prepareLayout(page);
      await page.goto('/');
      await expect(page.locator('table.wl tbody tr')).toHaveCount(WISHES);
      expect(await scan(page, 'wishlist'), 'wishlist').toEqual([]);
      for (const tab of DETAIL_TABS) {
        await page.goto(`/?item=${id}${tab ? `&tab=${tab}` : ''}`);
        await expect(page.getByRole('tablist', { name: 'Spieldetails', exact: true }).locator('[aria-selected="true"]')).toBeVisible();
        await expect(page.getByText(/Preisdaten werden geladen/)).toHaveCount(0);
        expect(await scan(page, `detail ${tab || 'preis'}`), `detail ${tab || 'preis'}`).toEqual([]);
      }
    });

    test('cart, library, price alarms and the drawer', async ({ page }) => {
      const id = await prepareLayout(page);
      await write(page, 'POST', '/api/v1/cart', { wish_id: id });
      const owned = await write(page, 'POST', '/api/v1/library', { manual_title: 'Lies of P', platform_id: 49 });
      await page.goto('/?view=cart');
      await expect(page.getByRole('heading', { name: 'Warenkorb', level: 1 })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Forza Horizon 5', exact: true })).toBeVisible();
      expect(await scan(page, 'cart'), 'cart').toEqual([]);
      await page.goto('/?view=library');
      await expect(page.getByText('Lies of P').first()).toBeVisible();
      expect(await scan(page, 'library'), 'library').toEqual([]);
      await page.goto('/?view=alerts');
      await expect(page.getByRole('heading', { name: 'Preisalarme', level: 1 })).toBeVisible();
      expect(await scan(page, 'alerts'), 'alerts').toEqual([]);
      if (vp.touch) {
        await page.getByRole('button', { name: 'Menü öffnen', exact: true }).click();
        await expect(page.getByRole('dialog', { name: 'Seitenleiste' })).toBeVisible();
        expect(await scan(page, 'drawer'), 'drawer').toEqual([]);
      }
      await write(page, 'DELETE', `/api/v1/wishlist/${owned.item.id}`);
    });

    test('every settings tab', async ({ page }) => {
      await prepareLayout(page);
      const levels = ['info', 'warn', 'error'];
      const entries = Array.from({ length: 12 }, (_, i) => ({
        id: 100 - i,
        at: 1795000000 - i * 600,
        level: levels[i % 3],
        area: 'Wunschliste',
        message: `„Forza Horizon 5“ Ereignis ${i + 1}`,
      }));
      await page.route(/\/api\/v1\/log(\?.*)?$/, route => route.fulfill({ json: { entries, total: 12, page: 1, per_page: 50 } }));
      for (const section of SETTINGS) {
        await page.goto(`/?view=settings${section ? `&section=${section}` : ''}`);
        await expect(page.getByRole('tablist', { name: 'Einstellungen', exact: true }).locator('[aria-selected="true"]')).toBeVisible();
        await expect(page.getByRole('main').getByRole('heading', { name: 'Einstellungen', level: 1 })).toBeVisible();
        await expect(page.getByRole('main').getByRole('heading', { level: 2 }).first()).toBeVisible();
        await expect(page.locator('[role="status"]').filter({ hasText: /wird geladen|werden geladen/i })).toHaveCount(0);
        expect(await scan(page, `settings ${section || 'general'}`), `settings ${section || 'general'}`).toEqual([]);
      }
    });
  });
}
