import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { wishlistHeading } from './detail-helpers';

/** Waits until the settings page reports that every change is stored (auto-save indicator). */
export async function expectSettingsSaved(page: Page) {
  await expect(page.getByRole('status').filter({ hasText: 'Alle Änderungen gespeichert' })).toBeVisible();
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
