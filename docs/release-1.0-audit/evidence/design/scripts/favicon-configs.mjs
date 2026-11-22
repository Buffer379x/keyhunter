// Which icon does Chromium (full browser, new headless) fetch for the tab with different <link rel=icon> sets?
// Usage: node favicon-configs.mjs <public-dir> <port>
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { createRequire } from 'node:module';
const [pub, port] = process.argv.slice(2);
const require = createRequire('/home/sysadmin16/projects/keyhunter/work/publication/keyhunter/frontend/package.json');
const { chromium } = require('@playwright/test');
const types = { '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const configs = {
  'heute (0.9.1)': `<link rel="icon" href="/favicon.ico" sizes="16x16 32x32"><link rel="icon" href="/favicon.svg" type="image/svg+xml" sizes="any"><link rel="icon" href="/favicon-16.png" type="image/png" sizes="16x16"><link rel="icon" href="/favicon-32.png" type="image/png" sizes="32x32">`,
  'ohne SVG-Link': `<link rel="icon" href="/favicon.ico" sizes="16x16 32x32"><link rel="icon" href="/favicon-16.png" type="image/png" sizes="16x16"><link rel="icon" href="/favicon-32.png" type="image/png" sizes="32x32">`,
  'SVG ohne sizes=any': `<link rel="icon" href="/favicon.ico" sizes="16x16 32x32"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="icon" href="/favicon-16.png" type="image/png" sizes="16x16"><link rel="icon" href="/favicon-32.png" type="image/png" sizes="32x32">`,
  'nur PNG 16/32': `<link rel="icon" href="/favicon-16.png" type="image/png" sizes="16x16"><link rel="icon" href="/favicon-32.png" type="image/png" sizes="32x32">`,
};
let current = ''; let log = [];
const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0]; log.push(path);
  if (path === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<!doctype html><html><head><meta charset="utf-8"><title>KeyHunter</title>${current}</head><body>x</body></html>`); return; }
  try { const body = await readFile(join(pub, path)); res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' }); res.end(body); } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(Number(port), '127.0.0.1', r));
for (const [name, links] of Object.entries(configs)) for (const dpr of [1, 2]) {
  current = links; log = [];
  const browser = await chromium.launch({ channel: 'chromium' });
  const page = await browser.newPage({ deviceScaleFactor: dpr });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForTimeout(2500);
  console.log(`${name.padEnd(22)} dpr ${dpr}: ${log.filter(p => p !== '/').join(', ')}`);
  await browser.close();
}
server.close();
