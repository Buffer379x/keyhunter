import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortWishlist } from '../src/features/wishlist-sort.ts';
import type { WishlistItem } from '../src/api.ts';
const item=(id:string,title:string,created_at:number):WishlistItem=>({id,created_at,game_id:id,platform_id:169,verification:'manual_unverified',game:null,manual_title:title});
test('wishlist sorts date, price and German names without treating unknown prices as zero',()=>{
  const rows=[item('a','Zelda',10),item('b','Älterer Titel',20),item('c','Forza',30)];
  assert.deepEqual(sortWishlist(rows,{a:900,b:null,c:1000},'added').map(i=>i.id),['c','b','a']);
  assert.deepEqual(sortWishlist(rows,{a:900,b:null,c:1000},'price').map(i=>i.id),['a','c','b']);
  assert.deepEqual(sortWishlist(rows,{},'name').map(i=>i.id),['b','c','a']);
  assert.deepEqual(rows.map(i=>i.id),['a','b','c']);
});
