import { test, expect } from '@playwright/test';
import { signInToFixture } from './helpers';
import { wishlistHeading } from './detail-helpers';

test('an IGDB ID in the add dialog finds that game first, next to the normal title results', async ({ page }) => {
  await signInToFixture(page);
  await expect(wishlistHeading(page)).toBeVisible();
  await page.getByRole('button', { name: 'Spiel hinzufügen', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Spiel hinzufügen', exact: true });
  const search = dialog.getByLabel('Spiel im Katalog suchen');
  await expect(search).toHaveAttribute('placeholder', /IGDB-ID/);
  await search.fill('igdb:1007');
  await expect(dialog.getByRole('status')).toContainText('3 Treffer');
  const results = dialog.getByRole('list', { name: 'Katalogtreffer' }).getByRole('listitem');
  await expect(results.first()).toContainText('Alter Treffer');
  await search.fill('1001');
  await expect(dialog.getByRole('status')).toContainText('2 Treffer'); // the ID game is also a title hit: listed once
  await expect(results.first()).toContainText('Forza Horizon 5');
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
});
