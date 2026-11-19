import test from 'node:test';
import assert from 'node:assert/strict';
import { libraryItems } from '../src/features/library-sort.ts';
import type { LibraryItem } from '../src/api.ts';
const item=(id:string,title:string,system:number,created_at:number,acquired_at:number):LibraryItem=>({id,game_id:id,platform_id:system,created_at,acquired_at,game:null,manual_title:title,verification:'manual_unverified'});
test('library filters actual systems and sorts acquisition independently from original wishlist dates',()=>{
  const data=[item('a','Zelda',169,500,10),item('b','Älterer Titel',49,1,30),item('c','Forza',169,300,20)];
  assert.deepEqual(libraryItems(data,'all','added').map(i=>i.id),['b','c','a']);
  assert.deepEqual(libraryItems(data,'169','name').map(i=>i.id),['c','a']);
  assert.deepEqual(libraryItems(data,'all','name').map(i=>i.id),['b','c','a']);
  assert.deepEqual(libraryItems(data,'49','added').map(i=>i.id),['b']);
  assert.deepEqual(data.map(i=>i.id),['a','b','c']);
});
