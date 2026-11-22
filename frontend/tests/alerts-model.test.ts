import test from 'node:test';
import assert from 'node:assert/strict';
import { alarmRows } from '../src/features/alerts-model.ts';
import type { AlarmRule } from '../src/features/alerts-model.ts';
import type { PriceBadgeData } from '../src/api.ts';

const rule = (wish_id: string, title: string, target: number | null, enabled = true): AlarmRule => ({
  wish_id,
  title,
  mode: target === null ? 'low' : 'target',
  target_cents: target,
  enabled,
});
const badge = (cents: number | null, stale = false): PriceBadgeData => ({
  cents,
  state: cents === null ? 'no_offer' : 'price',
  observed_at: 1,
  checked_at: 1,
  stale,
  pending: false,
  trend: [],
});

test('alarm rows are sorted by distance to the target, missing prices and low-price rules last', () => {
  const rows = alarmRows(
    [
      rule('a', 'Starfield', 4000),
      rule('b', 'Forza', 2900),
      rule('c', 'Ori', 800),
      rule('d', 'Halo', null),
      rule('e', 'Zelda', 3000),
      rule('f', 'Diablo', 3000),
    ],
    { a: badge(4749), b: badge(2890), c: badge(749, true), d: badge(1000), e: badge(null) },
  );
  assert.deepEqual(
    rows.map(r => r.id),
    ['c', 'b', 'a', 'f', 'e', 'd'],
  );
  assert.deepEqual({ distance: rows[1].distance, reached: rows[1].reached }, { distance: -10, reached: true });
  assert.equal(rows[0].stale, true);
  assert.deepEqual({ distance: rows[2].distance, reached: rows[2].reached }, { distance: 749, reached: false });
  assert.equal(rows[3].current, null);
  assert.equal(rows[5].target, null);
});

test('a paused alarm is never reached, but keeps its distance', () => {
  const [row] = alarmRows([rule('a', 'Forza', 3000, false)], { a: badge(2500) });
  assert.deepEqual({ distance: row.distance, reached: row.reached, enabled: row.enabled }, { distance: -500, reached: false, enabled: false });
});
