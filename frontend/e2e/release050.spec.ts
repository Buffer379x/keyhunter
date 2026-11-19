import { expect, test } from '@playwright/test';
import { signInToFixture } from './helpers';

test('tablet uses labeled navigation and gives the selected game its own view in portrait', async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 1180 });
  await signInToFixture(page);
  const navigation = page.getByRole('navigation', { name: 'Hauptnavigation' });
  const buttons = navigation.getByRole('button');
  await expect(buttons).toHaveCount(4);
  const first = await buttons.first().boundingBox();
  const last = await buttons.last().boundingBox();
  expect(first?.y).toBe(last?.y);

  await page.getByRole('searchbox').fill('forza');
  await page.getByRole('button', { name: 'Forza Horizon 5 vormerken', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Forza Horizon 5', exact: true, level: 2 })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Vorgemerkte Spiele' })).toBeHidden();
  await page.getByRole('button', { name: 'Zur Wunschliste', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Vorgemerkte Spiele' })).toBeVisible();
  await page.getByRole('list', { name: 'Vorgemerkte Spiele' }).getByRole('button').click();
  await page.getByRole('button', { name: 'Auf der Wunschliste' }).click();
  await page.getByRole('button', { name: 'Entfernen bestätigen' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'aus der Wunschliste entfernt' })).toBeVisible();
});

test('an alarm rule opens the editor and offers recover after a temporary read failure', async ({ page }) => {
  await signInToFixture(page);
  await page.getByRole('searchbox').fill('forza');
  await page.getByRole('button', { name: 'Forza Horizon 5 vormerken', exact: true }).click();
  await expect(page).toHaveURL(/[?&]item=/);
  await page.getByRole('button', { name: 'Preisalarm', exact: true }).click();
  await expect(page.getByLabel('Zielpreis (€)')).toBeVisible();
  await page.getByLabel('Zielpreis (€)').fill('15,00');
  await page.getByRole('button', { name: 'Alarm anlegen' }).click();
  await expect(page.getByText('Alarmregel gespeichert.')).toBeVisible();
  await page.getByRole('button', { name: 'Preisalarme', exact: true }).click();
  await page.getByRole('link', { name: 'Forza Horizon 5', exact: true }).click();
  await expect(page.getByLabel('Zielpreis (€)')).toHaveValue('15,00');

  let failed = false;
  await page.route('**/api/v1/wishlist/*/offers', route => {
    if (failed) return route.continue();
    failed = true;
    return route.fulfill({ status: 503, json: { error: 'Preisdaten vorübergehend nicht verfügbar.' } });
  });
  await page.clock.install();
  await page.reload();
  await expect(page.getByText('Preisdaten vorübergehend nicht verfügbar.')).toHaveCount(1);
  await page.clock.fastForward(11000);
  await expect(page.getByText('Preisdaten vorübergehend nicht verfügbar.')).toHaveCount(0);
  await page.getByRole('button', { name: 'Auf der Wunschliste' }).click();
  await page.getByRole('button', { name: 'Entfernen bestätigen' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'aus der Wunschliste entfernt' })).toBeVisible();
});
