import { test, expect } from '@playwright/test';
import { fetchBudget, saveButton, saveSettings, signInToFixture, navTo, navItem } from './helpers';

const now = () => Math.floor(Date.now() / 1000);
const fetchStatus = () => ({
  shops: [
    {
      source: 'eneba',
      enabled: true,
      last_success_at: now() - 60,
      last_error: null,
      paused_until: null,
      budget: fetchBudget({ used: 64, limit: 120, demand_per_day: 90 }),
      backlog: { due: 14, requested: 3, products: 9, searches: 5 },
      oldest_due_at: now() - 1500,
      next_due_at: now() + 900,
      worker_seen_at: now() - 2,
    },
    {
      source: 'driffle',
      enabled: true,
      last_success_at: now() - 7200,
      last_error: 'rate_limited',
      paused_until: now() + 2400,
      budget: fetchBudget({ used: 41, limit: 120 }),
      backlog: { due: 6, requested: 0, products: 4, searches: 2 },
      oldest_due_at: now() - 5400,
      next_due_at: now() + 3200,
      worker_seen_at: now() - 1,
    },
  ],
  errors_24h: 5,
  recent_runs: [
    { source: 'eneba', kind: 'product', wish_id: null, link_id: 1, started_at: now() - 40, duration_ms: 1180, outcome: 'ok', detail: 'Forza Horizon 5' },
    {
      source: 'driffle',
      kind: 'search',
      wish_id: 'a'.repeat(32),
      link_id: null,
      started_at: now() - 300,
      duration_ms: 210,
      outcome: 'rate_limited',
      detail: null,
    },
    { source: 'eneba', kind: 'discovery', wish_id: null, link_id: null, started_at: now() - 900, duration_ms: 8300, outcome: 'ok', detail: null },
  ],
});

test('settings sections are bound to the URL, and Abrufstatus shows queue, budget, pauses and recent runs', async ({ page }) => {
  await page.route('**/api/v1/status/fetch', route => route.fulfill({ json: fetchStatus() }));
  // 0.8.3: the runs come page by page with their game.
  await page.route('**/api/v1/status/fetch/runs?*', route =>
    route.fulfill({
      json: {
        runs: fetchStatus().recent_runs.map((run, id) => ({ ...run, id, game: id === 1 ? 'Starfield' : null, region: null })),
        total: 3,
        page: 1,
        per_page: 50,
      },
    }),
  );
  await signInToFixture(page);
  await navTo(page, 'Allgemein');
  // The sidebar group "Einstellungen" lists the sections; the open one is the current page and named in the breadcrumbs.
  const crumbs = page.getByRole('navigation', { name: 'Pfad' });
  await expect(navItem(page, 'Allgemein')).toHaveAttribute('aria-selected', 'true');
  await expect(crumbs).toHaveText(/Einstellungen.*Allgemein/);
  await navTo(page, 'Benachrichtigungen');
  await expect(page).toHaveURL(/section=notifications/);
  await expect(page.getByRole('heading', { name: 'Einstellungen', level: 1 })).toBeVisible();
  await expect(navItem(page, 'Benachrichtigungen')).toHaveAttribute('aria-selected', 'true');
  await navTo(page, 'System');
  await expect(navItem(page, 'System')).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(/section=system/);
  await page.goBack();
  await expect(page).toHaveURL(/section=notifications/);
  await expect(navItem(page, 'Benachrichtigungen')).toHaveAttribute('aria-selected', 'true');
  await navTo(page, 'Abrufstatus');
  await expect(page).toHaveURL(/section=status/);
  // Per shop: state pill, today's fetches, budget; a pause or error gets its own line.
  const eneba = page.getByRole('article', { name: 'Abrufstatus Eneba' });
  await expect(eneba).toContainText('Läuft');
  await expect(eneba).toContainText('64 von 120 Abrufen');
  await expect(eneba).toContainText('in 15 Min.');
  await expect(eneba.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '64');
  await expect(eneba.locator('.need')).toHaveCount(1);
  await expect(eneba).toContainText('Bedarf ≈ 90 pro Tag');
  const driffle = page.getByRole('article', { name: 'Abrufstatus Driffle' });
  await expect(driffle).toContainText('Pausiert bis');
  await expect(driffle).toContainText('Abruflimit erreicht');
  const runs = page.getByRole('table', { name: 'Letzte Abrufe' });
  await expect(runs.getByRole('row')).toHaveCount(4);
  await expect(runs.getByRole('columnheader')).toHaveText(['Zeit', 'Shop', 'Art', 'Spiel', 'Gefunden', 'Ergebnis']);
  await expect(runs.getByRole('row').nth(2)).toContainText('Starfield');
  await expect(runs.getByRole('row').nth(1)).toContainText('Forza Horizon 5');
  await expect(runs.getByRole('row').nth(1)).toContainText('1,2 s');
  await expect(runs.getByRole('row').nth(2)).toContainText('Abruflimit erreicht');
  await page.reload();
  await expect(navItem(page, 'Abrufstatus')).toHaveAttribute('aria-selected', 'true');
  await expect(crumbs).toHaveText(/Einstellungen.*Abrufstatus/);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('settings stay a draft until Speichern; an invalid fee is not sent, says so, and the page keeps the edit', async ({ page }) => {
  await signInToFixture(page);
  await navTo(page, 'Allgemein');
  await navTo(page, 'Key-Shops');
  const eneba = page.getByRole('article', { name: 'Eneba', exact: true });
  const fee = eneba.getByLabel('Geschätzte Gebühren (%)', { exact: true });
  const feeSwitch = eneba.getByRole('switch', { name: /Geschätzte Gebühren berücksichtigen/ });
  if (!(await feeSwitch.isChecked())) await feeSwitch.click();
  await saveSettings(page);
  let puts = 0;
  await page.route('**/api/v1/settings', route => {
    if (route.request().method() === 'PUT') puts += 1;
    return route.continue();
  });
  await fee.fill('abc');
  await expect(page.getByRole('status').filter({ hasText: 'Nicht gespeichert' })).toBeVisible();
  await page.waitForTimeout(900);
  expect(puts).toBe(0);
  await saveButton(page).click();
  await expect(page.getByRole('alert')).toContainText('Gebühren bitte als Zahl von 0 bis 100');
  expect(puts).toBe(0);
  await fee.fill('3,5');
  await saveSettings(page);
  expect(puts).toBe(1);
  await expect(fee).toHaveValue('3,50');
  await expect(page.getByRole('status').filter({ hasText: 'Gespeichert' })).toBeVisible();
  // Verwerfen returns to the saved state without a request.
  await feeSwitch.click();
  await page.getByRole('button', { name: 'Verwerfen', exact: true }).click();
  await expect(feeSwitch).toBeChecked();
  await expect(saveButton(page)).toBeDisabled();
  expect(puts).toBe(1);
  await feeSwitch.click();
  await saveSettings(page);
});

test('leaving the settings with unsaved changes asks to save, discard or go back', async ({ page }) => {
  await signInToFixture(page);
  await navTo(page, 'Key-Shops');
  const eneba = page.getByRole('article', { name: 'Eneba', exact: true });
  const interval = eneba.getByLabel('Produktseiten abfragen alle', { exact: true });
  const before = await interval.inputValue();
  const other = await interval
    .locator('option')
    .evaluateAll((options, value) => options.map(o => (o as HTMLOptionElement).value).find(v => v !== value)!, before);
  await interval.selectOption(other);
  // 0.7.4: shops are switched, not removed.
  await expect(eneba.getByRole('button', { name: 'Entfernen', exact: true })).toHaveCount(0);
  await navTo(page, 'Wunschliste');
  const dialog = page.getByRole('dialog', { name: 'Änderungen speichern?', exact: true });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/section=shops/);
  await expect(interval).toHaveValue(other);
  await navTo(page, 'Wunschliste');
  await dialog.getByRole('button', { name: 'Verwerfen', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await navTo(page, 'Key-Shops');
  await expect(interval).toHaveValue(before);
  await interval.selectOption(other);
  // 0.8.3: the settings button and the tab are two history entries; the second step back leaves the settings.
  await page.goBack();
  await expect(dialog).toBeHidden();
  await page.goBack();
  await dialog.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const saved = await (await page.request.get('/api/v1/settings')).json();
  expect(saved.sources.find((s: { id: string }) => s.id === 'eneba').poll_interval_seconds).toBe(Number(other));
  await navTo(page, 'Key-Shops');
  await interval.selectOption(before);
  await saveSettings(page);
});

test('a library entry can be removed after confirmation', async ({ page }) => {
  await signInToFixture(page);
  let rows = [
    {
      id: 'a'.repeat(32),
      game_id: 'a',
      platform_id: 169,
      created_at: 1,
      acquired_at: 1795107000,
      game: null,
      manual_title: 'Zelda',
      verification: 'manual_unverified',
    },
    {
      id: 'b'.repeat(32),
      game_id: 'b',
      platform_id: 49,
      created_at: 2,
      acquired_at: 1795108000,
      game: null,
      manual_title: 'Forza',
      verification: 'manual_unverified',
    },
  ];
  await page.route('**/api/v1/library', route => route.fulfill({ json: rows }));
  await page.route('**/api/v1/wishlist/*', route => {
    if (route.request().method() === 'DELETE') {
      rows = rows.filter(r => !route.request().url().endsWith(r.id));
      return route.fulfill({ status: 204 });
    }
    return route.continue();
  });
  await navTo(page, 'Bibliothek');
  const list = page.getByRole('list', { name: 'Meine Spiele' });
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await expect(list.getByRole('listitem').first().locator('.lib-info b')).toHaveText('Forza'); // newest purchase first, title only
  await page.getByRole('button', { name: 'Bearbeiten entsperren', exact: true }).click();
  await list.getByRole('button', { name: 'Zelda aus der Bibliothek entfernen', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Aus der Bibliothek entfernen?' });
  await dialog.getByRole('button', { name: 'Abbrechen', exact: true }).click();
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await list.getByRole('button', { name: 'Zelda aus der Bibliothek entfernen', exact: true }).click();
  await dialog.getByRole('button', { name: 'Entfernen bestätigen', exact: true }).click();
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await list.getByRole('button', { name: 'Forza aus der Bibliothek entfernen', exact: true }).click();
  await dialog.getByRole('button', { name: 'Entfernen bestätigen', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Noch keine Spiele in der Bibliothek' })).toBeVisible();
});

test('Abrufstatus shows pace, demand marker and, when the demand is above the limit, the value Key-Shops needs', async ({ page }) => {
  const budgets: Record<string, object> = {
    eneba: { used: 412, limit: 500, limit_source: 'setting', demand_per_day: 620, pace_seconds: 172, next_at: now() + 120, by_hour: Array(24).fill(17) },
    driffle: { used: 138, limit: 500, limit_source: 'default', demand_per_day: 160, pace_seconds: 180, next_at: now() + 600, by_hour: Array(24).fill(5) },
  };
  await page.route('**/api/v1/status/fetch', route => {
    const data = fetchStatus();
    data.shops = data.shops.map(shop => ({ ...shop, paused_until: null, last_error: null, budget: budgets[shop.source] as typeof shop.budget }));
    return route.fulfill({ json: data });
  });
  await signInToFixture(page);
  await navTo(page, 'Abrufstatus');
  const eneba = page.getByRole('article', { name: 'Abrufstatus Eneba' });
  await expect(eneba).toContainText('412 von 500 Abrufen · gleichmäßig verteilt, etwa alle 3 Min.');
  await expect(eneba).toContainText('Bedarf ≈ 620 pro Tag');
  await expect(eneba).toContainText('in 2 Min.');
  await expect(eneba.locator('.need')).toHaveAttribute('style', /left: 100%/);
  await expect(page.getByRole('article', { name: 'Abrufstatus Driffle' }).locator('.need')).toHaveAttribute('style', /left: 32(\.0)?%/);
  // Only Eneba needs more than its limit: one warning that names the value, with a way to Key-Shops.
  const notes = page.locator('[data-testid^="demand-note-"]');
  await expect(notes).toHaveCount(1);
  await expect(notes).toContainText('Eneba braucht etwa 620 Abrufe pro Tag, erlaubt sind 500.');
  await expect(notes).toContainText('mindestens 620');
  await notes.getByRole('button', { name: 'Zu den Key-Shops' }).click();
  await expect(page).toHaveURL(/section=shops/);
  await expect(navItem(page, 'Key-Shops')).toHaveAttribute('aria-selected', 'true');
  await page.setViewportSize({ width: 390, height: 844 });
  await navTo(page, 'Abrufstatus');
  await expect(notes).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('Abrufe pro Tag saves a valid number with the settings, keeps an invalid one as a local draft and empty restores the default', async ({ page }) => {
  const puts: { sources: { id: string; daily_jobs?: number | null }[] }[] = [];
  await page.route('**/api/v1/settings', route => {
    if (route.request().method() === 'PUT') puts.push(route.request().postDataJSON());
    return route.continue();
  });
  await signInToFixture(page);
  await navTo(page, 'Key-Shops');
  const eneba = page.getByRole('article', { name: 'Eneba', exact: true });
  const field = eneba.getByLabel('Abrufe pro Tag (höchstens)', { exact: true });
  await expect(field).toHaveValue('500');
  await expect(field).toHaveAttribute('placeholder', '500');
  await expect(eneba).toContainText('Standard: 500');
  await field.fill('12');
  await field.blur();
  await expect(eneba).toContainText('Bitte eine ganze Zahl von 20 bis 2000 eingeben.');
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await page.waitForTimeout(900);
  expect(puts).toHaveLength(0);
  await field.fill('750');
  await saveSettings(page);
  expect(puts).toHaveLength(1);
  expect(puts[0].sources.find(s => s.id === 'eneba')?.daily_jobs).toBe(750);
  // IGDB has no daily limit and keeps null.
  expect(puts[0].sources.find(s => s.id === 'igdb')?.daily_jobs ?? null).toBeNull();
  await field.blur();
  await page.reload();
  await expect(field).toHaveValue('750');
  await field.fill('');
  await saveSettings(page);
  expect(puts.at(-1)!.sources.find(s => s.id === 'eneba')?.daily_jobs).toBeNull();
  await field.blur();
  await expect(field).toHaveValue('500');
});
