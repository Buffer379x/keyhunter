import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SORT, nextSort, parseSort, serializeSort, sortWishlist } from '../src/features/wishlist-sort.ts';
import type { SortKey, SortDir } from '../src/features/wishlist-sort.ts';
import { rowFacts } from '../src/features/wishlist-model.ts';
import type { RowFacts } from '../src/features/wishlist-model.ts';
import type { PriceBadgeData, WishlistItem } from '../src/api.ts';

const titles: Record<string, string> = { a: 'Halo Infinite', b: 'ark', c: 'Forza Horizon 10', d: 'Forza Horizon 5' };
const item = (id: string, created_at: number): WishlistItem => ({
  id,
  created_at,
  game_id: id,
  platform_id: 169,
  verification: 'catalog',
  game: null,
  manual_title: titles[id],
  in_cart: false,
});
const badge = (cents: number | null, world?: number): PriceBadgeData => ({
  state: cents === null ? 'unknown' : 'price',
  cents,
  observed_at: 1,
  checked_at: 1,
  stale: false,
  pending: false,
  world: world === undefined ? null : { cents: world, region: 'IN', observed_at: 1 },
  trend: [],
});
const rule = (target: number) => ({ mode: 'target' as const, basis: 'base' as const, target_cents: target, enabled: true });

const rows = [item('a', 10), item('b', 20), item('c', 30), item('d', 40)];
const facts: Record<string, RowFacts> = {
  a: rowFacts(badge(2890, 1290), rule(2900)), // saving 1600, 10 under target
  b: rowFacts(badge(4749, 3120), rule(4000)), // saving 1629, 749 over target
  c: rowFacts(badge(null), rule(3500)), // no price
  d: rowFacts(badge(1875, 1875), undefined), // no saving, no target
};
const ids = (key: SortKey, dir: SortDir = 'asc') => sortWishlist(rows, facts, { key, dir }).map(row => row.id);

test('newest first without a sorted column, independent of prices', () => {
  assert.deepEqual(ids('added', 'desc'), ['d', 'c', 'b', 'a']);
  assert.deepEqual(
    rows.map(row => row.id),
    ['a', 'b', 'c', 'd'],
    'the input stays untouched',
  );
});
test('game name in German order, numbers by value, case ignored', () => {
  assert.deepEqual(ids('title'), ['b', 'd', 'c', 'a']);
  assert.deepEqual(ids('title', 'desc'), ['a', 'c', 'd', 'b']);
});
test('target-country price both ways, items without a price last in both directions', () => {
  assert.deepEqual(ids('price'), ['d', 'a', 'b', 'c']);
  assert.deepEqual(ids('price', 'desc'), ['b', 'a', 'd', 'c']);
});
test('cheapest region worldwide', () => {
  assert.deepEqual(ids('world'), ['a', 'd', 'b', 'c']);
});
test('biggest saving abroad first, no saving last (newest first among them)', () => {
  assert.deepEqual(ids('save', 'desc'), ['b', 'a', 'd', 'c']);
  assert.deepEqual(ids('save', 'asc'), ['a', 'b', 'd', 'c']);
});
test('alarm target value, and status = closest to the target first (reached ones lead)', () => {
  assert.deepEqual(ids('target'), ['a', 'c', 'b', 'd']);
  assert.deepEqual(ids('status'), ['a', 'b', 'd', 'c']);
});
test('header clicks: natural direction, reversed, back to newest first', () => {
  let sort = nextSort(DEFAULT_SORT, 'price');
  assert.deepEqual(sort, { key: 'price', dir: 'asc' });
  sort = nextSort(sort, 'price');
  assert.deepEqual(sort, { key: 'price', dir: 'desc' });
  assert.deepEqual(nextSort(sort, 'price'), DEFAULT_SORT);
  assert.deepEqual(nextSort(sort, 'save'), { key: 'save', dir: 'desc' }, 'the saving starts with the biggest');
});
test('stored sorts are validated, and 0.6.1 modes still work', () => {
  assert.deepEqual(parseSort(serializeSort({ key: 'world', dir: 'desc' })), { key: 'world', dir: 'desc' });
  assert.deepEqual(parseSort('save'), { key: 'save', dir: 'desc' });
  assert.deepEqual(parseSort('target'), { key: 'status', dir: 'asc' });
  assert.deepEqual(parseSort('price'), { key: 'price', dir: 'asc' });
  assert.deepEqual(parseSort('name:up'), DEFAULT_SORT);
  assert.deepEqual(parseSort(null), DEFAULT_SORT);
});
