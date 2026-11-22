const { chromium } = await import(process.argv[2] + '/node_modules/playwright/index.mjs');
const pub = process.argv[2] + '/public';
const fs = await import('node:fs');
const b64 = f => fs.readFileSync(`${pub}/${f}`).toString('base64');
const html = `<body style="margin:0;background:#dee1e6;font:13px sans-serif;padding:16px">
<div style="display:flex;gap:24px;align-items:end">
 <div>16 px PNG (x10)<br><img src="data:image/png;base64,${b64('favicon-16.png')}" style="width:160px;image-rendering:pixelated"></div>
 <div>32 px PNG (x5)<br><img src="data:image/png;base64,${b64('favicon-32.png')}" style="width:160px;image-rendering:pixelated"></div>
 <div>SVG at 16 px (x10)<br><canvas id="c" width="16" height="16" style="width:160px;image-rendering:pixelated"></canvas></div>
</div>
<p>Tab mock (real size):</p>
<div style="display:inline-flex;gap:8px;align-items:center;background:#fff;border-radius:8px 8px 0 0;padding:8px 12px">
 <img src="data:image/png;base64,${b64('favicon-16.png')}" width="16" height="16"><span>KeyHunter</span></div>
<div style="display:inline-flex;gap:8px;align-items:center;background:#35363a;color:#fff;border-radius:8px 8px 0 0;padding:8px 12px;margin-left:8px">
 <img src="data:image/png;base64,${b64('favicon-16.png')}" width="16" height="16"><span>KeyHunter</span></div>
<script>const i=new Image();i.onload=()=>document.getElementById('c').getContext('2d').drawImage(i,0,0,16,16);i.src='data:image/svg+xml;base64,${b64('favicon.svg')}';</script></body>`;
const browser = await chromium.launch(); const page = await browser.newPage({ deviceScaleFactor: 2 });
await page.setContent(html); await page.waitForTimeout(300);
await page.screenshot({ path: process.argv[3] }); await browser.close();
