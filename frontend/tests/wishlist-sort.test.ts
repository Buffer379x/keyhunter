import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSortMode, sortWishlist } from '../src/features/wishlist-sort.ts';
import { rowFacts } from '../src/features/wishlist-model.ts';
import type { RowFacts } from '../src/features/wishlist-model.ts';
import type { PriceBadgeData, WishlistItem } from '../src/api.ts';

const item = (id: string, created_at: number): WishlistItem => ({ id, created_at, game_id: id, platform_id: 169, verification: 'catalog', game: null, manual_title: id });
const badge = (cents: number | null, world?: number): PriceBadgeData => ({ state: cents === null ? 'unknown' : 'price', cents, observed_at: 1, checked_at: 1, stale: false, pending: false, world: world === undefined ? null : { cents: world, region: 'IN', observed_at: 1 } });
const rule = (target: number) => ({ mode: 'target' as const, basis: 'base' as const, target_cents: target, enabled: true });

const rows = [item('a', 10), item('b', 20), item('c', 30), item('d', 40)];
const facts: Record<string, RowFacts> = {
  a: rowFacts(badge(2890, 1290), rule(2900)), // saving 1600, 10 under target
  b: rowFacts(badge(4749, 3120), rule(4000)), // saving 1629, 749 over target
  c: rowFacts(badge(null), rule(3500)), // no price
  d: rowFacts(badge(1875, 1875), undefined), // no saving, no target
};
const ids = (mode: Parameters<typeof sortWishlist>[2]) => sortWishlist(rows, facts, mode).map(row => row.id);

test('newest first, independent of prices', () => {
  assert.deepEqual(ids('added'), ['d', 'c', 'b', 'a']);
  assert.deepEqual(rows.map(row => row.id), ['a', 'b', 'c', 'd'], 'the input stays untouched');
});
test('target-country price ascending, items without a price last', () => {
  assert.deepEqual(ids('price'), ['d', 'a', 'b', 'c']);
});
test('biggest saving abroad first, no saving last (newest first among them)', () => {
  assert.deepEqual(ids('save'), ['b', 'a', 'd', 'c']);
});
test('closest to the target first (reached ones lead), no target or price last', () => {
  assert.deepEqual(ids('target'), ['a', 'b', 'd', 'c']);
});
test('stored sort modes are validated', () => {
  assert.equal(isSortMode('save'), true);
  assert.equal(isSortMode('name'), false);
  assert.equal(isSortMode(null), false);
});
