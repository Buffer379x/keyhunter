import type { Page } from '@playwright/test';

/** Remove the open game from the wishlist through the "⋯" menu and confirm. */
export async function removeCurrent(page: Page) {
  await page.getByRole('button', { name: 'Weitere Aktionen' }).click();
  await page.getByRole('menuitem', { name: 'Von Wunschliste entfernen' }).click();
  await page.getByRole('button', { name: 'Entfernen bestätigen' }).click();
}
/** Open the edition picker in the game header. */
export async function openEditionPicker(page: Page) {
  await page.locator('button.gd-edition').click();
}
/** The wishlist heading (h1), also the target of focus after a removal. */
export const wishlistHeading = (page: Page) => page.getByRole('heading', { name: 'Wunschliste', level: 1, exact: true });
/** Switch the detail tab by its visible name. */
export async function openTab(page: Page, name: string) {
  await page.getByRole('tab', { name: new RegExp(`^${name}`) }).click();
}
