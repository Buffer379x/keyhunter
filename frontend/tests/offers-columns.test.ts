import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OFFERS_COLUMNS, OFFERS_DEFAULT_HIDDEN, offersColumnName, offersOrder, visibleOffersColumns } from '../src/features/offers-columns.ts';

test('offers columns: a stored order is used only when complete, the price never hides', () => {
  assert.deepEqual(offersOrder(null), [...OFFERS_COLUMNS]);
  assert.deepEqual(offersOrder(['price', 'shop']), [...OFFERS_COLUMNS], 'incomplete');
  const order = offersOrder(['score', 'price', 'shop', 'region', 'validity', 'diff', 'seen']);
  assert.equal(order[0], 'score');
  assert.deepEqual(visibleOffersColumns(order, ['seen', 'price', 'validity']), ['score', 'price', 'shop', 'region', 'diff']);
  assert.equal(offersColumnName('diff', 'DE'), 'vs. DE');
  assert.equal(offersColumnName('diff', ''), 'vs. Zielland');
});

test('SCORE-03: the old "score" key is now the Prüftempo column, hidden by default and still selectable', () => {
  assert.equal(offersColumnName('score', 'DE'), 'Prüftempo');
  assert.deepEqual([...OFFERS_DEFAULT_HIDDEN], ['score']);
  const order = offersOrder(null);
  assert.ok(!visibleOffersColumns(order, OFFERS_DEFAULT_HIDDEN).includes('score'));
  // A stored choice with the old key keeps working: shown when the owner turned it on, in the stored place.
  assert.equal(visibleOffersColumns(offersOrder(['score', 'shop', 'region', 'validity', 'price', 'diff', 'seen']), []).at(0), 'score');
});
