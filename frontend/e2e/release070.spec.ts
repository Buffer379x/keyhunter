import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { navTo, navItem, saveButton, signInToFixture } from './helpers';
import { backToList, openTab, removeCurrent } from './detail-helpers';

async function addForza(page: Page) {
  await page.getByRole('searchbox', { name: 'Nach Spielen suchen', exact: true }).fill('forza');
  await page.getByRole('region', { name: 'Suchergebnisse' }).getByRole('button', { name: 'Forza Horizon 5 vormerken', exact: true }).click();
  await expect(page).toHaveURL(/[?&]item=/);
}

test('the column order can be changed by drag and drop', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signInToFixture(page);
  await navTo(page, 'Allgemein');
  const list = page.getByRole('list', { name: 'Spaltenreihenfolge der Wunschliste', exact: true });
  const rows = list.getByRole('listitem');
  await expect(rows.first()).toContainText('Spiel (Cover und Titel)');
  await list.scrollIntoViewIfNeeded();
  // Drag "Details öffnen" (last) by its grip above the first row, in small steps like a real hand.
  const grip = rows.last().locator('.col-grip');
  const from = (await grip.boundingBox())!;
  const top = (await rows.first().boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await expect(rows.last()).toHaveClass(/held/);
  await page.mouse.move(from.x + from.width / 2, top.y + 2, { steps: 12 });
  await page.mouse.up();
  await expect(rows.first()).toContainText('Details öffnen');
  await expect(rows.nth(1)).toContainText('Spiel (Cover und Titel)');
  await expect(list.locator('li.held')).toHaveCount(0);
  // Part of the settings draft: nothing is stored before "Speichern".
  await expect(saveButton(page)).toBeEnabled();
  expect((await (await page.request.get('/api/v1/settings')).json()).wishlist_columns[0]).toBe('game');
  // Escape during a drag puts everything back.
  const second = (await rows.nth(1).locator('.col-grip').boundingBox())!;
  await page.mouse.move(second.x + second.width / 2, second.y + second.height / 2);
  await page.mouse.down();
  await page.mouse.move(second.x + second.width / 2, second.y + 200, { steps: 8 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(rows.nth(1)).toContainText('Spiel (Cover und Titel)');
  await page.getByRole('button', { name: 'Verwerfen', exact: true }).click();
  await expect(rows.first()).toContainText('Spiel (Cover und Titel)');
});

test('automatic checks can be paused and resumed on the Abrufstatus page', async ({ page }) => {
  await signInToFixture(page);
  await navTo(page, 'Abrufstatus');
  const panel = page.getByRole('region', { name: 'Automatische Abfragen', exact: true });
  await expect(panel).toContainText('Laufen');
  await panel.getByRole('button', { name: 'Abfragen pausieren', exact: true }).click();
  await expect(panel).toContainText('Pausiert seit');
  await expect(panel.getByRole('button', { name: 'Abfragen fortsetzen', exact: true })).toBeVisible();
  expect((await (await page.request.get('/api/v1/status/fetch')).json()).paused_at).toEqual(expect.any(Number));
  // The sidebar card and the wishlist tile say so at once.
  await expect(page.locator('.fetch-mini .fetch-row').first()).toContainText('pausiert');
  // A game added during the pause still gets its first search (a direct action of the owner).
  await addForza(page);
  await backToList(page);
  await expect(page.locator('.kpi').filter({ hasText: 'Abrufe heute' })).toContainText('pausiert');
  await navTo(page, 'Abrufstatus');
  await panel.getByRole('button', { name: 'Abfragen fortsetzen', exact: true }).click();
  await expect(panel).toContainText('Laufen');
  expect((await (await page.request.get('/api/v1/status/fetch')).json()).paused_at).toBeNull();
  await expect(page.locator('.fetch-mini .fetch-row').first()).not.toContainText('pausiert');
  await expect(navItem(page, 'Abrufstatus')).toHaveAttribute('aria-current', 'page');
  await navTo(page, 'Wunschliste');
  await page.locator('table.wl tbody tr').first().getByRole('button', { name: /^Details zu / }).click();
  await removeCurrent(page);
});

test('long facts wrap inside the Infos box and the description has a box of its own', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signInToFixture(page);
  await page.route(url => url.pathname === '/api/v1/wishlist', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const items = await response.json();
    for (const item of items) if (item.game) {
      item.game.aliases = ['Road 96: A Very Long Alternative Title For Testing', 'Road Ninety-Six Definitive Edition With Every Extra', 'ロード96'];
      item.game.platforms = ['PC (Microsoft Windows)', 'PlayStation 4', 'PlayStation 5', 'Xbox One', 'Xbox Series X|S', 'Nintendo Switch', 'Mac', 'Linux'].map((name, id) => ({ id, name }));
      item.game.summary = 'A procedural road-trip adventure. '.repeat(12);
    }
    await route.fulfill({ response, json: items });
  });
  await addForza(page);
  await page.reload();
  await openTab(page, 'Infos');
  const facts = page.locator('.info-facts');
  await expect(facts).toContainText('Nintendo Switch');
  for (const size of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(size);
    await expect.poll(() => facts.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    const panel = (await page.getByRole('region', { name: 'Infos', exact: true }).boundingBox())!;
    const list = (await facts.boundingBox())!;
    expect(list.x + list.width).toBeLessThanOrEqual(panel.x + panel.width + 1);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  const about = page.locator('.about-box');
  await expect(about).toContainText('Beschreibung');
  await expect(about).toContainText('procedural road-trip');
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await removeCurrent(page);
});
