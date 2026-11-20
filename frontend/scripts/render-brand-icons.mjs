// Renders the raster brand icons from the approved SVGs in public/ with the installed Playwright (Chromium).
// Run: npm run brand:icons   (from frontend/). Output is committed next to the SVGs, so the build needs no browser.
//   favicon-16.png   16 x 16   optical 16 px variant (favicon-16.svg, no reticle)
//   favicon-32.png   32 x 32   primary mark (favicon.svg)
//   keyhunter-appicon-512.png  512 x 512  app icon (keyhunter-appicon.svg, rounded corners, transparent outside)
//   apple-touch-icon.png       180 x 180  same icon, full-bleed square without transparency (iOS rounds it itself)
import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const pub = new URL('../public/', import.meta.url);
const svg = name => readFile(new URL(name, pub), 'utf8');
const INK = '#090D12'; // matches --color-bg

const appicon = await svg('keyhunter-appicon.svg');
// Full-bleed variant for apple-touch: drop the rounded corners of the background tile.
const appleSvg = appicon.replace(/<rect width="64" height="64" rx="14" fill="(#[0-9A-Fa-f]+)"\/>/, '<rect width="64" height="64" fill="$1"/>');
if (appleSvg === appicon) throw new Error('appicon background rect not found');

const jobs = [
  { file: 'favicon-16.png', svg: await svg('favicon-16.svg'), size: 16, background: 'transparent' },
  { file: 'favicon-32.png', svg: await svg('favicon.svg'), size: 32, background: 'transparent' },
  { file: 'keyhunter-appicon-512.png', svg: appicon, size: 512, background: 'transparent' },
  { file: 'apple-touch-icon.png', svg: appleSvg, size: 180, background: INK },
];

const browser = await chromium.launch();
try {
  for (const job of jobs) {
    const page = await browser.newPage({ viewport: { width: job.size, height: job.size }, deviceScaleFactor: 1 });
    const html = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:${job.background}}svg{display:block;width:${job.size}px;height:${job.size}px}</style>${job.svg.replace(/<\?xml[^>]*>/, '')}`;
    await page.setContent(html);
    await writeFile(new URL(job.file, pub), await page.screenshot({ omitBackground: job.background === 'transparent', clip: { x: 0, y: 0, width: job.size, height: job.size } }));
    await page.close();
    console.log('wrote', fileURLToPath(new URL(job.file, pub)));
  }
} finally {
  await browser.close();
}
