import test from 'node:test';
import assert from 'node:assert/strict';
import { budgetShare, durationText, intervalOptions, lastTest, outcomeText, outcomeTone, shopState, summarize, workerState } from '../src/features/settings/format.ts';
import type { FetchShopStatus } from '../src/api.ts';

const shop = (patch: Partial<FetchShopStatus> = {}): FetchShopStatus => ({
  source: 'eneba', enabled: true, last_success_at: 1000, last_error: null, paused_until: null, budget: { used: 41, limit: 120 },
  backlog: { due: 5, requested: 2, products: 3, searches: 2 }, oldest_due_at: 500, next_due_at: 2000, worker_seen_at: 1990, ...patch,
});
const ago = (seconds: number) => `t${seconds}`;

test('interval options keep the current value, also when it is not a preset', () => {
  const options = intervalOptions(8 * 3600);
  assert.equal(options.find(o => o.value === 8 * 3600)?.label, 'Alle 8 Stunden');
  assert.equal(options.find(o => o.value === 3600)?.label, 'Jede Stunde');
  assert.equal(options.find(o => o.value === 900)?.label, 'Alle 15 Minuten');
  const odd = intervalOptions(5 * 3600);
  assert.deepEqual(odd.map(o => o.value), [...odd.map(o => o.value)].sort((a, b) => a - b));
  assert.equal(odd.find(o => o.value === 5 * 3600)?.label, 'Alle 5 Stunden');
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

test('summary counts only enabled shops and finds the oldest due job', () => {
  const sum = summarize([shop(), shop({ source: 'driffle', oldest_due_at: 300, backlog: { due: 9, requested: 1, products: 4, searches: 5 }, budget: { used: 23, limit: 120 } }), shop({ source: 'x', enabled: false })], 3);
  assert.deepEqual({ due: sum.due, requested: sum.requested, used: sum.used, limit: sum.limit, errors: sum.errors24h, oldest: sum.oldest }, { due: 14, requested: 3, used: 64, limit: 240, errors: 3, oldest: { at: 300, source: 'driffle' } });
  assert.equal(summarize([], 0).oldest, null);
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
