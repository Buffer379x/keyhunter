import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { signInToFixture } from './helpers';
import { openTab } from './detail-helpers';
import { clearWishlist, offers, prepareLayout, settle } from './layout-mocks';

// 1.1.5: the price arrow after the price and beside the green box, a key without a named platform, and the editions only
// the Xbox store lists.

test.afterEach(async ({ page }) => clearWishlist(page));

const row = (page: Page, title: string) => page.locator('table.wl tbody tr').filter({ hasText: title }).filter({ hasText: 'Standard Edition' });

test('the price arrow stands after the price and outside the green box of the target country', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await prepareLayout(page);
  await page.goto('/');
  await expect(row(page, 'Starfield')).toBeVisible();
  await settle(page);
  for (const cell of ['td.c-de', 'td.c-world']) {
    const target = row(page, 'Starfield').locator(cell);
    const [price, mark] = [await target.locator('.price').boundingBox(), await target.locator('.price-change').boundingBox()];
    expect(price!.x + price!.width, cell).toBeLessThanOrEqual(mark!.x);
  }
  // Indiana Jones: the target country is the cheapest worldwide, the arrow is beside the green box, not inside.
  const world = row(page, 'Indiana Jones').locator('td.c-world');
  const box = world.locator('.home-best');
  await expect(box).toBeVisible();
  await expect(box.locator('.price-change')).toHaveCount(0);
  const [area, mark] = [await box.boundingBox(), await world.locator('.price-change').boundingBox()];
  expect(area!.x + area!.width).toBeLessThanOrEqual(mark!.x);
  expect(Math.abs(area!.y + area!.height / 2 - (mark!.y + mark!.height / 2))).toBeLessThan(4);
});

test('a key the shop names no platform for can be confirmed by hand and says why', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const id = await prepareLayout(page);
  const unnamed = {
    ...offers.links.find(link => link.id === 11)!,
    review: 'pending',
    can_confirm: false,
    manual_allowed: true,
    mismatch: ['platform_unknown'],
    eligible: false,
    reasons: [],
    product: { name: 'Forza Horizon 5 XBOX LIVE Key AUSTRALIA', region: 'Australien', market: 'DE', activation: 'unknown', availability: 'in_stock' },
  };
  await page.route('**/api/v1/wishlist/*/offers', route =>
    route.request().method() === 'GET' ? route.fulfill({ json: { ...offers, links: [unnamed] } }) : route.continue(),
  );
  await page.goto(`/?item=${id}`);
  await openTab(page, 'Zuordnungen');
  await page.locator('.match').getByRole('button', { name: 'Prüfen', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Zuordnung prüfen', exact: true });
  await expect(dialog.getByRole('note')).toContainText('Der Shop nennt für diesen Key keine Plattform, laut Name ist es ein Xbox-Live-Key.');
  await expect(dialog).not.toContainText('nur für PC');
  await expect(dialog.getByRole('button', { name: 'Zuordnung bestätigen', exact: true })).toBeEnabled();
});

test('editions only the Xbox store lists get columns of their own, an edition it does not have says so', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signInToFixture(page);
  const { csrf_token: csrf } = await (await page.request.get('/api/v1/me')).json();
  const created = await page.request.post('/api/v1/wishlist', {
    data: { igdb_id: 1001, platform_id: 169 },
    headers: { 'X-CSRF-Token': csrf, Origin: new URL(page.url()).origin },
  });
  const id = (await created.json()).item.id;
  const observed_at = Math.floor(Date.now() / 1000);
  const base = { status: 'verified', observed_at, via: 'xbox' };
  await page.route('**/api/v1/catalog/games/*/edition-comparison*', route =>
    route.fulfill({
      json: {
        editions: [
          {
            ...base,
            igdb_id: 1001,
            source_url: 'https://www.xbox.com/de-de/games/store/-/9NKX70BBCDRN',
            items: [{ id: 'base', name: 'Forza Horizon 5' }],
            description: 'Grundspiel.',
          },
          { igdb_id: 1002, status: 'not_in_store', observed_at, source_url: null, items: [], description: 'Vage Beschreibung von IGDB.' },
          {
            ...base,
            igdb_id: 0,
            store_title: 'MASTER EDITION',
            source_url: 'https://www.xbox.com/de-de/games/store/-/9P2KC6XHHH03',
            items: [
              { id: 'base', name: 'Forza Horizon 5' },
              { id: 'pass', name: 'Season Pass' },
            ],
            description: 'Die MASTER EDITION enthält das Spiel und den Season Pass.',
          },
        ],
        fetched_at: 0,
        cached: false,
      },
    }),
  );
  await page.goto(`/?item=${id}`);
  await openTab(page, 'Editionen');
  const table = page.getByRole('table', { name: 'Editionsinhalte' });
  const header = table.getByRole('columnheader');
  await expect(header).toHaveCount(4);
  await expect(header.nth(3)).toHaveText('MASTER EDITIONnur im Xbox Store');
  const pass = table.getByRole('row', { name: /Season Pass/ }).getByRole('cell');
  await expect(pass.nth(0).getByRole('img', { name: 'Nicht in der belegten Inhaltsliste' })).toBeVisible();
  await expect(pass.nth(1).getByRole('img', { name: 'Nicht belegt' })).toHaveText('?');
  await expect(pass.nth(2).getByRole('img', { name: 'Enthalten' })).toBeVisible();
  const source = table.getByRole('row', { name: /Quelle/ }).getByRole('cell');
  await expect(source.nth(1)).toContainText('Nicht im Xbox Store, Beschreibung von IGDB');
  await expect(source.nth(2)).toContainText('Microsoft / Xbox');
  await expect(source.nth(2)).not.toContainText('über den Xbox Store gefunden');
  // The edition list above keeps the IGDB editions with their prices.
  await expect(page.locator('.ed-row')).toHaveCount(2);
});
