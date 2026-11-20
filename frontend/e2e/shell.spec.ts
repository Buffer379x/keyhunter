import { test, expect } from '@playwright/test';
import { expectSettingsSaved, navItem, navTo, settingsCountry, signInToFixture } from './helpers';
import { openWishlistRow, removeCurrent } from './detail-helpers';

const now = () => Math.floor(Date.now() / 1000);
const shop = (source: string, used: number, limit: number, pace?: number) => ({
  source, enabled: true, last_success_at: now() - 60, last_error: null, paused_until: null,
  budget: pace === undefined ? { used, limit } : { used, limit, limit_source: 'default', demand_per_day: 470, pace_seconds: pace, next_at: now() + pace, by_hour: Array(24).fill(0) },
  backlog: { due: 0, requested: 0, products: 0, searches: 0 }, oldest_due_at: null, next_due_at: null, worker_seen_at: now(),
});

test('sidebar fetch card sums the budget, shows the pace when the backend sends it and opens Abrufstatus', async ({ page }) => {
  await page.route('**/api/v1/status/fetch', route => route.fulfill({ json: { shops: [shop('eneba', 300, 500, 180), shop('driffle', 112, 500)], errors_24h: 0, recent_runs: [] } }));
  await signInToFixture(page);
  const sidebar = page.getByRole('complementary', { name: 'Seitenleiste' });
  const card = sidebar.getByRole('button', { name: /^Abrufstatus Eneba/ });
  await expect(card).toContainText('alle 3 Min.');
  await expect(card).toContainText('412 von 1000 Abrufen heute');
  await card.click();
  await expect(page).toHaveURL(/view=settings&section=status/);
  await expect(navItem(page, 'Abrufstatus')).toHaveAttribute('aria-current', 'page');
});

test('top bar: breadcrumbs follow the page, the bell opens the alarms, "Spiel hinzufügen" works from every page', async ({ page }) => {
  await signInToFixture(page);
  const crumbs = page.getByRole('navigation', { name: 'Pfad' });
  await expect(crumbs).toHaveText(/KeyHunter.*Wunschliste/);
  await page.getByRole('banner').getByRole('button', { name: 'Preisalarme', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Preisalarme', level: 1 })).toBeVisible();
  await expect(navItem(page, 'Preisalarme')).toHaveAttribute('aria-current', 'page');
  await expect(crumbs).toHaveText(/KeyHunter.*Preisalarme/);
  await navTo(page, 'Key-Shops');
  await expect(crumbs).toHaveText(/Einstellungen.*Key-Shops/);
  await page.getByRole('button', { name: 'Spiel hinzufügen', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Spiel hinzufügen', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Spiel im Katalog suchen').fill('forza');
  await dialog.getByRole('button', { name: 'Forza Horizon 5 vormerken', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Forza Horizon 5', exact: true })).toBeVisible();
  await expect(crumbs).toHaveText(/Wunschliste.*Forza Horizon 5/);
  await crumbs.getByRole('button', { name: 'Wunschliste', exact: true }).click();
  await expect(page).not.toHaveURL(/item=/);
  await expect(crumbs).toHaveText(/KeyHunter.*Wunschliste/);
  await openWishlistRow(page, 'Forza Horizon 5');
  await removeCurrent(page);
});

test('the sidebar target country saves itself and the settings page shows the same value', async ({ page }) => {
  await signInToFixture(page);
  const sidebarCountry = page.getByRole('complementary', { name: 'Seitenleiste' }).getByLabel('Zielland', { exact: true });
  const saved = page.waitForRequest(r => r.url().endsWith('/api/v1/settings') && r.method() === 'PUT');
  await sidebarCountry.selectOption('AT');
  expect((await saved).postDataJSON().target_country).toBe('AT');
  await expect(page.getByRole('status').filter({ hasText: 'Zielland: Österreich' })).toBeVisible();
  await navTo(page, 'Allgemein');
  await expect(settingsCountry(page)).toHaveValue('AT');
  await settingsCountry(page).selectOption('DE');
  await expectSettingsSaved(page);
  await expect(sidebarCountry).toHaveValue('DE');
  await page.reload();
  await expect(sidebarCountry).toHaveValue('DE');
});

test('phone layout: no breadcrumbs, the search fills the top bar and the drawer closes after navigating', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInToFixture(page);
  await expect(page.getByRole('navigation', { name: 'Pfad' })).toBeHidden();
  const search = page.getByRole('searchbox', { name: 'Nach Spielen suchen', exact: true });
  const box = await search.boundingBox();
  expect(box!.width).toBeGreaterThan(250);
  await navTo(page, 'Bibliothek');
  await expect(page.getByRole('navigation', { name: 'Hauptnavigation' })).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Bibliothek', level: 1, exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
