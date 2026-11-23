import { test, expect } from '@playwright/test';
import { navTo, signInToFixture } from './helpers';

// The suite shares this browser's storage: forget the stored list views, so the defaults show.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) if (key.startsWith('keyhunter.list.')) localStorage.removeItem(key);
    sessionStorage.clear();
  });
});

test('the page sits right next to the sidebar on a wide window, with no gap in between', async ({ page }) => {
  await page.setViewportSize({ width: 2200, height: 1000 });
  await signInToFixture(page);
  const sidebar = (await page.getByRole('complementary', { name: 'Seitenleiste' }).boundingBox())!;
  const content = (await page.locator('.content > .page').first().boundingBox())!;
  // Only the 20 px padding of the content area, however wide the window (before: centred at 1320 px).
  expect(content.x - (sidebar.x + sidebar.width)).toBeLessThanOrEqual(21);
  expect(content.width).toBeGreaterThan(1320);
});

test('the log shows the full date with the year, and paged lists start with 25 per page', async ({ page }) => {
  await signInToFixture(page);
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) if (key.startsWith('keyhunter.list.')) localStorage.removeItem(key);
  });
  await navTo(page, 'Log');
  const table = page.getByRole('table', { name: 'Ereignisse', exact: true });
  await expect(table.getByRole('row').nth(1).getByRole('cell').first()).toHaveText(/^\d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}:\d{2}$/);
  await expect(page.getByLabel('Pro Seite', { exact: true })).toHaveValue('25');
  await navTo(page, 'Wunschliste');
  await expect(page.getByLabel('Pro Seite', { exact: true })).toHaveValue('25');
});

test('the switch of a box sits on the panel surface like the log filter, not on the inner surface', async ({ page }) => {
  await signInToFixture(page);
  const onPanel = async (name: string) => {
    const group = page.getByRole('tablist', { name, exact: true });
    await expect(group).toBeVisible();
    expect(await group.evaluate(node => [node.closest('.inset') === null, node.parentElement?.classList.contains('box-tools')])).toEqual([true, true]);
  };
  await navTo(page, 'Key-Shops');
  await onPanel('Key-Shops');
  await navTo(page, 'Benachrichtigungen');
  await onPanel('Benachrichtigungskanäle');
  await navTo(page, 'Allgemein');
  await onPanel('Tabelle');
  // A switch that stays on an inner surface takes the darker panel colour, so it does not melt into it.
  const colours = await page
    .locator('.col-panel .seg')
    .first()
    .evaluate(node => [getComputedStyle(node).backgroundColor, getComputedStyle(node.closest('.inset')!).backgroundColor]);
  expect(colours[0]).not.toBe(colours[1]);
});

test('the library is a box like the wishlist: tools in its head, the games inside', async ({ page }) => {
  await signInToFixture(page);
  await page.route('**/api/v1/library', route =>
    route.fulfill({
      json: ['Halo Infinite', 'Lies of P'].map((name, n) => ({
        id: String(n + 1).padStart(32, '0'),
        game_id: null,
        platform_id: 169,
        created_at: n,
        acquired_at: 1795107000,
        verification: 'manual_unverified',
        game: null,
        manual_title: name,
      })),
    }),
  );
  await navTo(page, 'Bibliothek');
  const box = page.getByRole('region', { name: 'Gekaufte Spiele', exact: true });
  await expect(box.getByRole('list', { name: 'Meine Spiele' }).getByRole('listitem')).toHaveCount(2);
  await expect(box.locator('.panel-head').getByRole('searchbox', { name: 'Bibliothek filtern' })).toBeVisible();
  await expect(box.locator('.panel-head').getByRole('radiogroup', { name: 'Bibliothek sortieren' })).toBeVisible();
  await expect(box.locator('.inset').getByRole('list', { name: 'Meine Spiele' })).toBeVisible();
  await box.getByRole('searchbox', { name: 'Bibliothek filtern' }).fill('zzz');
  await expect(box.getByText('Kein Spiel passt zu diesem Filter.')).toBeVisible();
});
