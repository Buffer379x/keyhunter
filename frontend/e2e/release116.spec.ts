import { test, expect } from '@playwright/test';
import { navTo, signInToFixture } from './helpers';
import { clearWishlist, prepareLayout, settle } from './layout-mocks';

// 1.1.6: add-ons can be wished and are marked "DLC": after the title in the wishlist, in the corner of the cover in the
// library; the catalog search lets them be added.

test.afterEach(async ({ page }) => clearWishlist(page));

const dlc = (n: number, name: string, kind = 'dlc') => ({
  igdb_id: 950 + n,
  name,
  slug: null,
  summary: null,
  first_release_date: null,
  platforms: [{ id: 169, name: 'Xbox Series X|S' }],
  aliases: [],
  cover_url: null,
  version_parent: null,
  edition_name: null,
  kind,
  fetched_at: 1,
});

test('an add-on carries a DLC tag after its title in the wishlist', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await prepareLayout(page);
  // On top of the layout mocks: the first wish is an add-on.
  await page.route('**/api/v1/wishlist', async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    const rows = await (await route.fetch()).json();
    rows[0] = { ...rows[0], game: { ...rows[0].game, name: 'Forza Horizon 5: Hot Wheels', kind: 'dlc' } };
    await route.fulfill({ json: rows });
  });
  await page.goto('/');
  const row = page.locator('table.wl tbody tr').filter({ hasText: 'Hot Wheels' });
  await expect(row).toBeVisible();
  await settle(page);
  const tag = row.locator('.game-title .dlc-tag');
  await expect(tag).toHaveText('DLC: DLC / Zusatzinhalt');
  await expect(tag).toHaveAttribute('title', 'DLC / Zusatzinhalt');
  const [title, mark] = [await row.locator('.game-title b').boundingBox(), await tag.boundingBox()];
  expect(title!.x + title!.width).toBeLessThanOrEqual(mark!.x);
  // A game has none.
  await expect(page.locator('table.wl tbody tr').filter({ hasText: 'Starfield' }).locator('.dlc-tag')).toHaveCount(0);
});

test('the library marks add-ons in the corner of the cover', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInToFixture(page);
  const owned = (n: number, game: ReturnType<typeof dlc>) => ({
    id: `${n}`.repeat(32),
    game_id: `${n}`,
    platform_id: 169,
    created_at: n,
    acquired_at: 1795107000,
    verification: 'catalog',
    game,
    manual_title: null,
  });
  await page.route('**/api/v1/library', route =>
    route.fulfill({
      json: [
        owned(1, dlc(1, 'RoboCop: Rogue City - Unfinished Business', 'standalone_expansion')),
        owned(2, dlc(2, 'Forza Horizon 5: Hot Wheels')),
        owned(3, dlc(3, 'Halo Infinite', 'base_game')),
      ],
    }),
  );
  await navTo(page, 'Bibliothek');
  const items = page.locator('.lib-item');
  await expect(items).toHaveCount(3);
  await settle(page);
  const item = (name: string) => items.filter({ hasText: name });
  for (const name of ['RoboCop', 'Hot Wheels']) {
    const cover = item(name).locator('.lib-cover');
    const tag = cover.locator('.cover-tag');
    await expect(tag).toBeVisible();
    const [box, mark] = [await cover.boundingBox(), await tag.boundingBox()];
    expect(mark!.x - box!.x).toBeLessThan(12);
    expect(mark!.y - box!.y).toBeLessThan(12);
  }
  await expect(item('RoboCop').locator('.cover-tag')).toHaveAttribute('title', 'DLC: eigenständige Erweiterung, läuft ohne Hauptspiel');
  await expect(item('Halo').locator('.dlc-tag:visible')).toHaveCount(0);
});

test('the catalog search lets an add-on be wished', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInToFixture(page);
  await page.route('**/api/v1/catalog/search*', route => route.fulfill({ json: { games: [dlc(4, 'Forza Horizon 5: Hot Wheels')], cached: false } }));
  await page.getByRole('banner').getByRole('button', { name: 'Spiel hinzufügen', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Spiel hinzufügen', exact: true });
  await dialog.getByLabel('Spiel im Katalog suchen').fill('hot wheels');
  await expect(dialog.locator('.kind-badge')).toHaveText('DLC / Zusatzinhalt');
  await expect(dialog).toContainText('DLC · zählt mit DLC-Keys der Shops, das Hauptspiel ist nötig');
  await expect(dialog.getByRole('button', { name: /^Forza Horizon 5: Hot Wheels.* vormerken$/ }).first()).toBeEnabled();
});
