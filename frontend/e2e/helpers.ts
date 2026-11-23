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
async function openDrawer(page: Page) {
  const menu = page.getByRole('button', { name: 'Menü öffnen', exact: true });
  if (await menu.isVisible()) await menu.click();
}
/** The sidebar: a landmark, or a modal dialog while it is the open drawer (1.0, RESP-08). */
const sidebar = (page: Page) => page.getByRole('complementary', { name: 'Seitenleiste' }).or(page.getByRole('dialog', { name: 'Seitenleiste' }));
/** Tabs of the settings page (0.8.3; before, entries of the sidebar). */
const SETTINGS_TABS = ['Allgemein', 'Key-Shops', 'Spieleindex', 'Benachrichtigungen', 'Abrufstatus', 'Log', 'System'];
/** The symbol button "Einstellungen" below the fetch status in the sidebar. */
export const settingsButton = (page: Page) => sidebar(page).getByRole('button', { name: 'Einstellungen', exact: true });
/**
 * Go to a page of the sidebar navigation ("Wunschliste", "Preisalarme", …), opening the drawer on narrow screens; a settings
 * tab ("Allgemein", "Key-Shops", …) opens the settings with the sidebar button first and then picks the tab.
 */
export async function navTo(page: Page, name: string) {
  if (SETTINGS_TABS.includes(name)) {
    const tablist = page.getByRole('tablist', { name: 'Einstellungen', exact: true });
    if (!(await tablist.isVisible())) {
      await openDrawer(page);
      await settingsButton(page).click();
    }
    await tablist.getByRole('tab', { name, exact: true }).click();
    return;
  }
  await openDrawer(page);
  await page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('button', { name, exact: true }).click();
}
/** The sidebar entry of a page (aria-current="page" when open), or the tab of a settings section (aria-selected). */
export const navItem = (page: Page, name: string) =>
  SETTINGS_TABS.includes(name)
    ? page.getByRole('tablist', { name: 'Einstellungen', exact: true }).getByRole('tab', { name, exact: true })
    : page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('button', { name, exact: true });
/** "Abmelden" in the sidebar footer. */
export async function signOut(page: Page) {
  await openDrawer(page);
  await sidebar(page).getByRole('button', { name: 'Abmelden', exact: true }).click();
}
/** The target country select of the open settings page (the sidebar has its own one). */
export const settingsCountry = (page: Page) => page.getByRole('main').getByLabel('Zielland', { exact: true });
