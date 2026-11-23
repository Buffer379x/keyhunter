import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewAction, wishFlags } from '../src/features/wish-pause.ts';

const item = { in_cart: true, paused: true, paused_until: null, review_count: 2, verification: 'catalog' as const };

test('1.0.1: the wishlist shows basket, pause and warning, the cart the pause and the warning only', () => {
  assert.deepEqual(
    wishFlags(item, true).map(flag => flag.kind),
    ['cart', 'paused', 'review'],
  );
  assert.deepEqual(
    wishFlags(item, false).map(flag => flag.kind),
    ['paused', 'review'],
  );
  assert.deepEqual(wishFlags({ ...item, in_cart: false, paused: false, review_count: 0 }, true), []);
});
test('1.0.1: the flags carry the pause end and the review reason', () => {
  const flags = wishFlags({ ...item, review_count: 1, verification: 'needs_review' }, false);
  assert.equal(flags[0].label, 'Abfragen pausiert, bis du sie fortsetzt');
  assert.equal(flags[1].label, '1 ungeprüfte Zuordnung · Katalogzuordnung prüfen');
  assert.match(flags[1].title, /unter Zuordnungen$/);
});
test('1.1 (PROD-03): the warning button names what to review and of which game', () => {
  assert.equal(reviewAction({ review_count: 2, verification: 'catalog' }, 'Halo'), '2 ungeprüfte Zuordnungen von Halo prüfen');
  assert.equal(reviewAction({ review_count: 1, verification: 'catalog' }, 'Halo'), '1 ungeprüfte Zuordnung von Halo prüfen');
  assert.equal(reviewAction({ review_count: 0, verification: 'needs_review' }, 'Halo'), 'Katalogzuordnung von Halo prüfen');
  assert.equal(reviewAction({ review_count: 1, verification: 'needs_review' }, 'Halo'), '1 ungeprüfte Zuordnung und Katalogzuordnung von Halo prüfen');
});
