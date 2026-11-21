import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { signInToFixture } from './helpers';
import { openTab, removeCurrent } from './detail-helpers';

const now = () => Math.floor(Date.now() / 1000);
const link = (id: number, region: string, cents: number, extra: object = {}) => ({
  id, source: 'eneba', url: `https://www.eneba.com/de/xbox-forza-horizon-5-${region.toLowerCase()}-key`, review: 'confirmed', can_confirm: true,
  eligible: region === 'Global', queued: false, enabled: true, stale: false, observed_at: now() - 3600, attempted_at: now() - 3600, last_error: null, retry_at: 0,
  reasons: region === 'Global' ? [] : ['activation_unknown'],
  product: { name: 'Forza Horizon 5 Xbox Key', region, market: 'DE', activation: region === 'Global' ? 'confirmed' : 'unknown', availability: 'in_stock' },
  quotes: [{ id: String(id), seller: null, base_cents: cents, estimated_total_cents: null }], ...extra,
});
const view = (links: object[]) => ({ links, histories: { preferred: [], all: [] }, history: [], best_base: 2890, best_estimate: null, target_country: 'DE', searches: [], sources: [], discovery_running: false });

async function openForza(page: Page) {
  await signInToFixture(page);
  await page.getByRole('searchbox', { name: 'Nach Spielen suchen', exact: true }).fill('forza');
  await page.getByRole('region', { name: 'Suchergebnisse' }).getByRole('button', { name: 'Forza Horizon 5 vormerken', exact: true }).click();
  await expect(page).toHaveURL(/[?&]item=/);
}

test('the three amounts of the price comparison stand on one line', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openForza(page);
  await page.route('**/api/v1/wishlist/*/offers', route => route.request().method() === 'GET'
    ? route.fulfill({ json: view([link(1, 'Global', 2890), link(2, 'India', 1290)]) }) : route.continue());
  await page.reload();
  const compare = page.getByRole('group', { name: 'Preisvergleich', exact: true });
  await expect(compare.locator('.delta-amount')).toContainText('−16,00');
  const box = async (selector: string) => (await compare.locator(selector).boundingBox())!;
  const home = await box('.compare-side.home .big-price'), delta = await box('.delta-amount'), world = await box('.compare-side.world .big-price');
  // Same line box (font of the big price) in all three columns: same top and height, so the same baseline.
  for (const other of [delta, world]) {
    expect(Math.abs(other.y - home.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(other.height - home.height)).toBeLessThanOrEqual(1);
  }
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await removeCurrent(page);
});

test('an automatically found product that does not match can be checked in a popup and confirmed by hand', async ({ page }) => {
  await openForza(page);
  const found = link(7, 'Global', 2490, { review: 'pending', can_confirm: false, eligible: false, reasons: [], url: 'https://www.eneba.com/de/xbox-forza-horizon-5-deluxe-bundle-xbox-live-key-global',
    product: { name: 'Forza Horizon 5 Deluxe Bundle Xbox Live Key GLOBAL', region: 'Global', market: 'DE', activation: 'confirmed', availability: 'in_stock' } });
  let confirmed = false;
  const bodies: unknown[] = [];
  await page.route('**/api/v1/wishlist/*/offers', route => route.request().method() === 'GET'
    ? route.fulfill({ json: view([confirmed ? { ...found, review: 'confirmed', eligible: true, manual_match: true } : found]) }) : route.continue());
  await page.route('**/api/v1/wishlist/*/offers/7', async route => {
    bodies.push(route.request().postDataJSON());
    confirmed = true;
    await route.fulfill({ status: 204, body: '' });
  });
  await page.reload();
  await openTab(page, 'Infos');
  const match = page.locator('.match').filter({ hasText: 'Deluxe Bundle' });
  await expect(match).toContainText('Selbst prüfen');
  // No direct jump to the shop for an open review: the popup shows the address first.
  await expect(match.getByRole('link', { name: /Produktseite/ })).toHaveCount(0);
  await match.getByRole('button', { name: 'Prüfen', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Zuordnung prüfen', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Forza Horizon 5');
  await expect(dialog).toContainText('Forza Horizon 5 Deluxe Bundle Xbox Live Key GLOBAL');
  await expect(dialog).toContainText('24,90');
  await expect(dialog.locator('.review-url')).toHaveText('eneba.com/de/xbox-forza-horizon-5-deluxe-bundle-xbox-live-key-global');
  const open = dialog.getByRole('link', { name: 'Produktseite öffnen' });
  await expect(open).toHaveAttribute('href', found.url);
  await expect(open).toHaveAttribute('target', '_blank');
  await expect(open).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(dialog.getByRole('note')).toContainText('passen laut Shop-Daten nicht automatisch');
  await page.setViewportSize({ width: 320, height: 700 });
  await expect.poll(() => dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 720 });
  await dialog.getByRole('button', { name: 'Zuordnung bestätigen', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(bodies).toEqual([{ decision: 'confirmed', manual: true }]);
  await expect(match).toContainText('Von dir bestätigt');
  await expect(match.getByRole('link', { name: /Produktseite/ })).toHaveAttribute('title', found.url);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await removeCurrent(page);
});
