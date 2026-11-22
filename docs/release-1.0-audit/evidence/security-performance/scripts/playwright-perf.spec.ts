// Throwaway audit measurement (release-1.0 audit, security/performance). Deleted after the audit.
import { test, expect, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const OUT = process.env.KH_AUDIT_OUT ?? '/tmp/kh-audit-perf.json';
const session = process.env.KH_SESSION ?? '';
const base = process.env.KEYHUNTER_E2E_BASE_URL ?? '';
const results: Record<string, unknown> = {};

async function prepare(page: Page, perPage: number) {
  const host = new URL(base).hostname;
  await page.context().addCookies([{ name: 'keyhunter_session', value: session, domain: host, path: '/', httpOnly: true, sameSite: 'Strict' }]);
  await page.addInitScript(([pp]) => {
    try { localStorage.setItem('keyhunter.list.wishlist', JSON.stringify({ filter: 'alle', text: '', perPage: pp })); } catch { /* */ }
    (window as any).__cls = 0; (window as any).__lcp = 0; (window as any).__shifts = [];
    new PerformanceObserver(list => { for (const e of list.getEntries() as any[]) if (!e.hadRecentInput) { (window as any).__cls += e.value; (window as any).__shifts.push(Math.round(e.startTime)); } }).observe({ type: 'layout-shift', buffered: true });
    new PerformanceObserver(list => { for (const e of list.getEntries()) (window as any).__lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
  }, [perPage]);
}

async function measure(page: Page, label: string, perPage: number) {
  const requests: string[] = [];
  page.on('request', r => requests.push(new URL(r.url()).pathname));
  const dialogs: string[] = [];
  page.on('dialog', d => { dialogs.push(d.message()); void d.dismiss(); });
  await prepare(page, perPage);
  const t0 = Date.now();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Wunschliste', exact: true })).toBeVisible({ timeout: 30000 });
  await page.waitForLoadState('networkidle');
  const ready = Date.now() - t0;
  await page.waitForTimeout(1500);
  const metrics = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
    const res = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null;
    const byType: Record<string, { n: number; bytes: number }> = {};
    for (const r of res) { const k = r.initiatorType; byType[k] ??= { n: 0, bytes: 0 }; byType[k].n++; byType[k].bytes += r.transferSize || r.encodedBodySize; }
    const api = res.filter(r => r.name.includes('/api/')).map(r => ({ path: new URL(r.name).pathname + new URL(r.name).search, ms: Math.round(r.duration), bytes: r.encodedBodySize }));
    return {
      domContentLoaded_ms: Math.round(nav.domContentLoadedEventEnd), load_ms: Math.round(nav.loadEventEnd), fcp_ms: fcp && Math.round(fcp),
      lcp_ms: Math.round((window as any).__lcp), cls: Number(((window as any).__cls).toFixed(4)), shifts_at_ms: (window as any).__shifts,
      dom_nodes: document.getElementsByTagName('*').length, rows: document.querySelectorAll('tbody tr').length,
      js_heap_mb: (performance as any).memory ? Math.round((performance as any).memory.usedJSHeapSize / 1048576) : null,
      resources: res.length, by_type: byType, api,
    };
  });
  results[label] = { per_page: perPage, ready_ms: ready, requests_total: requests.length, dialogs, ...metrics };
  return requests;
}

test('Erstladen Wunschliste mit 500 Wünschen (50 pro Seite)', async ({ page }) => {
  test.setTimeout(180000);
  await measure(page, 'wishlist_50', 50);
  // XSS-Probe: der Titel mit HTML erscheint als Text, kein Dialog
  const xss = page.getByText('<img src=x onerror=alert(document.cookie)><script>alert(1)</script>', { exact: false });
  results.xss_text_visible = await xss.count();
  // Polling ueber 60 s im sichtbaren Tab
  const polled: Record<string, number> = {}; let bytes = 0;
  page.on('response', async r => { const p = new URL(r.url()).pathname; if (p.startsWith('/api/')) { polled[p] = (polled[p] ?? 0) + 1; try { bytes += (await r.body()).length; } catch { /* */ } } });
  await page.waitForTimeout(60000);
  results.polling_60s = { requests: polled, bytes };
  writeFileSync(OUT, JSON.stringify(results, null, 1));
});

test('Erstladen Wunschliste mit 500 Wünschen (200 pro Seite)', async ({ page }) => {
  test.setTimeout(120000);
  await measure(page, 'wishlist_200', 200);
  // Sortierwechsel: Zeit bis zur neuen Darstellung
  writeFileSync(OUT, JSON.stringify(results, null, 1));
});
