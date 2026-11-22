// Throwaway audit check: console errors / CSP violations and request counts per view. Deleted after the audit.
import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
const session = process.env.KH_SESSION ?? '';
const base = process.env.KEYHUNTER_E2E_BASE_URL ?? '';
test('Konsole und Requests je Ansicht', async ({ page }) => {
  test.setTimeout(120000);
  await page.context().addCookies([{ name: 'keyhunter_session', value: session, domain: new URL(base).hostname, path: '/', httpOnly: true, sameSite: 'Strict' }]);
  const console_: string[] = []; page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console_.push(`${m.type()}: ${m.text().slice(0, 200)}`); });
  page.on('pageerror', e => console_.push(`pageerror: ${e.message.slice(0, 200)}`));
  const reqs: string[] = []; page.on('request', r => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/')) reqs.push(u.pathname); });
  const out: Record<string, unknown> = {};
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Wunschliste', exact: true })).toBeVisible();
  await page.waitForLoadState('networkidle');
  out.wishlist_api = [...reqs]; reqs.length = 0;
  // open first wish detail (offers)
  await page.locator('tbody tr').first().click();
  await page.waitForLoadState('networkidle'); await page.waitForTimeout(800);
  out.detail_api = [...reqs]; reqs.length = 0;
  await page.screenshot({ path: `${process.env.KH_SHOT}-detail.png` });
  // settings › Abrufstatus
  await page.getByRole('complementary', { name: 'Seitenleiste' }).getByRole('button', { name: 'Einstellungen', exact: true }).click();
  await page.getByRole('tablist', { name: 'Einstellungen', exact: true }).getByRole('tab', { name: 'Abrufstatus', exact: true }).click();
  await page.waitForLoadState('networkidle'); await page.waitForTimeout(800);
  out.status_api = [...reqs]; reqs.length = 0;
  out.status_dom_nodes = await page.evaluate(() => document.getElementsByTagName('*').length);
  await page.waitForTimeout(31000);
  out.status_polling_31s = [...reqs]; reqs.length = 0;
  out.console = console_;
  writeFileSync(process.env.KH_AUDIT_OUT ?? '/tmp/kh-console.json', JSON.stringify(out, null, 1));
});
