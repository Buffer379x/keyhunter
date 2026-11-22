import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cartLine, cartSums, entryShop } from '../src/features/cart-model.ts';
import type { CartEntry, CartOffer, CartScope, ShopOffers } from '../src/features/cart-model.ts';

const offer = (cents: number, estimate: number | null, region: string, stale = false): CartOffer => ({
  cents,
  estimate_cents: estimate,
  region,
  observed_at: 1,
  stale,
});
const entry = (id: string, offers: Record<string, ShopOffers>, source: string | null = null, scope: CartScope = 'world'): CartEntry => ({
  id,
  created_at: 1,
  added_at: 1,
  game_id: id,
  platform_id: 169,
  verification: 'catalog',
  game: null,
  manual_title: id,
  in_cart: true,
  source,
  scope,
  offers,
});
// Eneba with 10 % fees, Driffle without a fee estimate.
const offers = (): Record<string, ShopOffers> => ({
  eneba: { home: offer(2000, 2200, 'Global'), world: offer(1200, 1320, 'India') },
  driffle: { home: offer(2100, null, 'Europe'), world: offer(1100, null, 'Turkey') },
});

test('cart: the button on the game page counts the cheapest variant, shop and region independent', () => {
  const line = cartLine(entry('a', offers()));
  assert.deepEqual([line.source, line.region, line.base, line.fee], ['driffle', 'Turkey', 1100, null]);
  // Only a last known target-country price: that one counts.
  const stale = cartLine(entry('b', { eneba: { home: offer(1900, 2090, 'Global', true), world: null } }));
  assert.deepEqual([stale.source, stale.base, stale.fee, stale.stale], ['eneba', 1900, 190, true]);
});

test("cart: DE/INT changes the price of the entry's own shop only", () => {
  const home = cartLine(entry('a', offers(), 'eneba', 'home'));
  assert.deepEqual([home.source, home.region, home.base, home.fee], ['eneba', 'Global', 2000, 200]);
  const world = cartLine(entry('a', offers(), 'eneba', 'world'));
  assert.deepEqual([world.source, world.region, world.base, world.fee], ['eneba', 'India', 1200, 120]);
  // A shop without an offer in that scope: no price, the shop stays.
  const none = cartLine(entry('a', { eneba: { home: null, world: offer(1200, 1320, 'India') } }, 'eneba', 'home'));
  assert.deepEqual([none.source, none.base], ['eneba', null]);
  assert.equal(entryShop(entry('a', offers(), null, 'home')), 'eneba', 'no shop of its own: the cheapest in that scope');
});

test('cart: sums by shop, unknown fees, and the extra cost against the cheapest composition', () => {
  const cheapest = cartSums([entry('a', offers()), entry('b', offers())]);
  assert.deepEqual([cheapest.keys, cheapest.fees, cheapest.total, cheapest.extra], [2200, 0, 2200, null]);
  assert.deepEqual(cheapest.unknownFees, ['driffle']);

  const chosen = cartSums([entry('a', offers(), 'eneba', 'home'), entry('b', offers()), entry('c', {})]);
  assert.equal(chosen.keys, 3100);
  assert.equal(chosen.fees, 200);
  assert.equal(chosen.total, 3300);
  assert.deepEqual(
    chosen.shops.map(shop => [shop.source, shop.count, shop.keys, shop.fees, shop.total]),
    [
      ['eneba', 1, 2000, 200, 2200],
      ['driffle', 1, 1100, null, 1100],
    ],
  );
  assert.deepEqual(chosen.extra, { keys: 900, total: 1100 }, 'Eneba DE instead of Driffle INT: 9 € more on keys, 11 € with fees');
  assert.deepEqual(
    chosen.missing.map(item => item.id),
    ['c'],
  );
  // Eneba INT instead of the cheaper Driffle INT.
  assert.deepEqual(cartSums([entry('a', offers(), 'eneba', 'world')]).extra, { keys: 100, total: 220 });
});

test('RESP-14: an offer that is not safely activatable in the target country is flagged and summed apart', () => {
  const risky = (cents: number, activation: 'confirmed' | 'blocked' | 'unknown'): CartOffer => ({
    ...offer(cents, null, 'India'),
    fits_target: false,
    activation,
  });
  const fits = { ...offer(2000, null, 'Global'), fits_target: true, activation: 'confirmed' as const };
  const a = entry('a', { eneba: { home: fits, world: risky(900, 'unknown') } }, null, 'world');
  const b = entry('b', { eneba: { home: fits, world: null } }, 'eneba', 'home');
  assert.equal(cartLine(a).risk, 'unknown');
  assert.equal(cartLine(b).risk, null);
  assert.equal(cartLine(entry('c', { eneba: { home: fits, world: risky(800, 'blocked') } }, 'eneba', 'world')).risk, 'blocked');
  const sums = cartSums([a, b]);
  assert.deepEqual(sums.risky, { count: 1, keys: 900, total: 900 });
  // The totals themselves do not change.
  assert.equal(sums.keys, 2900);
  assert.equal(cartSums([b]).risky, null);
  // Older payloads without the flag count as fitting.
  assert.equal(cartLine(entry('d', offers())).risk, null);
});
