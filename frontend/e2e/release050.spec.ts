import { expect, test } from '@playwright/test';
import { signInToFixture, navTo } from './helpers';
import { removeCurrent, wishlistRows, wishlistTable } from './detail-helpers';

test('tablet opens the labeled navigation as a drawer and gives the selected game its own view in portrait', async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 1180 });
  await signInToFixture(page);
  // Up to 900 px the sidebar is a drawer behind the menu button; closed, its entries are not reachable.
  const navigation = page.getByRole('navigation', { name: 'Hauptnavigation' });
  const menu = page.getByRole('button', { name: 'Menü öffnen', exact: true });
  await expect(navigation).toBeHidden();
  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await expect(navigation.getByRole('button')).toHaveCount(9);
  await expect(navigation.getByRole('button', { name: 'Wunschliste', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('Escape');
  await expect(navigation).toBeHidden();
  await expect(menu).toBeFocused();
  await menu.click();
  await page.mouse.click(810, 600); // the scrim
  await expect(navigation).toBeHidden();

  await page.getByRole('searchbox', { name: 'Nach Spielen suchen', exact: true }).fill('forza');
  await page.getByRole('button', { name: 'Forza Horizon 5 vormerken', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Forza Horizon 5', exact: true, level: 2 })).toBeVisible();
  await expect(wishlistTable(page)).toBeHidden();
  await page.getByRole('button', { name: 'Zur Wunschliste', exact: true }).click();
  await expect(wishlistTable(page)).toBeVisible();
  await wishlistRows(page).first().click();
  await removeCurrent(page);
  await expect(page.getByRole('status').filter({ hasText: 'aus der Wunschliste entfernt' })).toBeVisible();
});

test('an alarm rule opens the editor and offers recover after a temporary read failure', async ({ page }) => {
  await signInToFixture(page);
  await page.getByRole('searchbox', { name: 'Nach Spielen suchen', exact: true }).fill('forza');
  await page.getByRole('button', { name: 'Forza Horizon 5 vormerken', exact: true }).click();
  await expect(page).toHaveURL(/[?&]item=/);
  await page.getByRole('button', { name: 'Preisalarm', exact: true }).click();
  await expect(page.getByLabel('Zielpreis',{exact:true})).toBeVisible();
  await page.getByLabel('Zielpreis',{exact:true}).fill('15,00');
  await page.getByRole('button', { name: 'Alarm anlegen' }).click();
  await expect(page.getByText('Alarmregel gespeichert.')).toBeVisible();
  await navTo(page, 'Preisalarme');
  await page.getByRole('link', { name: 'Forza Horizon 5', exact: true }).click();
  await expect(page.getByLabel('Zielpreis',{exact:true})).toHaveValue('15,00');

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
  await removeCurrent(page);
  await expect(page.getByRole('status').filter({ hasText: 'aus der Wunschliste entfernt' })).toBeVisible();
});
