// Favicon comparison sheet: every icon at real tab size (16 px at 1x, 32 px at 2x) on light and dark tab bars, plus an
// 8x pixel zoom of the 16 px raster. Usage: node favicon-compare.mjs <public-dir> <variants-dir> <out-dir>
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const [pub, variants, out] = process.argv.slice(2);
const require = createRequire('/home/sysadmin16/projects/keyhunter/work/publication/keyhunter/frontend/package.json');
const { chromium } = require('@playwright/test');
const dataUrl = async (file, type) => `data:${type};base64,${(await readFile(file)).toString('base64')}`;

const sets = [
  { name: 'Heute: favicon.svg (Chrome/Firefox wählen es, auch bei 16 px)', s16: await dataUrl(`${pub}/favicon.svg`, 'image/svg+xml'), s32: await dataUrl(`${pub}/favicon.svg`, 'image/svg+xml') },
  { name: 'Heute: favicon-16.png / favicon-32.png (nur ICO/PNG-Pfad, von Chrome nicht gewählt)', s16: await dataUrl(`${pub}/favicon-16.png`, 'image/png'), s32: await dataUrl(`${pub}/favicon-32.png`, 'image/png') },
  { name: 'Variante A „Kopf betont“', s16: await dataUrl(`${variants}/a-16.svg`, 'image/svg+xml'), s32: await dataUrl(`${variants}/a-32.svg`, 'image/svg+xml') },
  { name: 'Variante B „Loch und Keil“', s16: await dataUrl(`${variants}/b-16.svg`, 'image/svg+xml'), s32: await dataUrl(`${variants}/b-32.svg`, 'image/svg+xml') },
  { name: 'Variante C „Gehängt“ (35°)', s16: await dataUrl(`${variants}/c-16.svg`, 'image/svg+xml'), s32: await dataUrl(`${variants}/c-32.svg`, 'image/svg+xml') },
];
const bars = [
  { name: 'Chrome hell', bar: '#dee1e6', tab: '#ffffff', text: '#1f1f1f' },
  { name: 'Chrome dunkel', bar: '#1f1f1f', tab: '#3c3c3c', text: '#e3e3e3' },
  { name: 'Firefox dunkel', bar: '#1c1b22', tab: '#42414d', text: '#fbfbfe' },
];
const html = `<!doctype html><meta charset="utf-8"><style>
  body { margin: 0; padding: 20px 24px; background: #f4f4f4; font: 13px/1.4 system-ui, sans-serif; color: #222; width: 1160px; }
  h1 { font-size: 16px; margin: 0 0 4px; } p { margin: 0 0 14px; color: #555; }
  .row { display: grid; grid-template-columns: 290px repeat(3, 190px) 150px 90px; gap: 12px; align-items: center; padding: 10px 0; border-top: 1px solid #ddd; }
  .name { font-weight: 600; font-size: 12px; }
  .bar { height: 40px; display: flex; align-items: flex-end; padding: 0 8px; border-radius: 6px; }
  .tab { height: 32px; display: flex; align-items: center; gap: 8px; padding: 0 12px; border-radius: 8px 8px 0 0; font-size: 12px; }
  .tab img { width: 16px; height: 16px; display: block; }
  canvas { image-rendering: pixelated; display: block; }
  .zoom { display: flex; gap: 10px; align-items: center; }
  .hd img { width: 32px; height: 32px; display: block; }
  .head { font-size: 11px; color: #666; }
</style>
<h1>KeyHunter-Favicon im Tab: Ursache der „1“ und Varianten</h1>
<p>Spalten 2–4: echte Größe 16 px (1x-Monitor) auf typischen Tableisten. Spalte 5: 16-px-Raster 8-fach vergrößert. Spalte 6: 32 px (HiDPI-Tab, 2x).</p>
<div class="row head"><span></span>${bars.map(b => `<span>${b.name}</span>`).join('')}<span>16 px, 8x</span><span>32 px</span></div>
${sets.map((s, i) => `<div class="row"><span class="name">${s.name}</span>
  ${bars.map(b => `<div class="bar" style="background:${b.bar}"><div class="tab" style="background:${b.tab};color:${b.text}"><img src="${s.s16}">KeyHunter</div></div>`).join('')}
  <div class="zoom"><canvas id="z${i}" width="128" height="128" data-src="${s.s16}"></canvas></div>
  <div class="hd"><img src="${s.s32}"></div></div>`).join('')}
<script>
  window.done = Promise.all([...document.querySelectorAll('canvas')].map(c => new Promise(res => {
    const img = new Image(); img.onload = () => {
      const small = document.createElement('canvas'); small.width = 16; small.height = 16;
      small.getContext('2d').drawImage(img, 0, 0, 16, 16);
      const ctx = c.getContext('2d'); ctx.imageSmoothingEnabled = false; ctx.drawImage(small, 0, 0, 128, 128); res();
    }; img.src = c.dataset.src;
  })));
</script>`;
await writeFile(`${out}/favicon-compare.html`, html);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1210, height: 400 }, deviceScaleFactor: 1 });
await page.setContent(html);
await page.evaluate(() => window.done);
await page.screenshot({ path: `${out}/favicon-compare.png`, fullPage: true });
// A real-size strip at 2x as well (what a HiDPI tab shows)
const page2 = await browser.newPage({ viewport: { width: 1210, height: 400 }, deviceScaleFactor: 2 });
await page2.setContent(html);
await page2.evaluate(() => window.done);
await page2.screenshot({ path: `${out}/favicon-compare-2x.png`, fullPage: true });
// Unraid and app icon at the sizes Unraid shows (Docker tab ~48 px, dashboard ~32 px) on its dark and light theme
const app = await dataUrl(`${pub}/keyhunter-appicon-512.png`, 'image/png');
const apple = await dataUrl(`${pub}/apple-touch-icon.png`, 'image/png');
const unraid = `<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:16px;font:12px system-ui;display:flex;gap:16px;background:#eee}
  .t{padding:12px 16px;border-radius:6px;display:grid;gap:8px} .r{display:flex;gap:14px;align-items:center}</style>
  ${[['Unraid dunkel', '#1c1c1c', '#f2f2f2'], ['Unraid hell', '#f2f2f2', '#1c1c1c']].map(([n, bg, fg]) => `<div class="t" style="background:${bg};color:${fg}"><b>${n}</b><div class="r">
  <img src="${app}" width="48" height="48"><img src="${app}" width="32" height="32"><img src="${app}" width="24" height="24"><span>keyhunter-appicon-512.png bei 48/32/24 px</span></div></div>`).join('')}
  <div class="t" style="background:#fff"><b>iOS / PWA</b><div class="r"><img src="${apple}" width="60" height="60" style="border-radius:13px"><img src="${await dataUrl(`${pub}/keyhunter-appicon-192.png`, 'image/png')}" width="48" height="48"><span>apple-touch 180 (iOS rundet), Manifest 192</span></div></div>`;
const page3 = await browser.newPage({ viewport: { width: 1210, height: 120 }, deviceScaleFactor: 1 });
await page3.setContent(unraid);
await page3.waitForTimeout(300);
await page3.screenshot({ path: `${out}/appicon-unraid.png`, fullPage: true });
await browser.close();
console.log('ok');
