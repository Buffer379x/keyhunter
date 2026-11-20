import { test, expect } from '@playwright/test';
import { signInToFixture } from './helpers';
import { removeCurrent, wishlistHeading } from './detail-helpers';

test('header search accepts text directly and selects a game from settings', async ({ page }) => {
  await signInToFixture(page);
  await page.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  const input = page.getByRole('searchbox', { name: 'Nach Spielen suchen', exact: true });
  await input.fill('forza');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  const results = page.getByRole('region', { name: 'Suchergebnisse' });
  await expect(results.getByRole('status')).toContainText('2 Treffer');
  await results.getByRole('button', { name: 'Forza Horizon 5 vormerken', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Forza Horizon 5', exact: true })).toBeVisible();
  await expect(results).not.toBeVisible();
  await expect(input).toHaveValue('');
  await page.getByRole('button', { name: 'Alarme', exact: true }).click();
  await page.keyboard.press('Control+k');
  await expect(input).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Preisalarme', exact: true })).toBeVisible();
  await input.fill('forza');
  await expect(results.getByRole('button', { name: 'Forza Horizon 5 öffnen', exact: true })).toBeVisible();
  await input.press('ArrowDown');
  await page.keyboard.press('Escape');
  await expect(results).not.toBeVisible();
  await expect(input).toBeFocused();
  await page.keyboard.press('Control+k');
  await expect(results).toBeVisible();
  await results.getByRole('button', { name: 'Forza Horizon 5 öffnen', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Forza Horizon 5', exact: true })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Vorgemerkte Spiele' }).getByRole('listitem')).toHaveCount(1);
  await removeCurrent(page);
});

test('returning to wishlist after using search never reopens an add dialog', async ({ page }) => {
  await signInToFixture(page);
  await page.keyboard.press('Control+k');
  await page.keyboard.press('Escape');
  for (const name of ['Einstellungen', 'Alarme']) {
    await page.getByRole('button', { name, exact: true }).click();
    await page.getByRole('button', { name: /^Wunschliste/ }).click();
    await expect(wishlistHeading(page)).toBeVisible();
    await expect(page.getByRole('dialog')).not.toBeVisible();
  }
  await page.getByRole('button', { name: 'Spiel hinzufügen', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Spiel hinzufügen', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
});

test('settings use the content width up to a readable maximum and share the app typography', async ({ page }) => {
  await signInToFixture(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  const family = await page.locator('.wishlist-head h1').evaluate(el => getComputedStyle(el).fontFamily);
  await page.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  const dimensions = await page.locator('main').evaluate(el => {
    const rect = el.getBoundingClientRect();
    const styles = getComputedStyle(el);
    const layout = el.querySelector('.settings-layout')!.getBoundingClientRect();
    return { main: rect.width, available: innerWidth - rect.left, layout: layout.width, content: rect.width - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight) };
  });
  // The settings use the content width up to a readable maximum (1240 px) and never overflow it.
  expect(dimensions.main).toBeCloseTo(dimensions.available, 0);
  expect(dimensions.layout).toBeCloseTo(Math.min(dimensions.content, 1240), 0);
  const settingsHeading = page.locator('.set-card h2').first();
  for (const el of [page.locator('.set-head h1'), settingsHeading, page.getByLabel('Zielland', { exact: true }), page.getByRole('tab', { name: 'Key-Shops', exact: true })]) {
    expect(await el.evaluate(el => getComputedStyle(el).fontFamily)).toBe(family);
  }
  await page.getByRole('button', { name: 'Alarme', exact: true }).click();
  expect(await page.locator('#channel-title').evaluate(el => getComputedStyle(el).fontFamily)).toBe(family);
  expect(await page.locator('.page-heading h1').evaluate(el => getComputedStyle(el).fontFamily)).toBe(family);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.getByRole('button', { name: 'Einstellungen', exact: true }).click();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('searchbox', { name: 'Nach Spielen suchen', exact: true }).fill('forza');
    const results = page.getByRole('region', { name: 'Suchergebnisse' });
    await expect(results.getByRole('listitem').first()).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(results).not.toBeVisible();
  }
});
