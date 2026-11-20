import test from 'node:test';
import assert from 'node:assert/strict';
import { offerRows, summarize, ruler, labelLanes, reasonList } from '../src/features/offers-model.ts';
import type { Link, OffersView } from '../src/features/offers-model.ts';
import { defaultRange, changePercent, lowestPoint, mean, monthStarts, DAY } from '../src/features/history-model.ts';

const link = (id: number, region: string, cents: number, reasons: string[] = [], extra: Partial<Link> = {}): Link => ({
  id, source: 'eneba', url: 'https://example.test', review: 'confirmed', can_confirm: true, eligible: reasons.length === 0, queued: false, enabled: true,
  stale: false, observed_at: 1, attempted_at: 1, last_error: null, retry_at: 0, reasons,
  product: { name: 'p', region, market: 'DE', activation: reasons.length ? 'unknown' : 'confirmed', availability: reasons.includes('sold_out') ? 'sold_out' : 'in_stock' },
  quotes: reasons.includes('sold_out') ? [] : [{ id: String(id), seller: null, base_cents: cents, estimated_total_cents: region === 'India' ? null : cents + 100 }], ...extra,
});
const view = (links: Link[], best: number | null, estimate: number | null = null): OffersView => ({ links, history: [], best_base: best, best_estimate: estimate, target_country: 'DE', discovery_running: false, sources: [], searches: [] });

test('rows are ordered by price only; cheaper foreign offers stay on top and sold-out rows come last', () => {
  const v = view([link(1, 'DE', 3000), link(2, 'USA', 1000, ['activation_unknown']), link(3, 'India', 500, ['activation_blocked']), link(4, 'Europe', 0, ['sold_out'])], 3000);
  assert.deepEqual(offerRows(v, 'base').map(r => r.link.id), [3, 2, 1, 4]);
  assert.equal(offerRows(v, 'base')[3].status, 'sold_out');
  // Estimated totals: India has no estimate and moves behind the offers that have one.
  assert.deepEqual(offerRows(v, 'estimate').map(r => r.link.id).slice(0, 3), [2, 1, 3]);
});

test('summary compares the best target-country price with the cheapest region and explains what does not count', () => {
  const v = view([link(1, 'DE', 3000), link(2, 'USA', 1000, ['activation_unknown']), link(3, 'India', 500, ['activation_blocked'])], 3000, 3100);
  const s = summarize(v, offerRows(v, 'base'), 'base', 'DE');
  assert.equal(s.targetCents, 3000);
  assert.equal(s.world?.link.id, 3);
  assert.equal(s.saving, 2500);
  assert.equal(s.savingPercent, 83);
  assert.equal(s.excluded.count, 2);
  assert.equal(s.excluded.example?.link.id, 3);
  assert.deepEqual(s.excluded.reasons, ['In DE nicht aktivierbar', 'Aktivierung in DE ungeklärt']);
  assert.equal(s.validCount, 1);
});

test('stale and failed offers never count as the cheapest current region', () => {
  const v = view([link(1, 'DE', 3000), link(2, 'India', 500, ['stale'], { stale: true })], 3000);
  const s = summarize(v, offerRows(v, 'base'), 'base', 'DE');
  assert.equal(s.world?.link.id, 1);
  assert.equal(s.saving, 0);
  assert.equal(s.excluded.count, 0);
});

test('without a valid offer the world price is still reported and the target price is null', () => {
  const v = view([link(3, 'India', 500, ['activation_blocked'])], null);
  const s = summarize(v, offerRows(v, 'base'), 'base', 'DE');
  assert.equal(s.targetCents, null);
  assert.equal(s.world?.price, 500);
  assert.equal(s.excluded.count, 1);
});

test('reasons come in a fixed order with the country filled in', () => {
  assert.deepEqual(reasonList(link(1, 'X', 1, ['purchase_context_mismatch', 'activation_unknown']), 'DE'), ['Aktivierung in DE ungeklärt', 'Anderer Kaufkontext']);
});

test('ruler keeps every value inside the range and labels share two lanes', () => {
  const r = ruler([2149, 2392, 2500, 2690])!;
  for (const cents of [2149, 2392, 2500, 2690]) { assert.ok(r.pos(cents) > 0 && r.pos(cents) < 100); }
  assert.ok(r.ticks.length >= 2 && r.ticks.length <= 7);
  assert.equal(ruler([]), null);
  assert.ok(ruler([2000])!.pos(2000) > 40);
  assert.deepEqual(labelLanes([10, 12, 60]), [0, 1, 0]);
});

test('history helpers: range, lowest, mean, change and month starts', () => {
  const now = 1_800_000_000;
  const point = (days: number, cents: number | null) => ({ observed_at: now - days * DAY, base_cents: cents, link_id: 1, region: 'DE' });
  const rows = [point(20, 3499), point(14, 3299), point(7, 3099), point(0, 2890), point(3, null)];
  assert.equal(defaultRange(rows, now), 30);
  assert.equal(defaultRange([point(60, 1)], now), 90);
  assert.equal(defaultRange([point(200, 1)], now), 365);
  assert.equal(lowestPoint(rows)?.base_cents, 2890);
  assert.equal(mean(rows), Math.round((3499 + 3299 + 3099 + 2890) / 4));
  assert.equal(mean([point(1, 100)]), null);
  assert.equal(changePercent(rows), -17);
  const months = monthStarts(now - 90 * DAY, now);
  assert.ok(months.length >= 2 && months.length <= 4);
});

test('reason labels keep nouns capitalised inside a sentence', async () => {
  const { inSentence } = await import('../src/features/offers-model.ts');
  assert.equal(inSentence('In DE nicht aktivierbar'), 'in DE nicht aktivierbar');
  assert.equal(inSentence('Anderer Kaufkontext'), 'anderer Kaufkontext');
  assert.equal(inSentence('Aktivierung in DE ungeklärt'), 'Aktivierung in DE ungeklärt');
  assert.equal(inSentence('Ausverkauft'), 'ausverkauft');
});
