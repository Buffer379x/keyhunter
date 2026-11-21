import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cartLine, cartSums } from '../src/features/cart-model.ts';
import type { CartEntry } from '../src/features/cart-model.ts';
import type { PriceBadgeData } from '../src/api.ts';

const entry = (id: string, badge?: PriceBadgeData): CartEntry => ({ id, created_at: 1, added_at: 1, game_id: id, platform_id: 169, verification: 'catalog', game: null, manual_title: id, in_cart: true, price_badge: badge });
const badge = (cents: number | null, source: string, estimate: number | null, extra: Partial<PriceBadgeData> = {}): PriceBadgeData => ({
  state: cents === null ? 'no_offer' : 'price', cents, observed_at: 1, checked_at: 1, stale: false, pending: false, source, region: 'Global', estimate_cents: estimate, ...extra,
});

test('cart: key prices, fees and totals by shop; unknown fees count with the key price only', () => {
  const entries = [
    entry('a', badge(2000, 'eneba', 2178)),
    entry('b', badge(1000, 'eneba', 1089)),
    entry('c', badge(1500, 'driffle', null)),
    entry('d', badge(null, 'eneba', null)),
  ];
  const sums = cartSums(entries, {}, 'home');
  assert.equal(sums.keys, 4500);
  assert.equal(sums.fees, 267);
  assert.equal(sums.total, 4767);
  assert.deepEqual(sums.shops.map(shop => [shop.source, shop.count, shop.keys, shop.fees, shop.total]), [['eneba', 2, 3000, 267, 3267], ['driffle', 1, 1500, null, 1500]]);
  assert.deepEqual(sums.unknownFees, ['driffle']);
  assert.deepEqual(sums.missing.map(item => item.id), ['d']);
  assert.equal(sums.lines.length, 4);
});

test('cart: the badges given win over the ones of the cart response, so prices follow new checks', () => {
  const sums = cartSums([entry('a', badge(2000, 'eneba', null))], { a: badge(1800, 'driffle', 1836) }, 'home');
  assert.deepEqual([sums.keys, sums.fees, sums.shops[0].source], [1800, 36, 'driffle']);
});

test('cart: Preis INT counts the cheapest offer of any region with its own fee', () => {
  const world = badge(2000, 'eneba', 2178, { world: { cents: 900, base_cents: 900, estimate_cents: 980, source: 'eneba', region: 'India', observed_at: 1 } });
  const line = cartLine(entry('a', world), world, 'world');
  assert.deepEqual([line.base, line.fee, line.source, line.region], [900, 80, 'eneba', 'India']);
  // Older servers without base/estimate: the compared amount is the key price, the fee unknown.
  const old = badge(2000, 'eneba', null, { world: { cents: 900, source: 'driffle', region: 'India', observed_at: 1 } });
  assert.deepEqual([cartLine(entry('a'), old, 'world').base, cartLine(entry('a'), old, 'world').fee], [900, null]);
  assert.equal(cartLine(entry('a'), badge(2000, 'eneba', null), 'world').base, null, 'no world offer, no price');
});

test('cart: a last known price is marked, a review or error state is no price', () => {
  assert.equal(cartLine(entry('a'), badge(2000, 'eneba', null, { stale: true }), 'home').stale, true);
  assert.equal(cartLine(entry('a'), { ...badge(2000, 'eneba', null), state: 'review' }, 'home').base, null);
  assert.equal(cartLine(entry('a'), undefined, 'home').base, null);
});
