import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OFFERS_COLUMNS, offersColumnName, offersOrder, scoreTone, visibleOffersColumns } from '../src/features/offers-columns.ts';

test('offers columns: a stored order is used only when complete, the price never hides', () => {
  assert.deepEqual(offersOrder(null), [...OFFERS_COLUMNS]);
  assert.deepEqual(offersOrder(['price', 'shop']), [...OFFERS_COLUMNS], 'incomplete');
  const order = offersOrder(['score', 'price', 'shop', 'region', 'validity', 'diff', 'seen']);
  assert.equal(order[0], 'score');
  assert.deepEqual(visibleOffersColumns(order, ['seen', 'price', 'validity']), ['score', 'price', 'shop', 'region', 'diff']);
  assert.equal(offersColumnName('diff', 'DE'), 'vs. DE');
  assert.equal(offersColumnName('diff', ''), 'vs. Zielland');
});

test('score colours: red to yellow below 50, yellow to green from 50', () => {
  assert.deepEqual([0, 49, 50, 100].map(scoreTone), ['lo', 'lo', 'hi', 'hi']);
});
