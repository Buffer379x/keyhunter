import { test, expect } from '@playwright/test';
import { signInToFixture } from './helpers';

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
  await page.getByRole('button', { name: 'Preisalarme', exact: true }).click();
  await page.keyboard.press('Control+k');
  await expect(input).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Preisalarme.' })).toBeVisible();
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
  await page.getByRole('button', { name: 'Auf der Wunschliste' }).click();
  await page.getByRole('button', { name: 'Entfernen bestätigen' }).click();
});

test('returning to wishlist after using search never reopens an add dialog', async ({ page }) => {
  await signInToFixture(page);
  await page.keyboard.press('Control+k');
  await page.keyboard.press('Escape');
  for (const name of ['Einstellungen', 'Preisalarme']) {
    await page.getByRole('button', { name, exact: true }).click();
    await page.getByRole('button', { name: /^Wunschliste/ }).click();
    await expect(page.getByRole('heading', { name: 'Meine Wunschliste' })).toBeVisible();
    await expect(page.getByRole('dialog')).not.toBeVisible();
  }
  await page.getByRole('button', { name: 'Spiel hinzufügen', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Spiel hinzufügen', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
});

test('settings fill the content width and typography is consistent across pages', async ({ page }) => {
  await signInToFixture(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  const family = await page.locator('.wishlist-head h1').evaluate(el => getComputedStyle(el).fontFamily);
  await page.getByRole('button', { name: 'Einstellungen', exact: true }).click();
  const dimensions = await page.locator('main').evaluate(el => {
    const rect = el.getBoundingClientRect();
    const styles = getComputedStyle(el);
    const form = el.querySelector('.settings-form')!.getBoundingClientRect();
    return { main: rect.width, available: innerWidth - rect.left, form: form.width, content: rect.width - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight) };
  });
  expect(dimensions.main).toBeCloseTo(dimensions.available, 0);
  expect(dimensions.form).toBeCloseTo(dimensions.content, 0);
  const settingsHeading = page.locator('.settings-card h2').first();
  const headingSize = await settingsHeading.evaluate(el => getComputedStyle(el).fontSize);
  const paragraphSize = await page.locator('.settings-card p').first().evaluate(el => getComputedStyle(el).fontSize);
  for (const el of [page.locator('.page-heading h1'), settingsHeading, page.getByLabel('Zielland', { exact: true }), page.getByRole('button', { name: 'Änderungen speichern' })]) {
    expect(await el.evaluate(el => getComputedStyle(el).fontFamily)).toBe(family);
  }
  await page.getByRole('button', { name: 'Preisalarme', exact: true }).click();
  expect(await page.locator('#channel-title').evaluate(el => getComputedStyle(el).fontSize)).toBe(headingSize);
  expect(await page.locator('.offer-section p').first().evaluate(el => getComputedStyle(el).fontSize)).toBe(paragraphSize);
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
