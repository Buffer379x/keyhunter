// Which favicon file does a real browser fetch for the tab? A static server that logs requests serves frontend/dist.
// Usage: node favicon-pick.mjs <dist-dir> <port>
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { createRequire } from 'node:module';
const [dist, port] = process.argv.slice(2);
const require = createRequire('/home/sysadmin16/projects/keyhunter/work/publication/keyhunter/frontend/package.json');
const { chromium, webkit } = require('@playwright/test');
const types = { '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.js': 'text/javascript', '.css': 'text/css' };
let log = [];
const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  log.push(path);
  // Serve index.html with the app script removed: only the head with its icon links matters.
  try {
    let body = await readFile(join(dist, path === '/' ? 'index.html' : path));
    if (path === '/') body = Buffer.from(body.toString().replace(/<script[^>]*><\/script>/g, '').replace(/<link rel="stylesheet"[^>]*>/g, ''));
    res.writeHead(200, { 'content-type': (path === '/' ? 'text/html' : types[extname(path)]) ?? 'application/octet-stream' }); res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(Number(port), '127.0.0.1', r));
for (const [name, type, opts] of [['chromium (new headless, full browser)', chromium, { channel: 'chromium' }], ['chromium headless shell', chromium, {}], ['webkit', webkit, {}]]) {
  for (const dpr of [1, 2]) {
    log = [];
    let browser;
    try { browser = await type.launch(opts); } catch (e) { console.log(name, 'launch failed', e.message.split('\n')[0]); continue; }
    const page = await browser.newPage({ deviceScaleFactor: dpr });
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForTimeout(3000);
    console.log(`${name} dpr ${dpr}: requests`, JSON.stringify(log));
    await browser.close();
  }
}
server.close();
