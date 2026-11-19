import { test, expect } from '@playwright/test';
import { signInToFixture } from './helpers';

test('price badge is permanent and its region setting persists',async({page})=>{
  await signInToFixture(page);
  await page.getByRole('searchbox',{name:'Nach Spielen suchen',exact:true}).fill('forza');
  await page.getByRole('region',{name:'Suchergebnisse'}).getByRole('button',{name:'Forza Horizon 5 vormerken',exact:true}).click();
  const list=page.getByRole('list',{name:'Vorgemerkte Spiele'});
  await expect(list.locator('.list-price')).toHaveText('Unbekannt');
  const rows=await (await page.request.get('/api/v1/wishlist')).json();
  let price:number|null=1234;
  await page.route('**/api/v1/wishlist/prices',route=>route.fulfill({json:Object.fromEntries(rows.map((row:{id:string})=>[row.id,price]))}));
  await page.clock.install();await page.reload();
  await expect(list.locator('.list-price')).toContainText('12,34');
  price=null;await page.clock.fastForward(31000);
  await expect(list.locator('.list-price')).toHaveText('Unbekannt');
  await page.getByRole('button',{name:'Einstellungen',exact:true}).click();
  await page.getByLabel('Preis-Badge in der Wunschliste', {exact:true}).selectOption('all');
  await page.getByRole('button',{name:/^Wunschliste/}).click();
  await expect(list.locator('.list-price')).toHaveAttribute('title',/aktivierbarer/);
  await page.getByRole('button',{name:'Einstellungen',exact:true}).click();
  await page.getByRole('button',{name:'Änderungen speichern'}).click();
  await expect(page.getByText('Einstellungen gespeichert.',{exact:true})).toBeVisible();
  await page.reload();await expect(page.getByLabel('Preis-Badge in der Wunschliste',{exact:true})).toHaveValue('all');
  await page.getByRole('button',{name:/^Wunschliste/}).click();
  await list.getByRole('button',{name:/Forza Horizon 5/}).click();
  await page.getByRole('button',{name:'Auf der Wunschliste'}).click();
  await page.getByRole('button',{name:'Entfernen bestätigen'}).click();
});

test('purchase and restore move the saved edition; owned family additions require confirmation',async({page})=>{
  await signInToFixture(page);
  const search=page.getByRole('searchbox',{name:'Nach Spielen suchen',exact:true});
  const results=page.getByRole('region',{name:'Suchergebnisse'});
  await search.fill('forza');await results.getByRole('button',{name:'Forza Horizon 5 vormerken',exact:true}).click();
  await page.getByRole('button',{name:'Als gekauft markieren',exact:true}).click();
  await expect(page.getByRole('list',{name:'Vorgemerkte Spiele'})).not.toBeVisible();
  await page.getByRole('button',{name:'Bibliothek',exact:true}).click();
  const library=page.getByRole('list',{name:'Meine Spiele'});
  await expect(library.getByRole('listitem')).toHaveCount(1);
  await library.getByRole('button',{name:'Forza Horizon 5',exact:true}).click();
  const restore=page.getByRole('dialog',{name:'Zurück in die Wunschliste?'});
  await expect(restore).toBeVisible();await restore.getByRole('button',{name:'Abbrechen',exact:true}).click();
  await expect(library.getByRole('listitem')).toHaveCount(1);
  await search.fill('forza');await results.getByRole('button',{name:'Forza Horizon 5 vormerken',exact:true}).click();
  const warning=page.getByRole('dialog',{name:'Bereits in der Bibliothek'});
  await expect(warning).toBeVisible();await page.keyboard.press('Escape');
  await expect(warning).not.toBeVisible();await expect(results).toBeVisible();
  await expect(library.getByRole('listitem')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:/^Wunschliste/}).click();
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
  await expect(page.getByRole('heading',{name:'Forza Horizon 5: Premium Edition',level:2,exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Bibliothek',exact:true}).click();
  await expect(library.getByRole('listitem')).toHaveCount(1);
  await library.getByRole('button',{name:'Forza Horizon 5',exact:true}).click();
  await restore.getByRole('button',{name:'In Wunschliste verschieben',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Forza Horizon 5',exact:true})).toBeVisible();
  await expect(page.getByRole('list',{name:'Vorgemerkte Spiele'}).getByRole('listitem')).toHaveCount(2);
  for(const name of ['Forza Horizon 5: Premium Edition','Forza Horizon 5']) {
    await page.getByRole('list',{name:'Vorgemerkte Spiele'}).getByRole('button',{name:new RegExp(`^${name}`)}).first().click();
    await page.getByRole('button',{name:'Auf der Wunschliste'}).click();await page.getByRole('button',{name:'Entfernen bestätigen'}).click();
  }
});

test('library navigation and confirmation fit a 320 pixel screen',async({page})=>{
  await page.setViewportSize({width:320,height:844});
  await signInToFixture(page);
  await page.getByRole('searchbox',{name:'Nach Spielen suchen',exact:true}).fill('forza');
  await page.getByRole('region',{name:'Suchergebnisse'}).getByRole('button',{name:'Forza Horizon 5 vormerken',exact:true}).click();
  await expect.poll(()=>page.locator('.hero-actions').evaluate(el=>el.getBoundingClientRect().top>=document.querySelector('.hero-inner')!.getBoundingClientRect().bottom)).toBe(true);
  await page.getByRole('button',{name:'Auf der Wunschliste'}).click();
  await page.getByRole('button',{name:'Entfernen bestätigen'}).click();
  await page.getByRole('button',{name:'Bibliothek',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Meine Bibliothek'})).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.reload();await expect(page.getByRole('heading',{name:'Meine Bibliothek'})).toBeVisible();
});
