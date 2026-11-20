import { test, expect } from '@playwright/test';
import { signInToFixture, navTo } from './helpers';

const id = (n: number) => `${n}`.repeat(32);
const game = (n: number, name: string, edition: string | null, cover: string | null) => ({
  igdb_id: 900 + n, name, slug: null, summary: null, first_release_date: null, platforms: [], aliases: [], cover_url: cover,
  version_parent: null, edition_name: edition, kind: 'base_game', fetched_at: 1,
});

test('Preisalarme lists every target sorted by distance and a row opens the alarm tab of the game', async ({ page }) => {
  await signInToFixture(page);
  const wishes = [[1, 'Starfield', 'Premium Edition', 4000, 4749], [2, 'Forza Horizon 5', 'Standard Edition', 2900, 2890], [3, 'Ori', null, 800, null], [4, 'Halo', null, null, 1500]] as const;
  await page.route('**/api/v1/alerts', route => route.request().method() !== 'GET' ? route.continue() : route.fulfill({ json: {
    configured: true,
    rules: wishes.map(([n, title, , target]) => ({ wish_id: id(n), title, mode: target === null ? 'low' : 'target', basis: 'base', target_cents: target, enabled: true, delivery: null })),
    events: [{ id: 1, wish_id: id(2), state: 'sent', observed_at: 1795107000, sent_at: 1795107060, cents: 2890, attempts: 1 }],
  } }));
  await page.route(/\/api\/v1\/wishlist\/price-badges/, route => route.fulfill({ json: Object.fromEntries(wishes.map(([n, , , , cents]) => [id(n), { cents, state: cents === null ? 'no_offer' : 'price', observed_at: 1, checked_at: 1, stale: false, pending: false }])) }));
  await page.route(/\/api\/v1\/wishlist$/, route => route.request().method() !== 'GET' || !page.url().includes('view=alerts') ? route.continue()
    : route.fulfill({ json: wishes.map(([n, title, edition]) => ({ id: id(n), game_id: String(n), platform_id: 169, created_at: n, verification: 'catalog', game: game(n, title, edition, null), manual_title: null })) }));
  await navTo(page, 'Preisalarme');
  await expect(page.getByRole('heading', { name: 'Preisalarme', level: 1 })).toBeVisible();
  await expect(page.getByText('ntfy eingerichtet', { exact: true })).toBeVisible();
  const table = page.getByRole('table', { name: 'Preisalarme nach Abstand' });
  await expect(table.getByRole('columnheader')).toHaveText(['Spiel', 'Ziel', /^Jetzt [A-Z]{2}$/, 'Abstand', 'Status']);
  const rows = table.locator('tbody tr');
  // Reached first (closest), then above the target, then without price, then "Neuer Tiefstpreis".
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText('Forza Horizon 5');
  await expect(rows.nth(0)).toContainText('Standard Edition');
  await expect(rows.nth(0)).toContainText('−0,10 €');
  await expect(rows.nth(0)).toContainText('Ziel erreicht');
  await expect(rows.nth(1)).toContainText('+7,49 €');
  await expect(rows.nth(1)).toContainText('7,49 € über Ziel');
  await expect(rows.nth(2)).toContainText('Kein Preis');
  await expect(rows.nth(3)).toContainText('Neuer Tiefstpreis');
  // Without a cover the game keeps a coloured cover with its initials.
  await expect(rows.nth(0).locator('.cover-initials')).toHaveText('FH');
  await expect(page.getByRole('table', { name: 'Letzte Zustellungen' })).toContainText('Forza Horizon 5');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await rows.nth(1).locator('td').nth(3).click();
  await expect(page).toHaveURL(new RegExp(`[?&]item=${id(1)}&tab=alarm`));
});

test('Bibliothek shows covers with edition and purchase date, and keeps the restore action', async ({ page }) => {
  await signInToFixture(page);
  await page.route(/\/covers\/.*\.svg$/, route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="3" height="4"><rect width="3" height="4" fill="#345"/></svg>' }));
  const origin = new URL(page.url()).origin;
  await page.route('**/api/v1/library', route => route.fulfill({ json: [
    { id: id(1), game_id: '1', platform_id: 169, created_at: 1, acquired_at: 1795107000, verification: 'catalog', game: game(1, 'Halo Infinite', 'Kampagne', `${origin}/covers/halo.svg`), manual_title: null },
    { id: id(2), game_id: '2', platform_id: 49, created_at: 2, acquired_at: 1790000000, verification: 'manual_unverified', game: null, manual_title: 'Lies of P' },
  ] }));
  await navTo(page, 'Bibliothek');
  await expect(page.getByRole('heading', { name: 'Bibliothek', level: 1, exact: true })).toBeVisible();
  await expect(page.getByText('2 Spiele gekauft · werden nicht mehr abgefragt')).toBeVisible();
  const items = page.getByRole('list', { name: 'Meine Spiele' }).getByRole('listitem');
  await expect(items.first()).toContainText(/Halo Infinite\s*Kampagne · \d{2}\.\d{2}\.2026/);
  await expect(items.first().locator('img')).toHaveAttribute('src', /halo\.svg$/);
  await expect(items.nth(1)).toContainText('Xbox One');
  await expect(items.nth(1).locator('.cover-initials')).toHaveText('LO');
  await expect(items.first().getByRole('button', { name: 'Halo Infinite zurück in die Wunschliste', exact: true })).toBeVisible();
});
