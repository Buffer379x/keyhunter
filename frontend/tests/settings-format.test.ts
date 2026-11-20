import test from 'node:test';
import assert from 'node:assert/strict';
import { budgetShare, budgetView, durationText, fetchPill, intervalOptions, kindText, lastTest, outcomeText, outcomeTone, parseDailyJobs, shopState, untilText, workerState } from '../src/features/settings/format.ts';
import type { FetchShopStatus } from '../src/api.ts';

const shop = (patch: Partial<FetchShopStatus> = {}): FetchShopStatus => ({
  source: 'eneba', enabled: true, last_success_at: 1000, last_error: null, paused_until: null, budget: { used: 41, limit: 120 },
  backlog: { due: 5, requested: 2, products: 3, searches: 2 }, oldest_due_at: 500, next_due_at: 2000, worker_seen_at: 1990, ...patch,
});
const ago = (seconds: number) => `t${seconds}`;

test('interval options keep the current value, also when it is not a preset', () => {
  const options = intervalOptions(8 * 3600);
  assert.equal(options.find(o => o.value === 8 * 3600)?.label, '8 Stunden');
  assert.equal(options.find(o => o.value === 3600)?.label, '1 Stunde');
  assert.equal(options.find(o => o.value === 900)?.label, '15 Minuten');
  const odd = intervalOptions(5 * 3600);
  assert.deepEqual(odd.map(o => o.value), [...odd.map(o => o.value)].sort((a, b) => a - b));
  assert.equal(odd.find(o => o.value === 5 * 3600)?.label, '5 Stunden');
  assert.equal(new Set(odd.map(o => o.value)).size, odd.length);
});

test('shop state says what is wrong, paused and disabled come first', () => {
  assert.deepEqual(shopState(shop({ enabled: false }), 2000, ago), { tone: 'off', text: 'Deaktiviert' });
  assert.equal(shopState(shop({ paused_until: 3000 }), 2000, ago).tone, 'warn');
  assert.equal(shopState(shop({ paused_until: 1500 }), 2000, ago).tone, 'ok');
  assert.equal(shopState(shop({ last_error: 'network' }), 2000, ago).tone, 'error');
  assert.equal(shopState(shop({ last_success_at: null }), 2000, ago).text, 'Aktiv · noch kein Abruf');
  assert.equal(shopState(shop(), 2000, ago).text, 'Aktiv · letzter Abruf t1000');
});

test('worker is stalled after five minutes without heartbeat', () => {
  assert.equal(workerState(shop({ worker_seen_at: 1990 }), 2000, ago).text, 'Läuft');
  assert.equal(workerState(shop({ worker_seen_at: 1000 }), 1200, ago).tone, 'ok');
  assert.equal(workerState(shop({ worker_seen_at: 1000 }), 1400, ago).tone, 'error');
  assert.equal(workerState(shop({ worker_seen_at: null }), 2000, ago).tone, 'off');
  assert.equal(workerState(shop({ enabled: false }), 2000, ago).tone, 'off');
});

test('daily jobs accept whole numbers from 20 to 2000 only', () => {
  assert.equal(parseDailyJobs('500'), 500);
  assert.equal(parseDailyJobs(' 1.200 '), 1200);
  assert.equal(parseDailyJobs('20'), 20);
  assert.equal(parseDailyJobs('2000'), 2000);
  for (const bad of ['', '19', '2001', '12,5', 'abc', '-40', '100000']) assert.equal(parseDailyJobs(bad), null, bad);
});

test('budget view places the demand marker and says when the limit is too low', () => {
  const plain = budgetView({ used: 41, limit: 120 });
  assert.deepEqual({ demand: plain.demand, marker: plain.demandShare, pace: plain.pace, over: plain.over }, { demand: null, marker: null, pace: null, over: false });
  const enough = budgetView({ used: 412, limit: 500, demand_per_day: 469.2, pace_seconds: 172, limit_source: 'setting' });
  assert.deepEqual({ demand: enough.demand, marker: enough.demandShare, pace: enough.pace, over: enough.over, env: enough.fromEnv }, { demand: 470, marker: 0.94, pace: 172, over: false, env: false });
  const short = budgetView({ used: 120, limit: 120, demand_per_day: 610, limit_source: 'env' });
  assert.deepEqual({ over: short.over, needed: short.needed, marker: short.demandShare, env: short.fromEnv }, { over: true, needed: 610, marker: 1, env: true });
  assert.equal(budgetView({ used: 0, limit: 0, demand_per_day: 50 }).over, false);
});

test('fetch pill, next fetch and run kinds', () => {
  assert.deepEqual(fetchPill(shop(), 2000), { tone: 'ok', text: 'Läuft' });
  assert.deepEqual(fetchPill(shop({ paused_until: 3000 }), 2000), { tone: 'warn', text: 'Pausiert' });
  assert.equal(fetchPill(shop({ enabled: false }), 2000).text, 'Aus');
  assert.equal(fetchPill(shop({ last_error: 'network' }), 2000).text, 'Fehler');
  assert.equal(fetchPill(shop({ worker_seen_at: 1000 }), 2000).text, 'Reagiert nicht');
  assert.equal(untilText(2030, 2000), 'jetzt');
  assert.equal(untilText(2120, 2000), 'in 2 Min.');
  assert.equal(untilText(2000 + 3 * 3600, 2000), 'in 3 Std.');
  assert.equal(kindText('product'), 'Preis');
});

test('outcomes, durations, budget share and the last test message', () => {
  assert.equal(outcomeText('rate_limited'), 'Abruflimit erreicht');
  assert.equal(outcomeText('weird'), 'weird');
  assert.deepEqual(['ok', 'rate_limited', 'not_found', 'network', 'access_denied'].map(outcomeTone), ['ok', 'warn', 'warn', 'error', 'error']);
  assert.equal(durationText(340), '340 ms');
  assert.equal(durationText(1250), '1,3 s');
  assert.equal(budgetShare(64, 120).toFixed(2), '0.53');
  assert.equal(budgetShare(500, 120), 1);
  assert.equal(budgetShare(1, 0), 0);
  assert.equal(lastTest([{ id: 3, wish_id: 'a' }, { id: 2, wish_id: null }, { id: 1, wish_id: null }])?.id, 2);
  assert.equal(lastTest([{ id: 3, wish_id: 'a' }]), null);
});
