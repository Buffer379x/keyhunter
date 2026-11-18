import { test, expect } from '@playwright/test';
import { signInToFixture } from './helpers';

test('owner can set up, save service fees, use keyboard dialog, and log in again', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await signInToFixture(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: 'test-results/wishlist-desktop.png', fullPage: true });
  const savedCountryLabel = await page.locator('.target-pill').innerText();
  await page.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  await page.getByLabel('Zielland', { exact: true }).selectOption('FR');
  await page.getByRole('button', { name: /^Wunschliste/ }).click();
  await expect(page.locator('.target-pill')).toHaveText(savedCountryLabel);
  await page.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  await page.getByLabel('Zielland', { exact: true }).selectOption('DE');
  const eneba = page.getByRole('article', { name: 'Eneba' });
  await eneba.getByLabel('Geschätzte Gebühren berücksichtigen').check();
  await eneba.getByLabel('Geschätzte Gebühren (%)', { exact: true }).fill('2,50');
  await page.getByRole('button', { name: 'Änderungen speichern' }).click();
  await expect(page.getByRole('status')).toHaveText('Einstellungen gespeichert.');
  await page.reload();
  await page.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  await expect(page.getByLabel('Zielland', { exact: true })).toHaveValue('DE');
  await expect(eneba.getByLabel('Geschätzte Gebühren (%)', { exact: true })).toHaveValue('2,50');
  const help = page.getByRole('button', { name: 'Wie werden Gebühren behandelt?' });
  await help.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(help).toBeFocused();
  await page.locator('#main-content').focus();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'test-results/settings-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/settings-mobile.png', fullPage: true });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 320, height: 800 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Abmelden', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Anmelden', exact: true })).toBeVisible();
  await page.getByLabel('Passphrase', { exact: true }).fill('browser test passphrase only');
  await page.getByLabel('Passphrase', { exact: true }).press('Enter');
  await expect(page.getByRole('heading', { name: 'Meine Wunschliste' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('owner replaces and removes the IGDB credentials from settings', async ({ page }) => {
  await signInToFixture(page);
  await page.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  const igdb = page.getByRole('region', { name: 'IGDB-Zugang' });
  await igdb.getByLabel('Client-ID', { exact: true }).fill('browser-fixture-client');
  await igdb.getByLabel('Client Secret', { exact: true }).fill('browser-fixture-secret');
  const update = page.waitForRequest(r => r.url().endsWith('/settings/igdb') && r.method() === 'PUT');
  await igdb.getByRole('button', { name: 'IGDB-Zugang speichern' }).click();
  expect((await update).postDataJSON()).toEqual({
    client_id: 'browser-fixture-client', client_secret: 'browser-fixture-secret',
  });
  await expect(igdb.getByText('IGDB-Zugang gespeichert und geprüft.')).toBeVisible();
  await expect(igdb.getByLabel('Client Secret', { exact: true })).toHaveValue('');
  await page.reload();
  await expect(igdb.getByLabel('Client-ID', { exact: true })).toHaveValue('');
  await expect(igdb.getByLabel('Client Secret', { exact: true })).toHaveValue('');
  await igdb.getByRole('button', { name: 'IGDB-Zugang entfernen' }).click();
  await igdb.getByRole('button', { name: 'Entfernen bestätigen' }).click();
  await expect(igdb.getByText('Noch keine Zugangsdaten hinterlegt.')).toBeVisible();
});
