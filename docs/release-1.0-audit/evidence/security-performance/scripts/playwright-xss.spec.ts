// Throwaway audit check: stored HTML in a manual title renders as text. Deleted after the audit.
import { test, expect } from '@playwright/test';
const session = process.env.KH_SESSION ?? '';
const base = process.env.KEYHUNTER_E2E_BASE_URL ?? '';
test('HTML im manuellen Titel wird als Text dargestellt', async ({ page }) => {
  await page.context().addCookies([{ name: 'keyhunter_session', value: session, domain: new URL(base).hostname, path: '/', httpOnly: true, sameSite: 'Strict' }]);
  const dialogs: string[] = []; page.on('dialog', d => { dialogs.push(d.message()); void d.dismiss(); });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Wunschliste', exact: true })).toBeVisible();
  await page.getByPlaceholder('Spiel oder Shop filtern').fill('onerror');
  const cell = page.getByText('<img src=x onerror=alert(document.cookie)><script>alert(1)</script>', { exact: true });
  await expect(cell.first()).toBeVisible();
  await page.screenshot({ path: `${process.env.KH_SHOT}-xss.png`, clip: { x: 256, y: 260, width: 1000, height: 200 } });
  expect(await page.locator('img[src="x"]').count()).toBe(0);
  await page.waitForTimeout(500);
  expect(dialogs).toEqual([]);
  console.log('XSS-Probe: Titel als Text sichtbar, kein <img src=x>, keine Dialoge');
});
