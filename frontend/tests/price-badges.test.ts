import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeBadges } from '../src/features/price-badges.ts';
import type { PriceBadgeData } from '../src/api.ts';
const price: PriceBadgeData = { state: 'price', cents: 1250, checked_at: 200, observed_at: 190, stale: false, pending: false, trend: [] };
test('late local responses cannot overwrite a newer known price, while newer withdrawals replace it', () => {
  assert.equal(mergeBadges({ a: price }, { a: { ...price, state: 'unknown', cents: null, checked_at: null, observed_at: null } }).a, price);
  assert.equal(mergeBadges({ a: price }, { a: { ...price, cents: 999, checked_at: 100 } }).a, price);
  const withdrawn = { ...price, state: 'no_offer' as const, cents: null, checked_at: 201 };
  assert.equal(mergeBadges({ a: price }, { a: withdrawn }).a, withdrawn);
});
