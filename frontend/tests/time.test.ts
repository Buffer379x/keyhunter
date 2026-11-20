import test from 'node:test';
import assert from 'node:assert/strict';
import { relativeTime } from '../src/time.ts';

test('relative time uses German units and never goes negative', () => {
  const now = 1_000_000_000_000;
  const s = now / 1000;
  assert.equal(relativeTime(s - 10, now), 'gerade eben');
  assert.equal(relativeTime(s + 500, now), 'gerade eben');
  assert.equal(relativeTime(s - 5 * 60, now), 'vor 5 Min.');
  assert.equal(relativeTime(s - 2 * 3600 - 59, now), 'vor 2 Std.');
  assert.equal(relativeTime(s - 3 * 86400, now), 'vor 3 T');
});
