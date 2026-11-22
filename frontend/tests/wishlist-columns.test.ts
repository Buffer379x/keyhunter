import test from 'node:test';
import assert from 'node:assert/strict';
import { WISHLIST_COLUMNS, columnOrder, isDefaultOrder, moveColumn } from '../src/features/wishlist-columns.ts';

test('a stored column order is used only when it holds every column exactly once', () => {
  const own = ['open', 'game', 'price', 'world', 'save', 'target', 'status', 'trend'];
  assert.deepEqual(columnOrder(own), own);
  for (const bad of [null, undefined, [], ['open', 'game'], [...own.slice(0, 7), 'open'], [...own.slice(0, 7), 'cover']]) {
    assert.deepEqual(columnOrder(bad), [...WISHLIST_COLUMNS]);
  }
});

test('moving a column swaps it with its neighbour and stops at both ends', () => {
  const order = columnOrder(null);
  const moved = moveColumn(order, 7, -1);
  assert.deepEqual(moved.slice(5), ['status', 'open', 'trend']);
  assert.deepEqual(order, [...WISHLIST_COLUMNS]);
  assert.equal(moveColumn(order, 0, -1), order);
  assert.equal(moveColumn(order, 7, 1), order);
  assert.ok(isDefaultOrder(order));
  assert.ok(!isDefaultOrder(moved));
});

test('drag and drop puts a column at its new place', async () => {
  const { moveColumnTo } = await import('../src/features/wishlist-columns.ts');
  const order = columnOrder(null);
  assert.deepEqual(moveColumnTo(order, 7, 0), ['open', 'game', 'price', 'world', 'save', 'target', 'status', 'trend']);
  assert.deepEqual(moveColumnTo(order, 0, 2), ['price', 'world', 'game', 'save', 'target', 'status', 'trend', 'open']);
  assert.equal(moveColumnTo(order, 3, 3), order);
  assert.deepEqual(moveColumnTo(order, 0, 99).at(-1), 'game');
});

test('visible columns follow the hidden set and what opens the game', async () => {
  const { visibleColumns, hiddenFor, openMode } = await import('../src/features/wishlist-columns.ts');
  const order = columnOrder(null);
  assert.deepEqual(visibleColumns(order, ['trend', 'target'], 'button'), ['game', 'price', 'world', 'save', 'status', 'open']);
  // The opener always shows; without the button mode the button column is gone.
  assert.deepEqual(
    visibleColumns(order, ['open', 'game'], 'button'),
    ['game', 'price', 'world', 'save', 'target', 'status', 'trend', 'open'].filter(c => c !== 'game'),
  );
  assert.deepEqual(visibleColumns(order, ['game'], 'title'), ['game', 'price', 'world', 'save', 'target', 'status', 'trend']);
  assert.deepEqual(hiddenFor(['game', 'trend'], 'cover'), ['trend']);
  assert.deepEqual(hiddenFor(['open', 'trend'], 'button'), ['trend']);
  assert.equal(openMode('title'), 'title');
  assert.equal(openMode('row'), 'button');
  assert.equal(openMode(undefined), 'button');
});
