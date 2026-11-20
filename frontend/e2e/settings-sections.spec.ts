import { test, expect } from '@playwright/test';
import { expectSettingsSaved, signInToFixture } from './helpers';

const now = () => Math.floor(Date.now() / 1000);
const fetchStatus = () => ({
  shops: [
    { source: 'eneba', enabled: true, last_success_at: now() - 60, last_error: null, paused_until: null, budget: { used: 64, limit: 120 }, backlog: { due: 14, requested: 3, products: 9, searches: 5 }, oldest_due_at: now() - 1500, next_due_at: now() + 900, worker_seen_at: now() - 2 },
    { source: 'driffle', enabled: true, last_success_at: now() - 7200, last_error: 'rate_limited', paused_until: now() + 2400, budget: { used: 41, limit: 120 }, backlog: { due: 6, requested: 0, products: 4, searches: 2 }, oldest_due_at: now() - 5400, next_due_at: now() + 3200, worker_seen_at: now() - 1 },
  ],
  errors_24h: 5,
  recent_runs: [
    { source: 'eneba', kind: 'product', wish_id: null, link_id: 1, started_at: now() - 40, duration_ms: 1180, outcome: 'ok', detail: 'Forza Horizon 5' },
    { source: 'driffle', kind: 'search', wish_id: 'a'.repeat(32), link_id: null, started_at: now() - 300, duration_ms: 210, outcome: 'rate_limited', detail: null },
    { source: 'eneba', kind: 'discovery', wish_id: null, link_id: null, started_at: now() - 900, duration_ms: 8300, outcome: 'ok', detail: null },
  ],
});

test('settings sections are bound to the URL, and Abrufstatus shows queue, budget, pauses and recent runs', async ({ page }) => {
  await page.route('**/api/v1/status/fetch', route => route.fulfill({ json: fetchStatus() }));
  await signInToFixture(page);
  await page.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  const tab = (name: string) => page.getByRole('tab', { name, exact: true });
  await expect(tab('Allgemein')).toHaveAttribute('aria-selected', 'true');
  await tab('Benachrichtigungen').click();
  await expect(page).toHaveURL(/section=notifications/);
  await tab('Abrufstatus').focus();
  await page.keyboard.press('ArrowDown');
  await expect(tab('System')).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(/section=system/);
  await tab('Abrufstatus').click();
  await expect(page).toHaveURL(/section=status/);
  await expect(page.getByText('Fehler in 24 h')).toBeVisible();
  await expect(page.getByRole('article', { name: 'Abrufstatus Eneba' })).toContainText('64 von 120');
  const driffle = page.getByRole('article', { name: 'Abrufstatus Driffle' });
  await expect(driffle).toContainText('Pausiert bis');
  await expect(driffle).toContainText('Abruflimit erreicht');
  await expect(driffle).toContainText('6 fällig · 0 angefordert · 4 Produkte · 2 Suchen');
  await expect(page.getByRole('table', { name: 'Letzte Abrufe' }).getByRole('row')).toHaveCount(4);
  await expect(page.getByText('Jeder Shop wird nacheinander abgefragt, mit Pause zwischen Anfragen und unter Beachtung von robots.txt.')).toBeVisible();
  await page.reload();
  await expect(tab('Abrufstatus')).toHaveAttribute('aria-selected', 'true');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('an invalid fee is not sent, says so, and the page keeps the edit', async ({ page }) => {
  await signInToFixture(page);
  await page.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  await page.getByRole('tab', { name: 'Key-Shops', exact: true }).click();
  const eneba = page.getByRole('article', { name: 'Eneba', exact: true });
  const fee = eneba.getByLabel('Geschätzte Gebühren (%)', { exact: true });
  const feeSwitch = eneba.getByRole('switch', { name: /Geschätzte Gebühren berücksichtigen/ });
  if (await feeSwitch.getAttribute('aria-checked') !== 'true') await feeSwitch.click();
  await expectSettingsSaved(page);
  let puts = 0;
  await page.route('**/api/v1/settings', route => { if (route.request().method() === 'PUT') puts += 1; return route.continue(); });
  await fee.fill('abc');
  await expect(page.getByRole('alert')).toContainText('Gebühren bitte als Zahl von 0 bis 100');
  await expect(page.getByRole('status').filter({ hasText: 'Nicht gespeichert' })).toBeVisible();
  expect(puts).toBe(0);
  await fee.fill('3,5');
  await expectSettingsSaved(page);
  expect(puts).toBe(1);
  await expect(fee).toHaveValue('3,50');
  await feeSwitch.click();
  await expectSettingsSaved(page);
});

test('a library entry can be removed after confirmation', async ({ page }) => {
  await signInToFixture(page);
  let rows = [
    { id: 'a'.repeat(32), game_id: 'a', platform_id: 169, created_at: 1, acquired_at: 1795107000, game: null, manual_title: 'Zelda', verification: 'manual_unverified' },
    { id: 'b'.repeat(32), game_id: 'b', platform_id: 49, created_at: 2, acquired_at: 1795108000, game: null, manual_title: 'Forza', verification: 'manual_unverified' },
  ];
  await page.route('**/api/v1/library', route => route.fulfill({ json: rows }));
  await page.route('**/api/v1/wishlist/*', route => { if (route.request().method() === 'DELETE') { rows = rows.filter(r => !route.request().url().endsWith(r.id)); return route.fulfill({ status: 204 }); } return route.continue(); });
  await page.getByRole('button', { name: 'Bibliothek', exact: true }).click();
  const list = page.getByRole('list', { name: 'Meine Spiele' });
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await expect(list.getByRole('listitem').first()).toContainText('Gekauft');
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
