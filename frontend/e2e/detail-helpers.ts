import type { Locator, Page } from '@playwright/test';

/** Remove the open game from the wishlist through the "⋯" menu and confirm. */
export async function removeCurrent(page: Page) {
  await page.getByRole('button', { name: 'Weitere Aktionen' }).click();
  await page.getByRole('menuitem', { name: 'Von Wunschliste entfernen' }).click();
  await page.getByRole('button', { name: 'Entfernen bestätigen' }).click();
}
/** The edition select in the game header; choosing an option opens that edition (saved one or preview). */
export const editionSelect = (page: Page) => page.getByRole('combobox', { name: 'Edition', exact: true });
/** Back to the list through the breadcrumb of the top bar (the detail has no back button of its own). */
export async function backToList(page: Page) {
  await page.getByRole('navigation', { name: 'Pfad' }).getByRole('button', { name: 'Wunschliste', exact: true }).click();
}
/** The wishlist heading (h1), also the target of focus after a removal. */
export const wishlistHeading = (page: Page) => page.getByRole('heading', { name: 'Wunschliste', level: 1, exact: true });
/** Switch the detail tab by its visible name. */
export async function openTab(page: Page, name: string) {
  await page.getByRole('tab', { name: new RegExp(`^${name}`) }).click();
}
/** The wishlist table (list page). */
export const wishlistTable = (page: Page) => page.getByRole('table', { name: 'Vorgemerkte Spiele', exact: true });
/** Rows of the wishlist table (one per game; cards when the list is narrow). */
export const wishlistRows = (page: Page) => wishlistTable(page).locator('tbody tr');
/** The details button of a wishlist row: the only way to open the game from the list (the row is not clickable). */
export const detailsButton = (row: Locator) => row.getByRole('button', { name: /^Details zu / });
/** Open a game from the wishlist table by its title (a string matches the whole title, a RegExp any part). */
export async function openWishlistRow(page: Page, name: string | RegExp) {
  const title = typeof name === 'string' ? new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) : name;
  await detailsButton(
    wishlistRows(page)
      .filter({ has: page.locator('.game-cell b').filter({ hasText: title }) })
      .first(),
  ).click();
}
