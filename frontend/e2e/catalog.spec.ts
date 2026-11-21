import { test, expect } from '@playwright/test';
import { saveSettings, signInToFixture, navTo, settingsCountry } from './helpers';
import { openTab, openWishlistRow, removeCurrent, wishlistHeading, wishlistRows } from './detail-helpers';

test('catalog choice persists, editions stay distinct, filters and removal work on mobile', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await signInToFixture(page);
  await expect(wishlistHeading(page)).toBeVisible();
  await page.getByRole('button', { name: 'Spiel hinzufügen', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Spiel hinzufügen', exact: true });
  await dialog.getByLabel('Spiel im Katalog suchen').fill('forza');
  await expect(dialog.getByRole('status')).toContainText('2 Treffer');
  await dialog.getByRole('button', { name: 'Forza Horizon 5: Premium Edition (Xbox Series X|S) vormerken', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('heading', { name: 'Forza Horizon 5: Premium Edition', exact: true, level: 1 })).toBeVisible();
  expect(page.url()).toContain('item=');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Forza Horizon 5: Premium Edition', exact: true, level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Spiel hinzufügen', exact: true }).click();
  await dialog.getByLabel('Spiel im Katalog suchen').fill('forza');
  await expect(dialog.getByRole('button', { name: 'Forza Horizon 5: Premium Edition (Xbox Series X|S) vormerken', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Forza Horizon 5 (Xbox Series X|S) vormerken', exact: true }).click();
  // The dialog closes while the game page opens; only then is the page heading the only one.
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Forza Horizon 5', exact: true, level: 1 })).toBeVisible();
  // The game is a page of its own: "Wunschliste" in the breadcrumb leads back to the list.
  await page.getByRole('navigation', { name: 'Pfad' }).getByRole('button', { name: 'Wunschliste', exact: true }).click();
  await expect(wishlistRows(page)).toHaveCount(2);
  await page.getByLabel('Liste filtern').fill('Alternativer Testtitel');
  await expect(wishlistRows(page)).toHaveCount(2);
  await page.getByLabel('Liste filtern').fill('Premium');
  await expect(wishlistRows(page)).toHaveCount(1);
  await page.getByLabel('Liste filtern').fill('');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: 'test-results/wishlist-fixture-desktop.png', fullPage: true });
  await openWishlistRow(page, /Premium Edition/);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/wishlist-fixture-mobile.png', fullPage: true });
  await expect(page.getByRole('heading', { name: 'Forza Horizon 5: Premium Edition', level: 1 })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 320, height: 800 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await removeCurrent(page);
  await expect(wishlistRows(page)).toHaveCount(1);
  await openWishlistRow(page, /Forza Horizon 5/);
  await removeCurrent(page);
  await expect(page.getByText(/^0 von 100 Plätzen/)).toBeVisible();
  await expect(wishlistHeading(page)).toBeFocused();
  expect(errors).toEqual([]);
});

test('old search cannot replace newer results, outage differs from empty and manual stays unverified', async ({ page }) => {
  await signInToFixture(page);
  await page.getByRole('button', { name: 'Spiel hinzufügen', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Spiel hinzufügen', exact: true });
  const input = dialog.getByLabel('Spiel im Katalog suchen');
  const oldQuery = `alt-${Date.now()}`;
  const started = page.waitForRequest(r => r.url().includes(`/catalog/search?q=${oldQuery}&`));
  await input.fill(oldQuery); await started;
  await input.fill('neu');
  await expect(dialog.getByRole('heading', { name: 'Neuer Treffer', exact: true })).toBeVisible();
  await page.waitForTimeout(1000);
  await expect(dialog.getByRole('heading', { name: 'Alter Treffer', exact: true })).not.toBeVisible();
  await input.fill('dlc');
  await expect(dialog.getByRole('button', { name: 'Testspiel Zusatzinhalt (DLC) vormerken', exact: true })).toBeDisabled();
  await input.fill('kein treffer');
  await expect(dialog.getByRole('status')).toContainText('Keine passenden Katalogtreffer');
  await input.fill('ausfall');
  await expect(dialog.getByRole('alert')).toContainText('vorübergehend nicht erreichbar');
  await dialog.getByRole('button', { name: 'Ungeprüft vormerken' }).click();
  await expect(page.getByRole('heading', { name: 'ausfall', exact: true })).toBeVisible();
  await expect(page.getByText('Manueller Titel · Zuordnungen werden vor dem Preisvergleich geprüft.', { exact: true })).toBeVisible();
  await removeCurrent(page);
  await expect(page.getByText(/^0 von 100 Plätzen/)).toBeVisible();
  await expect(wishlistHeading(page)).toBeFocused();
});

test('dashboard shows automatic discovery, tabs and observed offer eligibility', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInToFixture(page);
  await page.getByRole('searchbox', { name: 'Nach Spielen suchen', exact: true }).fill('forza');
  await page.getByRole('region', { name: 'Suchergebnisse' }).getByRole('button', { name: 'Forza Horizon 5 (Xbox Series X|S) vormerken', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Preisvergleich' })).toContainText('Bester Preis');
  await openTab(page, 'Angebote');
  await expect(page.getByText('Suche eingeplant', { exact: true })).toBeVisible();
  await openTab(page, 'Preis');
  await expect(page.getByLabel('Produktlink von Eneba oder Driffle')).not.toBeVisible();

  // Synthetic response verifies rendering and filtering independently of shop availability.
  const link = (id: number, eligible: boolean, region = eligible ? 'Global' : 'United States') => ({
    id, source: 'eneba', url: 'https://www.eneba.com/de/xbox-fixture-xbox-live-key-global',
    review: 'confirmed', can_confirm: true, eligible, queued: false, enabled: true,
    stale: false, observed_at: Math.floor(Date.now() / 1000) - 7200, attempted_at: 1794950000, last_error: null, retry_at: 0, reasons: eligible ? [] : ['activation_blocked'],
    product: { name: 'Synthetic UI offer', region, market: 'DE', activation: eligible ? 'confirmed' : 'blocked', availability: 'in_stock' },
    quotes: [{ id: String(id), seller: null, base_cents: eligible ? 2499 : 1299, estimated_total_cents: null }],
  });
  let target = 'DE';
  await page.route('**/api/v1/wishlist/*/offers', route => route.request().method() === 'GET' ? route.fulfill({
    json: { links: [link(1, true), link(2, false), link(3, true, 'Deutschland'), link(4, false, 'Argentina')], history: [], best_base: 2499, best_estimate: null,
      target_country: target, discovery_running: false, searches: [{ source: 'eneba', status: 'complete', checked_at: 1794950000, result_count: 4, last_error: null }], sources: [] },
  }) : route.continue());
  await page.reload();
  await expect(page.getByRole('group', { name: 'Preisvergleich' })).toContainText('Bester Preis · DE');
  await openTab(page, 'Angebote');
  const rows = page.getByRole('table', { name: 'Angebote nach Preis' }).locator('tbody tr');
  await expect(rows).toHaveCount(4);
  // Cheaper foreign offers stay visible, ordered by price, each with the reason why it does not count.
  await expect(rows.first()).toContainText('Vereinigte Staaten');
  await expect(rows.first()).toContainText('in DE nicht aktivierbar');
  await expect(rows.first().getByRole('link', { name: /^Zum Shop/ })).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(rows.filter({ hasText: 'Deutschland' })).toContainText('in DE aktivierbar');
  await expect(page.getByRole('tab', { name: /^Angebote/ })).toContainText('4');
  await openTab(page, 'Editionen');
  await expect(page.getByRole('button', { name: 'Premium Edition ansehen', exact: true })).toBeVisible();
  await openTab(page, 'Verlauf');
  await expect(page.getByText('Noch keine Preismessung vorhanden.')).toBeVisible();
  await openTab(page, 'Infos');
  await expect(page.getByText('Erscheinungsjahr', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/[?&]tab=infos/);
  await page.goBack();
  await expect(page).toHaveURL(/[?&]tab=verlauf/);
  await expect(page.getByRole('tab', { name: /^Verlauf/ })).toHaveAttribute('aria-selected', 'true');
  await page.reload();
  await expect(page.getByRole('tab', { name: /^Verlauf/ })).toHaveAttribute('aria-selected', 'true');
  await openTab(page, 'Angebote');
  await navTo(page, 'Allgemein');
  await settingsCountry(page).selectOption('US');
  await saveSettings(page);
  target = 'US';
  // The sidebar always opens the list; browser back returns to the game and its tab.
  await page.goBack();
  await expect(page.getByRole('tab', { name: /^Angebote/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('table', { name: 'Angebote nach Preis' }).locator('tbody tr')).toHaveCount(4);
  await openTab(page, 'Preis');
  await expect(page.getByRole('group', { name: 'Preisvergleich' })).toContainText('Bester Preis · US');
  await navTo(page, 'Allgemein');
  await settingsCountry(page).selectOption('DE');
  await saveSettings(page);
  target = 'DE';
  await page.goBack();
  await removeCurrent(page);
});
