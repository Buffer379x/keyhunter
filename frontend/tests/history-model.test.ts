import test from 'node:test';
import assert from 'node:assert/strict';
import { columns, dailyStats, dayLabel, dayStart, defaultRange, intervals, DAY } from '../src/features/history-model.ts';
import { regionCode } from '../src/features/regions.ts';

// Noon today in local time, so day boundaries do not depend on the time zone of the test machine.
const today = dayStart(Date.now() / 1000, 0);
const now = today + 12 * 3600;
const at = (back: number, hour: number) => dayStart(now, back) + hour * 3600;
const point = (time: number, cents: number | null, region = 'DE') => ({ observed_at: time, base_cents: cents, link_id: 1, region });

test('a measurement holds until the next one, at most 24 hours and never beyond now', () => {
  const parts = intervals([point(at(5, 10), 3000), point(at(5, 20), 2800), point(at(1, 8), null), point(at(0, 11), 2900)], now);
  assert.deepEqual(
    parts.map(p => [p.start, p.end, p.cents]),
    [
      [at(5, 10), at(5, 20), 3000],
      [at(5, 20), at(5, 20) + DAY, 2800],
      [at(0, 11), now, 2900],
    ],
  );
});

test('columns: minimum per bucket, the last bucket ends with today, days without data stay empty', () => {
  const home = [point(at(29, 9), 3500), point(at(10, 9), 3100), point(at(10, 15), 2990), point(at(0, 8), 3200)];
  const world = [point(at(10, 9), 1290, 'India'), point(at(0, 8), 1500, 'Turkey')];
  const daily = columns(home, world, 30, 30, now);
  assert.equal(daily.length, 30);
  assert.deepEqual([daily[0].fromBack, daily[29].toBack], [29, 0]);
  assert.equal(daily[29].end, dayStart(now, -1));
  assert.equal(daily[0].home?.cents, 3500);
  assert.equal(daily[1].home?.cents, 3500); // still valid on the next morning
  assert.equal(daily[2].home, null); // then it expired after 24 hours: an empty cell, nothing invented
  assert.deepEqual(daily[19].home, { cents: 2990, region: 'DE' });
  assert.deepEqual(daily[19].world, { cents: 1290, region: 'India' });
  assert.equal(daily[20].home?.cents, 2990); // valid into the next morning
  assert.equal(daily[21].home, null);
  assert.equal(daily[29].world?.cents, 1500);
  // 15 buckets of two days on narrow screens, each the minimum of both days.
  const narrow = columns(home, world, 30, 15, now);
  assert.equal(narrow.length, 15);
  assert.deepEqual([narrow[14].fromBack, narrow[14].toBack], [1, 0]);
  assert.equal(narrow[9].home?.cents, 2990);
  // 90 and 180 days in 30 buckets: 3 and 6 days per bucket.
  assert.deepEqual(columns(home, world, 90, 30, now).map(c => c.fromBack - c.toBack + 1)[0], 3);
  assert.deepEqual(columns(home, world, 180, 30, now)[0].fromBack, 179);
  assert.ok(columns([], [], 30, 30, now).every(c => c.home === null && c.world === null));
});

test('daily statistics use the daily minima of days with data only', () => {
  const rows = [point(at(20, 9), 4000), point(at(12, 9), 2500), point(at(3, 9), 2500), point(at(0, 9), 3000)];
  const stats = dailyStats(rows, 90, now);
  assert.deepEqual(stats.low, { cents: 2500, back: 2, region: 'DE' }); // the 3-days-back price still holds two days back
  assert.equal(stats.high, 4000);
  assert.equal(stats.average, Math.round((4000 + 4000 + 2500 + 2500 + 2500 + 2500 + 3000) / 7));
  assert.deepEqual(dailyStats([], 30, now), { low: null, high: null, average: null });
});

test('default range, axis labels and region codes', () => {
  assert.equal(defaultRange([point(at(20, 9), 1)], now), 30);
  assert.equal(defaultRange([point(at(60, 9), 1)], now), 90);
  assert.equal(defaultRange([], now), 30);
  assert.match(dayLabel(now, 0), /^\d{2} \S+/);
  assert.deepEqual(['Deutschland', 'India', 'Turkey', 'Global', 'Europe', 'North America', 'Rest of World', null].map(regionCode), [
    'DE',
    'IN',
    'TR',
    'GL',
    'EU',
    'NA',
    'ROW',
    '–',
  ]);
});

test('a measurement holds as long as its link counts it current, at least 24 hours (FUNC-05)', () => {
  const weekly = { ...point(at(5, 10), 3000), fresh_until: at(5, 10) + 14 * DAY };
  assert.deepEqual(
    intervals([weekly], now).map(p => [p.start, p.end]),
    [[at(5, 10), now]],
  );
  const short = { ...point(at(5, 10), 3000), fresh_until: at(5, 10) + 3600 };
  assert.deepEqual(
    intervals([short], now).map(p => [p.start, p.end]),
    [[at(5, 10), at(5, 10) + DAY]],
  );
});
