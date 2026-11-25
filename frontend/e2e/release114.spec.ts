import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { signInToFixture } from './helpers';
import { openTab } from './detail-helpers';
import { clearWishlist, offers } from './layout-mocks';

// 1.1.4: a shop product belongs to one game of the list. The form warns before the add, the add is refused, and an
// assignment from before 1.1.4 that two games hold carries a warning mark beside the entry.

test.afterEach(async ({ page }) => clearWishlist(page));

const url = 'https://www.eneba.com/de/xbox-forza-horizon-5-premium-edition-xbox-series-x-s-xbox-one-xbox-live-key-global';

async function write(page: Page, method: 'POST', path: string, data: object) {
  const { csrf_token: csrf } = await (await page.request.get('/api/v1/me')).json();
  const response = await page.request.fetch(path, { method, data, headers: { 'X-CSRF-Token': csrf, Origin: new URL(page.url()).origin } });
  expect(response.ok(), `${method} ${path}`).toBe(true);
  return response.json().catch(() => null);
}

/** Forza Horizon 5 and its Premium Edition on the wishlist; returns their ids. */
async function twoWishes(page: Page) {
  await signInToFixture(page);
  const ids: string[] = [];
  for (const igdb_id of [1001, 1002]) ids.push((await write(page, 'POST', '/api/v1/wishlist', { igdb_id, platform_id: 169 })).item.id);
  return ids;
}

async function openMappings(page: Page, id: string) {
  await page.goto(`/?item=${id}`);
  await openTab(page, 'Zuordnungen');
}

test('a product link another game holds is refused with a warning before the add', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const [forza, premium] = await twoWishes(page);
  await write(page, 'POST', `/api/v1/wishlist/${forza}/offers`, { url });
  await openMappings(page, premium);
  const input = page.getByLabel('Produktlink von Eneba oder Driffle ergänzen');
  await input.fill(url);
  const warning = page.getByRole('alert').filter({ hasText: 'Doppelte Zuordnungen sind nicht möglich' });
  await expect(warning).toContainText('Dieses Produkt ist schon „Forza Horizon 5“ zugeordnet.');
  await expect(warning).toContainText('Lösche oder verwirf die Zuordnung dort zuerst.');
  await expect(page.getByRole('button', { name: 'Link prüfen' })).toBeDisabled();
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  // Another address clears the warning.
  await input.fill('https://www.eneba.com/de/xbox-forza-horizon-5-premium-edition-xbox-live-key-turkey');
  await expect(warning).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Link prüfen' })).toBeEnabled();
  // The game that holds it: "schon zugeordnet" there too.
  await openMappings(page, forza);
  await page.getByLabel('Produktlink von Eneba oder Driffle ergänzen').fill(url);
  await expect(page.getByRole('alert')).toContainText('Dieses Produkt ist „Forza Horizon 5“ schon zugeordnet. Doppelte Zuordnungen sind nicht möglich.');
});

test('an assignment two games hold carries a warning mark and counts on the Zuordnungen tab', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const [forza] = await twoWishes(page);
  const held = { wish_id: 'other', name: 'Forza Horizon 5 Premium Edition', platform_id: 169, state: 'wished' };
  const links = offers.links.map(link => ({ ...link, review: 'confirmed', assigned_elsewhere: link.id === 4 ? [held] : [] }));
  await page.route('**/api/v1/wishlist/*/offers', route =>
    route.request().method() === 'GET' ? route.fulfill({ json: { ...offers, links } }) : route.continue(),
  );
  await openMappings(page, forza);
  const entry = page.locator('.match').filter({ has: page.getByRole('img', { name: 'Doppelt zugeordnet' }) });
  await expect(entry).toHaveCount(1);
  await expect(entry).toContainText('Doppelt zugeordnet: dasselbe Produkt gehört auch zu „Forza Horizon 5 Premium Edition“.');
  await expect(page.getByRole('tab', { name: /Zuordnungen/ })).toContainText('1');
});

test('edition contents found on the Xbox store say so in "Quelle & Stand"', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const [forza] = await twoWishes(page);
  const entry = (igdb_id: number, via?: 'xbox') => ({
    igdb_id,
    status: 'verified',
    source_url: `https://www.xbox.com/de-de/games/store/-/9NKX70BBCDR${igdb_id % 10}`,
    observed_at: Math.floor(Date.now() / 1000),
    items: [{ id: 'base', name: 'Forza Horizon 5' }],
    description: 'Beschreibung aus dem Microsoft Store.',
    ...(via ? { via } : {}),
  });
  await page.route('**/api/v1/catalog/games/*/edition-comparison*', route =>
    route.fulfill({ json: { editions: [entry(1001), entry(1002, 'xbox')], fetched_at: 0, cached: false } }),
  );
  await page.goto(`/?item=${forza}`);
  await openTab(page, 'Editionen');
  const source = page.getByRole('table', { name: 'Editionsinhalte' }).getByRole('row', { name: /Quelle/ });
  await expect(source.getByRole('cell')).toHaveCount(2);
  await expect(source.getByRole('cell').nth(0)).not.toContainText('über den Xbox Store gefunden');
  await expect(source.getByRole('cell').nth(1)).toContainText('Microsoft / Xbox · über den Xbox Store gefunden');
});
