import test from 'node:test';
import assert from 'node:assert/strict';
import { everyText, trendLeader, trendText } from '../src/features/offers-model.ts';
import type { Link } from '../src/features/offers-model.ts';

const link = (id: number, score: number | undefined, extra: Partial<Link> = {}): Link => ({
  id,
  source: 'eneba',
  url: '',
  review: 'confirmed',
  can_confirm: true,
  eligible: false,
  queued: false,
  enabled: true,
  stale: false,
  observed_at: 1,
  attempted_at: 1,
  last_error: null,
  retry_at: 0,
  data_state: 'current',
  current: true,
  cheap_score: score,
  product: { name: 'Game', region: 'Argentina', market: 'DE', activation: 'unknown', availability: 'in_stock' },
  quotes: [],
  ...extra,
});

test('the trend names a region only once it is clearly the cheapest or the most expensive', () => {
  assert.equal(trendText(link(1, 0.5)), null);
  assert.equal(trendText(link(1, 0.2)), 'meist günstig');
  assert.equal(trendText(link(1, 0.8)), 'meist teuer');
  assert.equal(trendText(link(1, undefined)), null);
});

test('the trend leader is the steadiest cheap confirmed product', () => {
  assert.equal(trendLeader([link(1, 0.5), link(2, 0.4)]), null);
  assert.equal(trendLeader([link(1, 0.25), link(2, 0.05), link(3, 0.01, { review: 'pending' })])?.id, 2);
  assert.equal(trendLeader([link(1, 0.1, { enabled: false })]), null);
});

test('check intervals read as minutes, hours or days', () => {
  assert.equal(everyText(900), 'alle 15 min');
  assert.equal(everyText(12 * 3600), 'alle 12 h');
  assert.equal(everyText(48 * 3600), 'alle 2 Tage');
});
