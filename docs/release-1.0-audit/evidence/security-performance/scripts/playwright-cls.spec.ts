// Throwaway audit measurement: layout shift sources, XSS rendering, polling with pending badges. Deleted after the audit.
import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
const OUT = process.env.KH_AUDIT_OUT ?? '/tmp/kh-audit-cls.json';
const session = process.env.KH_SESSION ?? '';
const base = process.env.KEYHUNTER_E2E_BASE_URL ?? '';
const results: Record<string, unknown> = {};

test('Layout-Shift-Quellen, XSS-Darstellung und Polling', async ({ page }) => {
  test.setTimeout(150000);
  await page.context().addCookies([{ name: 'keyhunter_session', value: session, domain: new URL(base).hostname, path: '/', httpOnly: true, sameSite: 'Strict' }]);
  await page.addInitScript(() => {
    try { localStorage.setItem('keyhunter.list.wishlist', JSON.stringify({ filter: 'alle', text: '', perPage: 50 })); } catch { /* */ }
    (window as any).__shifts = [];
    const describe = (n: Node | null) => { const e = n as Element | null; if (!e || !e.tagName) return String(n?.nodeName); return `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).slice(0, 3).join('.') : ''}`; };
    new PerformanceObserver(list => { for (const e of list.getEntries() as any[]) if (!e.hadRecentInput) (window as any).__shifts.push({ at: Math.round(e.startTime), value: Number(e.value.toFixed(4)), sources: (e.sources ?? []).map((s: any) => ({ node: describe(s.node), from: [Math.round(s.previousRect.y), Math.round(s.previousRect.height)], to: [Math.round(s.currentRect.y), Math.round(s.currentRect.height)] })) }); }).observe({ type: 'layout-shift', buffered: true });
  });
  const dialogs: string[] = [];
  page.on('dialog', d => { dialogs.push(d.message()); void d.dismiss(); });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Wunschliste', exact: true })).toBeVisible({ timeout: 30000 });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);
  results.shifts = await page.evaluate(() => (window as any).__shifts);
  await page.screenshot({ path: `${process.env.KH_SHOT ?? '/tmp/kh'}-wishlist.png` });
  // Polling in a visible tab for 45 s
  const polled: Record<string, number> = {}; let bytes = 0;
  page.on('response', async r => { const p = new URL(r.url()).pathname; if (p.startsWith('/api/')) { polled[p] = (polled[p] ?? 0) + 1; try { bytes += (await r.body()).length; } catch { /* */ } } });
  await page.waitForTimeout(45000);
  results.polling_45s = { requests: polled, bytes };
  // XSS: the stored title with HTML must render as text and never run
  const box = page.getByRole('searchbox').first();
  results.searchboxes = await page.getByRole('searchbox').count();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Wunschliste', exact: true })).toBeVisible();
  const last = page.getByRole('button', { name: /Letzte Seite|Seite 10/ });
  if (await last.count()) await last.first().click();
  await page.waitForTimeout(800);
  results.xss_literal_text_count = await page.getByText('onerror=alert(document.cookie)', { exact: false }).count();
  results.xss_injected_img = await page.locator('img[src="x"]').count();
  results.dialogs = dialogs;
  writeFileSync(OUT, JSON.stringify(results, null, 1));
  void box;
});
