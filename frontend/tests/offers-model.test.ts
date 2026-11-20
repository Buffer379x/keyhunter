import test from 'node:test';
import assert from 'node:assert/strict';
import { offerRows, summarize, reasonList, validity, verdict, verdictText } from '../src/features/offers-model.ts';
import type { Link, OffersView } from '../src/features/offers-model.ts';

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

test('reason labels keep nouns capitalised inside a sentence', async () => {
  const { inSentence } = await import('../src/features/offers-model.ts');
  assert.equal(inSentence('In DE nicht aktivierbar'), 'in DE nicht aktivierbar');
  assert.equal(inSentence('Anderer Kaufkontext'), 'anderer Kaufkontext');
  assert.equal(inSentence('Aktivierung in DE ungeklärt'), 'Aktivierung in DE ungeklärt');
  assert.equal(inSentence('Ausverkauft'), 'ausverkauft');
});

const money = (cents: number) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(cents / 100);
const region = (row: { link: Link }) => row.link.product?.region === 'India' ? 'Indien' : row.link.product?.region ?? '';

test('validity: valid, unclear activation, blocked and review rows each name their state', () => {
  const v = view([link(1, 'DE', 3000), link(2, 'USA', 1000, ['activation_unknown']), link(3, 'India', 500, ['activation_blocked'])], 3000);
  const rows = offerRows(v, 'base');
  assert.deepEqual(rows.map(r => [r.link.id, validity(r, 'DE').tone, validity(r, 'DE').text]), [
    [3, 'dim', 'in DE nicht aktivierbar'], [2, 'warn', 'Aktivierung in DE ungeklärt'], [1, 'ok', 'in DE aktivierbar'],
  ]);
  const review = offerRows(view([{ ...link(4, 'DE', 100), review: 'pending' }], null), 'base')[0];
  assert.equal(validity(review, 'DE').text, 'Zuordnung prüfen');
});

test('verdict: same price, cheaper region with the effort thresholds 15 % and 30 %, and no valid offer', () => {
  const at = (target: number, cheap: number, reasons = ['activation_unknown']) => {
    const v = view([link(1, 'DE', target), link(2, 'India', cheap, reasons)], target);
    return verdict(summarize(v, offerRows(v, 'base'), 'base', 'DE'), region, 'DE');
  };
  const same = verdict(summarize(view([link(1, 'DE', 3000)], 3000), offerRows(view([link(1, 'DE', 3000)], 3000), 'base'), 'base', 'DE'), region, 'DE')!;
  assert.deepEqual(verdictText(same, 'Deutschland', money), { lead: 'Deutschland ist gerade weltweit am günstigsten.', rest: 'Kein Umweg nötig: Der beste Preis gilt direkt in Deutschland.' });
  const small = at(10000, 9000)!;
  assert.equal(small.kind === 'cheaper' && small.effort, 'small');
  assert.equal(verdictText(small, 'Deutschland', money).lead, 'Indien spart 10,00\u00a0€ (10 %).');
  assert.match(verdictText(small, 'Deutschland', money).rest, /ungeklärt; meist braucht es eine Regionsumstellung im Konto\. Bei so wenig Unterschied lohnt sich der Aufwand kaum\.$/);
  const noticeable = at(10000, 8000, ['activation_blocked'])!;
  assert.equal(noticeable.kind === 'cheaper' && noticeable.effort, 'noticeable');
  assert.match(verdictText(noticeable, 'Deutschland', money).rest, /^Laut Shop lässt sich der Key in Deutschland nicht aktivieren\. Der Umweg spart spürbar/);
  const large = at(2890, 1290)!;
  assert.equal(large.kind === 'cheaper' && large.percent, 55);
  assert.match(verdictText(large, 'Deutschland', money).rest, /Der Unterschied ist groß\.$/);
  // Exactly 15 % is no longer "small"; exactly 30 % is "large".
  assert.equal((at(10000, 8500) as { effort: string }).effort, 'noticeable');
  assert.equal((at(10000, 7000) as { effort: string }).effort, 'large');
  const none = view([link(3, 'India', 500, ['activation_blocked'])], null);
  const only = verdict(summarize(none, offerRows(none, 'base'), 'base', 'DE'), region, 'DE')!;
  assert.equal(only.kind, 'only_world');
  assert.equal(verdictText(only, 'Deutschland', money).lead, 'Für Deutschland gibt es gerade kein gültiges Angebot.');
  assert.equal(verdict(summarize(view([], null), [], 'base', 'DE'), region, 'DE'), null);
});
