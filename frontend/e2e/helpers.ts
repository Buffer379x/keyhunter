import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

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
  await expect(page.getByRole('heading', { name: 'Meine Wunschliste.' })).toBeVisible();
}
