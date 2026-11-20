import { test, expect } from '@playwright/test';
import { expectSettingsSaved, signInToFixture, navTo, navItem } from './helpers';
import { openEditionPicker, openTab, openWishlistRow, removeCurrent, wishlistRows } from './detail-helpers';

test('settings separate key shops from games index and persist source intervals', async ({ page }) => {
  await signInToFixture(page);
  await navTo(page, 'Allgemein');
  await navTo(page, 'Key-Shops');
  await expect(navItem(page, 'Key-Shops')).toHaveAttribute('aria-current', 'page');
  const eneba = page.getByRole('article', { name: 'Eneba', exact: true });
  await expect(eneba.getByLabel('Abfrageintervall', { exact: true })).toHaveValue(String(8 * 3600));
  await expect(page.getByRole('region', { name: 'IGDB-Zugang' })).not.toBeVisible();
  await eneba.getByLabel('Abfrageintervall', { exact: true }).selectOption(String(2 * 3600));
  await expectSettingsSaved(page);
  await page.reload();
  await expect(eneba.getByLabel('Abfrageintervall', { exact: true })).toHaveValue(String(2 * 3600));
  await page.getByLabel('Shop-URL', { exact: true }).fill('https://www.gamivo.com');
  await page.getByRole('button', { name: 'Dienst hinzufügen', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('kein geprüfter Reader');
  await page.getByLabel('Shop-URL', { exact: true }).fill('https://driffle.com');
  await page.getByRole('button', { name: 'Dienst hinzufügen', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Driffle', exact: true })).toBeVisible();
  await page.getByRole('article', { name: 'Driffle', exact: true }).getByRole('button', { name: 'Entfernen', exact: true }).click();
  await page.getByRole('dialog', { name: 'Driffle entfernen?' }).getByRole('button', { name: 'Entfernen bestätigen', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Driffle', exact: true })).not.toBeVisible();
  await navTo(page, 'Spieleindex');
  await expect(page.getByRole('region', { name: 'IGDB-Zugang' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Editionsinhalte von Microsoft / Xbox' })).toBeVisible();
});

test('edition previews keep the saved version, offers keep price order and history connects scoped minima', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInToFixture(page);
  await page.getByRole('searchbox', { name: 'Nach Spielen suchen', exact: true }).fill('forza');
  await page.getByRole('region', { name: 'Suchergebnisse' }).getByRole('button', { name: 'Forza Horizon 5 vormerken', exact: true }).click();
  await expect(page.getByRole('heading', { name:'Forza Horizon 5',exact:true })).toBeVisible();
  await expect(page).toHaveURL(/[?&]item=[a-f0-9]{32}/);
  const originalUrl = page.url();
  const now = Math.floor(Date.now() / 1000), day = 86400;
  const link = (id: number, region: string, cents: number) => ({ id,source:'eneba',url:'https://www.eneba.com/de/xbox-fixture-key-global',review:'confirmed',can_confirm:true,eligible:region==='Global',queued:false,enabled:true,stale:false,observed_at:now-day,attempted_at:now-day,last_error:null,retry_at:0,product:{name:'Synthetic offer',region,market:'DE',activation:region==='Global'?'confirmed':'unknown',availability:'in_stock'},quotes:[{id:String(id),seller:'Synthetic seller',base_cents:cents,estimated_total_cents:null}] });
  const point = (at: number,cents: number,region: string) => ({ observed_at:at,base_cents:cents,link_id:1,region,source:'eneba' });
  await page.route('**/api/v1/wishlist/*/offers',route => route.request().method()==='GET' ? route.fulfill({json:{links:[link(1,'United States',1000),link(2,'USA',1100),link(3,'Global',900),link(4,'NA',1300),link(5,'North America',1400),{...link(6,'USA',1),can_confirm:false,review:'pending'}],history:[],histories:{preferred:[point(now-8*day,1400,'Global'),point(now-day,1200,'Global')],all:[point(now-8*day,1000,'India'),point(now-day,900,'Global')]},best_base:900,best_estimate:null,target_country:'DE',discovery_running:false,searches:[],sources:[]}}) : route.continue());
  await page.reload();
  await openTab(page, 'Angebote');
  const rows = page.getByRole('table', { name: 'Angebote nach Preis' }).locator('tbody tr');
  // Five prices and one product that still has to be reviewed, cheapest first; the review row has no price and comes last.
  await expect(rows).toHaveCount(6);
  await expect(rows.first()).toContainText('Global');
  await expect(rows.nth(1)).toContainText('Vereinigte Staaten');
  await expect(rows.nth(1)).toContainText('10,00');
  await expect(rows.last()).toContainText('Zuordnung prüfen');
  await expect(page.locator('.country-flag[title="Nordamerika"] img')).toHaveCount(0);
  const stamp = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' }).format((now - day) * 1000);
  await expect(rows.first().locator('time')).toHaveAttribute('title', new RegExp(stamp.replace(/\./g, '\\.')));
  await openEditionPicker(page);
  await page.getByRole('button', { name:/Premium Edition.*ansehen/ }).click();
  await expect(page.getByRole('heading', { name:'Forza Horizon 5: Premium Edition',exact:true })).toBeVisible();
  expect(await (await page.request.get('/api/v1/wishlist')).json()).toHaveLength(1);
  expect(new URL(page.url()).searchParams.get('item')).toBe(new URL(originalUrl).searchParams.get('item'));
  await openEditionPicker(page);
  await expect(page.locator('.edition-row').filter({hasText:'Standard Edition'})).toContainText('Gemerkt');
  await expect(page.locator('.edition-row').filter({hasText:'Premium Edition'})).toContainText('Vorschau');
  await page.keyboard.press('Escape');
  await openTab(page, 'Verlauf');
  await expect(page.locator('.series-preferred path.history-line')).toHaveAttribute('d',/L/);
  // Both series are always visible: target country and all countries.
  await expect(page.locator('.history-series')).toHaveCount(2);
  await expect(page.locator('.history-caption .series-all')).toContainText('9,00');
  await expect(page.locator('.history-caption .series-preferred')).toContainText('12,00');
  await expect(page.locator('circle.history-point title').first()).toContainText('Indien');
  await openTab(page, 'Editionen');
  await expect(page.getByRole('table', { name:'Editionsinhalte',exact:true })).toBeVisible();
  await expect(page.getByRole('rowheader', { name:'Zusatzpaket',exact:true })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Angebote nach Preis' })).toHaveCount(0);
  await page.getByRole('button', { name:'Zur gemerkten Edition',exact:true }).click();
  await expect(page.getByRole('heading', { name:'Forza Horizon 5',exact:true })).toBeVisible();
  await removeCurrent(page);
});

test('wishlist sorting uses date, price, saving and target distance and survives reload', async ({ page }) => {
  await signInToFixture(page);
  const input=page.getByRole('searchbox',{name:'Nach Spielen suchen',exact:true});
  await input.fill('forza');
  await page.getByRole('region',{name:'Suchergebnisse'}).getByRole('button',{name:'Forza Horizon 5 vormerken',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Forza Horizon 5',exact:true})).toBeVisible();
  await input.fill('neu');
  await page.getByRole('region',{name:'Suchergebnisse'}).getByRole('button',{name:'Neuer Treffer vormerken',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Neuer Treffer',exact:true})).toBeVisible();
  const rows=await (await page.request.get('/api/v1/wishlist')).json();
  const forza=(item:{game:{igdb_id:number}})=>item.game.igdb_id===1001;
  // Forza: 12,99 € with India at 5,99 € (saving 7,00 €) and a target of 13,00 € (reached). Neuer Treffer: 9,99 €, no saving, target 5,00 €.
  const badge=(item:{game:{igdb_id:number}})=>({state:'price',cents:forza(item)?1299:999,observed_at:1795107000,checked_at:1795107000,stale:false,pending:false,world:forza(item)?{cents:599,region:'India',observed_at:1795107000}:{cents:999,region:'Global',observed_at:1795107000}});
  await page.route(/\/api\/v1\/wishlist\/price-badges(?:\?.*)?$/,route=>route.fulfill({json:Object.fromEntries(rows.map((item:{id:string;game:{igdb_id:number}})=>[item.id,badge(item)]))}));
  await page.route('**/api/v1/alerts',route=>route.request().method()==='GET'?route.fulfill({json:{configured:true,events:[],rules:rows.map((item:{id:string;game:{igdb_id:number}})=>({wish_id:item.id,mode:'target',basis:'base',target_cents:forza(item)?1300:500,enabled:true}))}}):route.continue());
  await navTo(page,'Wunschliste');
  const first=()=>wishlistRows(page).first();
  const sort=page.getByLabel('Sortieren',{exact:true});
  await expect(sort.locator('option')).toHaveText(['Zuletzt hinzugefügt',/^Preis [A-Z]{2}$/,'Größte Ersparnis','Nächster am Ziel']);
  await expect(first()).toContainText('Neuer Treffer');
  await sort.selectOption('save');
  await expect(first()).toContainText('Forza Horizon 5');
  await expect(first().locator('.c-save')).toContainText('−7,00 €');
  await page.reload();await expect(sort).toHaveValue('save');
  await sort.selectOption('price');await expect(first()).toContainText('Neuer Treffer');
  await expect(first().locator('.c-de')).toContainText('9,99');
  await expect(first().locator('.c-world')).toContainText(/[A-Z]{2} ist weltweit am günstigsten/);
  await sort.selectOption('target');await expect(first()).toContainText('Forza Horizon 5');
  await expect(first().locator('.c-status')).toContainText('Ziel erreicht');
  await expect(wishlistRows(page).nth(1).locator('.c-status')).toContainText('4,99 € über Ziel');
  await sort.selectOption('added');await expect(first()).toContainText('Neuer Treffer');
  for(const name of ['Neuer Treffer','Forza Horizon 5']) {
    await openWishlistRow(page,name);
    await removeCurrent(page);
  }
});
