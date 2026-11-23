import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mockPriceBadges, navTo, signInToFixture } from './helpers';

/** A write to the API as the page would send it (origin and CSRF token). */
async function write(page: Page, method: 'POST' | 'PUT' | 'DELETE', path: string, data?: object) {
  const { csrf_token: csrf } = await (await page.request.get('/api/v1/me')).json();
  return page.request.fetch(path, { method, data, headers: { 'X-CSRF-Token': csrf, Origin: new URL(page.url()).origin } });
}

// The suite shares one database: remove every wish again.
test.afterEach(async ({ page }) => {
  for (const item of await (await page.request.get('/api/v1/wishlist')).json()) await write(page, 'DELETE', `/api/v1/wishlist/${item.id}`);
});

test('a paused wish shows no search in progress and its detail is not polled every 3 s (CODE-01, PERF-02)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInToFixture(page);
  // The fixture runs no shop workers: the first search of a new wish stays pending.
  const id = (await (await write(page, 'POST', '/api/v1/wishlist', { igdb_id: 1001, platform_id: 169 })).json()).item.id;
  await page.goto(`/?item=${id}`);
  await expect(page.getByRole('main').getByText('Wird gesucht …', { exact: true })).toBeVisible();

  expect((await write(page, 'PUT', `/api/v1/wishlist/${id}/pause`, { paused: true })).ok()).toBe(true);
  const reads: string[] = [];
  page.on('request', request => {
    if (request.url().includes(`/wishlist/${id}/offers`)) reads.push(request.url());
  });
  await page.reload();
  await expect(page.locator('.pause-pill')).toHaveText('Abfragen pausiert, bis du sie fortsetzt');
  await expect(page.getByRole('main').getByText('Wird gesucht …', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('main').getByText('Kein Angebot', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: /^Angebote/ }).click();
  await expect(page.getByRole('main').getByText('Abrufe pausiert')).toBeVisible();
  await expect(page.getByRole('main').getByText('Suche eingeplant')).toHaveCount(0);
  const badge = (await (await page.request.get('/api/v1/wishlist/price-badges')).json())[id];
  expect([badge.pending, badge.refreshing]).toEqual([false, false]);
  // Without a fetch the owner triggered, the detail reloads every 60 s, not every 3 s.
  await page.waitForTimeout(7000);
  expect(reads).toHaveLength(1);
});

// PERF-02: a wish waiting in the backlog (pending, not refreshing) is re-read every 60 s, a fetch the owner triggered every 3 s.
for (const [name, refreshing] of [
  ['a backlog wish', false],
  ['a refreshing wish', true],
] as const) {
  test(`${name} polls the badges and the detail ${refreshing ? 'every 3 s' : 'every 60 s'} (PERF-02)`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInToFixture(page);
    const id = (await (await write(page, 'POST', '/api/v1/wishlist', { igdb_id: 1001, platform_id: 169 })).json()).item.id;
    const badge = { cents: null, state: 'unknown', observed_at: null, checked_at: null, stale: false, pending: true, refreshing };
    await mockPriceBadges(page, () => ({ [id]: badge }));
    await page.route(`**/api/v1/wishlist/${id}/offers`, async route => {
      if (route.request().method() !== 'GET') return route.continue();
      await route.fulfill({ json: { ...(await (await route.fetch()).json()), price_badge: badge } });
    });
    const reads = { badges: 0, offers: 0 };
    page.on('request', request => {
      if (/\/wishlist\/price-badges/.test(request.url())) reads.badges++;
      else if (request.url().includes(`/wishlist/${id}/offers`)) reads.offers++;
    });
    await page.clock.install();
    await page.goto(`/?item=${id}`);
    await expect(page.getByRole('main').getByText('Wird gesucht …', { exact: true })).toBeVisible();
    await expect.poll(() => reads.offers).toBeGreaterThan(0);
    const before = { ...reads };
    if (refreshing) {
      await page.clock.runFor(3500);
      await expect.poll(() => reads.badges).toBeGreaterThan(before.badges);
      await expect.poll(() => reads.offers).toBeGreaterThan(before.offers);
    } else {
      await page.clock.runFor(30000);
      await page.waitForTimeout(300);
      expect(reads).toEqual(before);
      await page.clock.runFor(32000);
      await expect.poll(() => reads.badges).toBeGreaterThan(before.badges);
      await expect.poll(() => reads.offers).toBeGreaterThan(before.offers);
    }
  });
}

const PASSPHRASE = 'browser test passphrase only';
const CHANGED = 'browser test passphrase changed';

test('the passphrase is changed in System and "Überall abmelden" ends every session after a confirmation (SEC-03)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInToFixture(page);
  await navTo(page, 'System');
  const form = page.getByRole('region', { name: 'Passphrase ändern' });
  const change = async (current: string, next: string, confirm = next) => {
    await form.getByLabel('Aktuelle Passphrase', { exact: true }).fill(current);
    await form.getByLabel('Neue Passphrase', { exact: true }).fill(next);
    await form.getByLabel('Neue Passphrase wiederholen', { exact: true }).fill(confirm);
    await form.getByRole('button', { name: 'Passphrase ändern', exact: true }).click();
  };
  try {
    await change(PASSPHRASE, CHANGED, `${CHANGED}!`);
    await expect(page.getByText('Die neuen Passphrasen stimmen nicht überein.')).toBeVisible();
    await change('not the passphrase', CHANGED);
    await expect(page.getByText('Die aktuelle Passphrase stimmt nicht.')).toBeVisible();
    await change(PASSPHRASE, CHANGED);
    await expect(page.getByText(/^Passphrase geändert/)).toBeVisible();
    await expect(form.getByLabel('Aktuelle Passphrase', { exact: true })).toHaveValue('');
    // This session stays.
    expect((await page.request.get('/api/v1/me')).ok()).toBe(true);
  } finally {
    await write(page, 'PUT', '/api/v1/session/passphrase', { current: CHANGED, new: PASSPHRASE });
  }

  await page.getByRole('button', { name: 'Überall abmelden', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Überall abmelden?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Abbrechen', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect((await page.request.get('/api/v1/me')).ok()).toBe(true);
  await page.getByRole('button', { name: 'Überall abmelden', exact: true }).click();
  await dialog.getByRole('button', { name: 'Überall abmelden', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Anmelden', exact: true })).toBeVisible();
  expect((await page.request.get('/api/v1/me')).status()).toBe(401);
  await signInToFixture(page);
});
