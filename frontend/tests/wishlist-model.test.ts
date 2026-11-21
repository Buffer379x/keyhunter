import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addedTicks, alarmSentToday, cheaperKpi, fetchKpi, matchesChip, reachedTrend, rowFacts, shortTitle, sparkHeights } from '../src/features/wishlist-model.ts';
import type { Row, TargetRule } from '../src/features/wishlist-model.ts';
import type { FetchShopStatus, PriceBadgeData, WishlistItem } from '../src/api.ts';

const item = (id: string, created_at = 1000, title = id): WishlistItem => ({ id, created_at, game_id: id, platform_id: 169, verification: 'catalog', game: null, manual_title: title });
const badge = (cents: number | null, world: number | null = null, extra: Partial<PriceBadgeData> = {}): PriceBadgeData => ({
  state: cents === null ? 'unknown' : 'price', cents, observed_at: 1, checked_at: 1, stale: false, pending: false,
  world: world === null ? null : { cents: world, region: 'IN', observed_at: 1 }, ...extra,
});
const rule = (target: number, extra: Partial<TargetRule> = {}): TargetRule => ({ mode: 'target', basis: 'base', target_cents: target, enabled: true, ...extra });
const row = (id: string, b: PriceBadgeData | undefined, r?: TargetRule, title = id): Row => ({ item: item(id, 1000, title), facts: rowFacts(b, r) });

test('row facts: saving only when the cheapest region is really cheaper', () => {
  const cheaper = rowFacts(badge(2890, 1290), rule(2900));
  assert.equal(cheaper.saving, 1600);
  assert.ok(Math.abs(cheaper.share! - 1600 / 2890) < 1e-9);
  assert.equal(cheaper.reached, true);
  assert.equal(rowFacts(badge(1875, 1875)).saving, null, 'same price is no saving');
  assert.equal(rowFacts(badge(null, 990)).saving, null, 'no target price, no saving');
  assert.deepEqual(rowFacts(badge(null, 990)).world, { cents: 990, region: 'IN' });
});
test('row facts: only enabled target rules on the base price count as reached, the target is shown anyway', () => {
  assert.equal(rowFacts(badge(2000), rule(2500, { enabled: false })).reached, false);
  assert.equal(rowFacts(badge(2000), rule(2500, { enabled: false })).target, 2500);
  assert.equal(rowFacts(badge(2000), rule(2500, { basis: 'estimate' })).reached, false);
  assert.equal(rowFacts(badge(2000), { mode: 'low', basis: 'base', target_cents: null, enabled: true }).target, null);
  assert.equal(rowFacts(badge(2600), rule(2500)).reached, false);
  assert.equal(rowFacts({ ...badge(2000), state: 'no_offer', cents: null }, rule(2500)).reached, false);
});
test('row facts: a trend without any value is no trend', () => {
  assert.equal(rowFacts(badge(2000, null, { trend: Array(14).fill(null) })).trend, null);
  assert.equal(rowFacts(badge(2000)).trend, null);
  assert.equal(rowFacts(badge(2000, null, { trend: [] })).trend, null);
});
test('filter chips', () => {
  const reached = rowFacts(badge(2000), rule(2500));
  const cheap = rowFacts(badge(1000, 800)); // exactly 20 %
  const slightly = rowFacts(badge(1000, 850));
  const open = rowFacts(badge(null));
  assert.deepEqual([reached, cheap, slightly, open].map(f => matchesChip(f, 'ziel')), [true, false, false, false]);
  assert.deepEqual([reached, cheap, slightly, open].map(f => matchesChip(f, 'welt')), [false, true, false, false]);
  assert.deepEqual([reached, cheap, slightly, open].map(f => matchesChip(f, 'offen')), [false, false, false, true]);
  assert.ok([reached, cheap, slightly, open].every(f => matchesChip(f, 'alle')));
});
test('added ticks: cumulative count per day of addition', () => {
  const day = 86400, base = Date.UTC(2026, 10, 1, 12) / 1000;
  assert.deepEqual(addedTicks([item('a', base), item('b', base + 60), item('c', base + 2 * day), item('d', base + 5 * day)]), [2, 3, 4]);
  assert.deepEqual(addedTicks([]), []);
  assert.deepEqual(addedTicks([item('a', 0)]), [], 'no creation date, no ticks');
});
test('reached trend: newly reached since yesterday and per-day counts', () => {
  const trend = (yesterday: number | null, today: number) => [...Array(12).fill(3000), yesterday, today];
  const rules = { a: rule(2500), b: rule(2500), c: rule(2500) };
  const rows = [
    row('a', badge(2400, null, { trend: trend(2600, 2400) }), rules.a), // reached today, not yesterday
    row('b', badge(2400, null, { trend: trend(2450, 2400) }), rules.b), // reached on both days
    row('c', badge(2600, null, { trend: trend(null, 2600) }), rules.c), // not reached
  ];
  const result = reachedTrend(rows, rules);
  assert.equal(result.since, 1);
  assert.deepEqual(result.ticks, [0, 0, 0, 0, 0, 0, 0, 1, 2]);
  assert.deepEqual(reachedTrend([row('a', badge(2400), rules.a)], rules), { since: null, ticks: [] }, 'no trend: nothing derived');
});
test('cheaper KPI: count from 20 %, biggest saving of all rows, sorted savings', () => {
  const rows = [row('fh5', badge(2890, 1290), undefined, 'Forza Horizon 5'), row('sf', badge(4749, 3120), undefined, 'Starfield Premium'), row('bg3', badge(3650, 3650)), row('small', badge(1000, 900)), row('open', badge(null))];
  const kpi = cheaperKpi(rows);
  assert.equal(kpi.count, 2);
  assert.equal(kpi.best?.item.id, 'sf');
  assert.deepEqual(kpi.ticks, [1600, 1629]);
  assert.deepEqual(cheaperKpi([row('x', badge(null))]), { count: 0, best: null, ticks: [] });
  assert.equal(shortTitle('Indiana Jones und der Große Kreis'), 'Indiana Jones');
  assert.equal(shortTitle('Forza Horizon 5'), 'Forza Horizon');
  assert.equal(shortTitle('Halo: Infinite'), 'Halo: Infinite');
  assert.equal(shortTitle('Halo: Infinite Campaign'), 'Halo: Infinite');
});
test('fetch KPI: sums enabled shops, demand and hourly ticks only when reported', () => {
  const shop = (budget: FetchShopStatus['budget'], enabled = true): FetchShopStatus => ({ source: 's', enabled, last_success_at: null, last_error: null, paused_until: null, budget, backlog: { due: 0, requested: 0, products: 0, searches: 0 }, oldest_due_at: null, next_due_at: null, worker_seen_at: null });
  const hours = (values: Record<number, number>) => Array.from({ length: 24 }, (_, hour) => values[hour] ?? 0);
  const at3 = new Date(2026, 10, 20, 3, 30).getTime();
  const full = fetchKpi({ shops: [shop({ used: 30, limit: 120, demand_per_day: 200, by_hour: hours({ 0: 10, 2: 20 }) }), shop({ used: 5, limit: 100, demand_per_day: 40, by_hour: hours({ 1: 5 }) }), shop({ used: 99, limit: 99 }, false)], errors_24h: 0, recent_runs: [] }, at3);
  assert.deepEqual(full, { used: 35, limit: 220, demand: 240, ticks: [10, 15, 35, 35], paused: false });
  assert.deepEqual(fetchKpi({ shops: [shop({ used: 3, limit: 10 })], errors_24h: 0, recent_runs: [] }, at3), { used: 3, limit: 10, demand: null, ticks: [], paused: false }, 'older server: no demand, no ticks');
  assert.equal(fetchKpi(null), null);
  assert.equal(fetchKpi({ shops: [shop({ used: 1, limit: 2 }, false)], errors_24h: 0, recent_runs: [] }), null);
});
test('alarm sent today ignores test messages and other days', () => {
  const now = new Date(2026, 10, 20, 12).getTime(), today = new Date(2026, 10, 20, 8).getTime() / 1000, yesterday = today - 86400;
  const event = (wish_id: string | null, sent_at: number | null) => ({ id: 1, wish_id, state: 'sent', observed_at: today, sent_at, cents: 100, attempts: 1 });
  assert.equal(alarmSentToday([event('a', today)], now), true);
  assert.equal(alarmSentToday([event(null, today), event('a', yesterday), event('b', null)], now), false);
  assert.equal(alarmSentToday(undefined, now), false);
});
test('sparkline heights follow the prototype scale and keep empty days', () => {
  const heights = sparkHeights([null, 1000, 2000]);
  assert.equal(heights[0], null);
  assert.equal(heights[1], Math.max(3, (1000 - 920) / (2000 - 920) * 22));
  assert.equal(heights[2], 22);
  assert.deepEqual(sparkHeights([null, null]), [null, null]);
});

test('fetch KPI reports a pause of the automatic checks', () => {
  const shop = { source: 'eneba', enabled: true, last_success_at: null, last_error: null, paused_until: null, budget: { used: 1, limit: 10 }, backlog: { due: 0, requested: 0, products: 0, searches: 0 }, oldest_due_at: null, next_due_at: null, worker_seen_at: null };
  assert.equal(fetchKpi({ paused_at: 1_800_000_000, shops: [shop as never], errors_24h: 0, recent_runs: [] })?.paused, true);
  assert.equal(fetchKpi({ paused_at: null, shops: [shop as never], errors_24h: 0, recent_runs: [] })?.paused, false);
});
