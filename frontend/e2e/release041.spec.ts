import { test, expect } from '@playwright/test';
import { expectSettingsSaved, signInToFixture, navTo } from './helpers';
import { removeCurrent } from './detail-helpers';

test('price badge is permanent and its region setting persists',async({page})=>{
  await signInToFixture(page);
  await page.getByRole('searchbox',{name:'Nach Spielen suchen',exact:true}).fill('forza');
  await page.getByRole('region',{name:'Suchergebnisse'}).getByRole('button',{name:'Forza Horizon 5 vormerken',exact:true}).click();
  const list=page.getByRole('list',{name:'Vorgemerkte Spiele'});
  await expect(list.locator('.list-price')).toHaveText(/^(Noch nicht abgefragt|Wird gesucht …)$/);
  const rows=await (await page.request.get('/api/v1/wishlist')).json();
  let price:number|null=1234;
  await page.route(/\/api\/v1\/wishlist\/price-badges(?:\?.*)?$/,route=>route.fulfill({json:Object.fromEntries(rows.map((row:{id:string})=>[row.id,{state:price===null?'no_offer':'price',cents:price,observed_at:1795107000,checked_at:price===null?1795108000:1795107000,stale:false,pending:false}]))}));
  await page.clock.install();await page.reload();
  await expect(list.locator('.list-price')).toContainText('12,34');
  price=null;await page.clock.fastForward(31000);
  await expect(list.locator('.list-price')).toHaveText('Kein Angebot');
  await navTo(page, 'Allgemein');
  const scope=page.getByRole('radiogroup',{name:'Preis in der Wunschliste',exact:true});
  await expect(scope.getByRole('radio',{name:/Nur in .* aktivierbar/})).toBeChecked();
  await scope.getByText('Alle Regionen',{exact:true}).click();
  await expectSettingsSaved(page);
  await navTo(page, 'Wunschliste');
  await expect(list.locator('.list-price')).toHaveAttribute('title',/Tiefster beobachteter Grundpreis · alle Regionen/);
  await navTo(page, 'Allgemein');
  await page.reload();await expect(page.getByRole('radiogroup',{name:'Preis in der Wunschliste',exact:true}).getByRole('radio',{name:/Alle Regionen/})).toBeChecked();
  await navTo(page, 'Wunschliste');
  await list.getByRole('button',{name:/Forza Horizon 5/}).click();
  await removeCurrent(page);
});

test('purchase and restore move the saved edition; owned family additions require confirmation',async({page})=>{
  await signInToFixture(page);
  const search=page.getByRole('searchbox',{name:'Nach Spielen suchen',exact:true});
  const results=page.getByRole('region',{name:'Suchergebnisse'});
  await search.fill('forza');await results.getByRole('button',{name:'Forza Horizon 5 vormerken',exact:true}).click();
  await page.getByRole('button',{name:'Gekauft',exact:true}).click();
  await expect(page.getByRole('list',{name:'Vorgemerkte Spiele'})).not.toBeVisible();
  await navTo(page, 'Bibliothek');
  const library=page.getByRole('list',{name:'Meine Spiele'});
  await expect(library.getByRole('listitem')).toHaveCount(1);
  await library.getByRole('button',{name:'Forza Horizon 5 zurück in die Wunschliste',exact:true}).click();
  const restore=page.getByRole('dialog',{name:'Zurück in die Wunschliste?'});
  await expect(restore).toBeVisible();await restore.getByRole('button',{name:'Abbrechen',exact:true}).click();
  await expect(library.getByRole('listitem')).toHaveCount(1);
  await search.fill('forza');await results.getByRole('button',{name:'Forza Horizon 5 vormerken',exact:true}).click();
  const warning=page.getByRole('dialog',{name:'Bereits in der Bibliothek'});
  await expect(warning).toBeVisible();await page.keyboard.press('Escape');
  await expect(warning).not.toBeVisible();await expect(results).toBeVisible();
  await expect(library.getByRole('listitem')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await navTo(page, 'Wunschliste');
  await page.getByRole('button',{name:'Spiel hinzufügen',exact:true}).click();
  const catalog=page.getByRole('dialog',{name:'Spiel hinzufügen',exact:true});
  await page.getByLabel('Spiel im Katalog suchen',{exact:true}).fill('forza');
  await catalog.getByRole('button',{name:'Forza Horizon 5: Premium Edition vormerken',exact:true}).click();
  await expect(warning).toBeVisible();await page.keyboard.press('Escape');
  await expect(warning).not.toBeVisible();await expect(catalog).toBeVisible();
  // A different edition is allowed after a separate, explicit confirmation.
  await catalog.getByRole('button',{name:'Forza Horizon 5: Premium Edition vormerken',exact:true}).click();
  await expect(warning).toBeVisible();await warning.getByRole('button',{name:'Trotzdem vormerken',exact:true}).click();
  await expect(catalog).not.toBeVisible();await expect(warning).not.toBeVisible();
  await expect(page.getByRole('heading',{name:'Forza Horizon 5: Premium Edition',level:1,exact:true})).toBeVisible();
  await navTo(page, 'Bibliothek');
  await expect(library.getByRole('listitem')).toHaveCount(1);
  await library.getByRole('button',{name:'Forza Horizon 5 zurück in die Wunschliste',exact:true}).click();
  await restore.getByRole('button',{name:'In Wunschliste verschieben',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Forza Horizon 5',exact:true})).toBeVisible();
  await expect(page.getByRole('list',{name:'Vorgemerkte Spiele'}).getByRole('listitem')).toHaveCount(2);
  for(const name of ['Forza Horizon 5: Premium Edition','Forza Horizon 5']) {
    await page.getByRole('list',{name:'Vorgemerkte Spiele'}).getByRole('button',{name:new RegExp(`^${name}`)}).first().click();
    await removeCurrent(page);
  }
});

test('library navigation and confirmation fit a 320 pixel screen',async({page})=>{
  await page.setViewportSize({width:320,height:844});
  await signInToFixture(page);
  await page.getByRole('searchbox',{name:'Nach Spielen suchen',exact:true}).fill('forza');
  await page.getByRole('region',{name:'Suchergebnisse'}).getByRole('button',{name:'Forza Horizon 5 vormerken',exact:true}).click();
  // On a narrow screen the actions wrap below the cover and the title instead of covering them.
  await expect(page.getByRole('button',{name:'Weitere Aktionen'})).toBeVisible();
  await expect.poll(()=>page.locator('.game-actions').evaluate(el=>el.getBoundingClientRect().top>=document.querySelector('.game-head h1')!.getBoundingClientRect().bottom)).toBe(true);
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await removeCurrent(page);
  await navTo(page, 'Bibliothek');
  await expect(page.getByRole('heading',{name:'Meine Bibliothek'})).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.reload();await expect(page.getByRole('heading',{name:'Meine Bibliothek'})).toBeVisible();
});
