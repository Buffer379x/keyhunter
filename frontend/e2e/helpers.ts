import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { wishlistHeading } from './detail-helpers';

/** The save button in the head of the settings page (changes stay a draft until it is pressed). */
export const saveButton = (page: Page) => page.locator('.set-save').getByRole('button', { name: 'Speichern', exact: true });
/** Saves the settings draft with the button (if anything is unsaved) and waits until the server confirmed it. */
export async function saveSettings(page: Page) {
  const button = saveButton(page);
  if (await button.isEnabled()) await button.click();
  await expect(button).toBeDisabled();
  await expect(page.locator('.set-save')).not.toContainText('Nicht gespeichert');
}

export async function signInToFixture(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: /^(Privaten Bereich einrichten|Anmelden)$/ })).toBeVisible();
  const setup = page.getByRole('button', { name: 'Privaten Bereich einrichten', exact: true });
  if (await setup.isVisible()) {
    const token = await readFile(`${process.env.KEYHUNTER_TEST_DATA_DIR ?? '../work/check/browser-data'}/bootstrap-token`, 'utf8');
    await page.getByLabel('Einrichtungscode', { exact: true }).fill(token.trim());
    await page.getByLabel('Passphrase', { exact: true }).fill('browser test passphrase only');
    await page.getByLabel('Passphrase wiederholen').fill('browser test passphrase only');
    // The suite checks German prices for the target country DE, whatever the browser locale suggests.
    const country = page.getByLabel('Zielland', { exact: true });
    if (await country.count()) await country.selectOption('DE');
    await setup.click();
  } else {
    await page.getByLabel('Passphrase', { exact: true }).fill('browser test passphrase only');
    await page.getByLabel('Passphrase', { exact: true }).press('Enter');
  }
  await expect(wishlistHeading(page)).toBeVisible();
}

/** Open the sidebar drawer when the layout has one (up to 900 px). */
export async function openDrawer(page: Page) {
  const menu = page.getByRole('button', { name: 'Menü öffnen', exact: true });
  if (await menu.isVisible()) await menu.click();
}
/** Click an entry of the sidebar navigation ("Wunschliste", "Preisalarme", "Allgemein", "Key-Shops", …), opening the drawer on narrow screens. */
export async function navTo(page: Page, name: string) {
  await openDrawer(page);
  await page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('button', { name, exact: true }).click();
}
/** The sidebar entry of a page or settings section (aria-current="page" when open). */
export const navItem = (page: Page, name: string) => page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('button', { name, exact: true });
/** "Abmelden" in the sidebar footer. */
export async function signOut(page: Page) {
  await openDrawer(page);
  await page.getByRole('complementary', { name: 'Seitenleiste' }).getByRole('button', { name: 'Abmelden', exact: true }).click();
}
/** The target country select of the open settings page (the sidebar has its own one). */
export const settingsCountry = (page: Page) => page.getByRole('main').getByLabel('Zielland', { exact: true });
