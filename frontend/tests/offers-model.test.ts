import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchFailed,
  mismatchText,
  nextAttempt,
  offerRows,
  summarize,
  reasonList,
  tempo,
  validity,
  verdict,
  verdictText,
} from '../src/features/offers-model.ts';
import type { Link, OffersView } from '../src/features/offers-model.ts';

const link = (id: number, region: string, cents: number, reasons: string[] = [], extra: Partial<Link> = {}): Link => ({
  id,
  source: 'eneba',
  url: 'https://example.test',
  review: 'confirmed',
  can_confirm: true,
  eligible: reasons.length === 0,
  queued: false,
  enabled: true,
  stale: false,
  observed_at: 1,
  attempted_at: 1,
  last_error: null,
  retry_at: 0,
  reasons,
  product: {
    name: 'p',
    region,
    market: 'DE',
    activation: reasons.length ? 'unknown' : 'confirmed',
    availability: reasons.includes('sold_out') ? 'sold_out' : 'in_stock',
  },
  quotes: reasons.includes('sold_out')
    ? []
    : [{ id: String(id), seller: null, base_cents: cents, estimated_total_cents: region === 'India' ? null : cents + 100 }],
  ...extra,
});
const view = (links: Link[], best: number | null, estimate: number | null = null): OffersView => ({
  links,
  history: [],
  best_base: best,
  best_estimate: estimate,
  offer_count: links.reduce((n, l) => n + (l.review === 'confirmed' ? l.quotes.length : 0), 0),
  target_country: 'DE',
  discovery_running: false,
  sources: [],
  searches: [],
});

test('rows are ordered by price only; cheaper foreign offers stay on top and sold-out rows come last', () => {
  const v = view(
    [link(1, 'DE', 3000), link(2, 'USA', 1000, ['activation_unknown']), link(3, 'India', 500, ['activation_blocked']), link(4, 'Europe', 0, ['sold_out'])],
    3000,
  );
  assert.deepEqual(
    offerRows(v, 'base').map(r => r.link.id),
    [3, 2, 1, 4],
  );
  assert.equal(offerRows(v, 'base')[3].status, 'sold_out');
  // Estimated totals: India has no estimate and moves behind the offers that have one.
  assert.deepEqual(
    offerRows(v, 'estimate')
      .map(r => r.link.id)
      .slice(0, 3),
    [2, 1, 3],
  );
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
  assert.deepEqual(reasonList(link(1, 'X', 1, ['purchase_context_mismatch', 'activation_unknown']), 'DE'), [
    'Aktivierung in DE ungeklärt',
    'Anderer Kaufkontext',
  ]);
});

test('reason labels keep nouns capitalised inside a sentence', async () => {
  const { inSentence } = await import('../src/features/offers-model.ts');
  assert.equal(inSentence('In DE nicht aktivierbar'), 'in DE nicht aktivierbar');
  assert.equal(inSentence('Anderer Kaufkontext'), 'anderer Kaufkontext');
  assert.equal(inSentence('Aktivierung in DE ungeklärt'), 'Aktivierung in DE ungeklärt');
  assert.equal(inSentence('Ausverkauft'), 'ausverkauft');
});

const money = (cents: number) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(cents / 100);
const region = (row: { link: Link }) => (row.link.product?.region === 'India' ? 'Indien' : (row.link.product?.region ?? ''));

test('validity: valid, unclear activation, blocked and review rows each name their state', () => {
  const v = view([link(1, 'DE', 3000), link(2, 'USA', 1000, ['activation_unknown']), link(3, 'India', 500, ['activation_blocked'])], 3000);
  const rows = offerRows(v, 'base');
  assert.deepEqual(
    rows.map(r => [r.link.id, validity(r, 'DE').tone, validity(r, 'DE').text]),
    [
      [3, 'dim', 'in DE nicht aktivierbar'],
      [2, 'warn', 'Aktivierung in DE ungeklärt'],
      [1, 'ok', 'in DE aktivierbar'],
    ],
  );
  const review = offerRows(view([{ ...link(4, 'DE', 100), review: 'pending' }], null), 'base')[0];
  assert.equal(validity(review, 'DE').text, 'Zuordnung prüfen');
});

test('verdict: same price, cheaper region with the effort thresholds 15 % and 30 %, and no valid offer', () => {
  const at = (target: number, cheap: number, reasons = ['activation_unknown']) => {
    const v = view([link(1, 'DE', target), link(2, 'India', cheap, reasons)], target);
    return verdict(summarize(v, offerRows(v, 'base'), 'base', 'DE'), region, 'DE');
  };
  const same = verdict(summarize(view([link(1, 'DE', 3000)], 3000), offerRows(view([link(1, 'DE', 3000)], 3000), 'base'), 'base', 'DE'), region, 'DE')!;
  assert.deepEqual(verdictText(same, 'Deutschland', money), {
    lead: 'Deutschland ist gerade weltweit am günstigsten.',
    rest: 'Kein Umweg nötig: Der beste Preis gilt direkt in Deutschland.',
  });
  const small = at(10000, 9000)!;
  assert.equal(small.kind === 'cheaper' && small.effort, 'small');
  assert.equal(verdictText(small, 'Deutschland', money).lead, 'Indien spart 10,00\u00a0€ (10 %).');
  assert.match(
    verdictText(small, 'Deutschland', money).rest,
    /ungeklärt; meist braucht es eine Regionsumstellung im Konto\. Bei so wenig Unterschied lohnt sich der Aufwand kaum\.$/,
  );
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

test('the review note names what does not match, and a possible namesake of another year (FUNC-01)', () => {
  assert.equal(mismatchText(['title'], 'Doom'), 'Titel oder Edition passen laut Shop-Daten nicht automatisch zu „Doom“.');
  assert.equal(mismatchText(['platform'], 'Doom'), 'Die Plattform passt laut Shop-Daten nicht automatisch zu „Doom“.');
  assert.equal(mismatchText(['title', 'platform'], 'Doom'), 'Titel oder Edition und Plattform passen laut Shop-Daten nicht automatisch zu „Doom“.');
  assert.match(mismatchText(['year'], 'Doom'), /gleichnamigen Spiel aus einem anderen Erscheinungsjahr als „Doom“/);
  assert.equal(mismatchText([], 'Doom'), 'Titel, Edition oder Plattform passen laut Shop-Daten nicht automatisch zu „Doom“.');
});

test('a product that is no Xbox key names that as its reason (FUNC-04)', () => {
  const account = link(1, 'Global', 300, ['not_a_key'], { manual_match: true });
  assert.deepEqual(reasonList(account, 'DE'), ['Kein Xbox-Key']);
  assert.equal(validity(offerRows(view([account], null), 'base')[0], 'DE').text, 'kein Xbox-Key');
});

test('FUNC-03: only data_state current counts as a price; stale, failed and unknown offers give no saving', () => {
  const links = [
    link(1, 'DE', 3000, [], { data_state: 'current', current: true, fits_target: true }),
    link(2, 'India', 500, ['stale'], { data_state: 'stale', current: false }),
    link(3, 'Turkey', 600, ['source_error'], { data_state: 'failed', current: false, last_error: 'network' }),
    link(4, 'Brazil', 700, ['availability_unknown'], { data_state: 'unknown', current: false }),
    link(5, 'Global', 800, ['not_a_key'], { data_state: 'current', current: false }),
  ];
  const v = view(links, 3000);
  const rows = offerRows(v, 'base');
  assert.deepEqual(
    rows.map(r => [r.link.id, r.current]),
    [
      [2, false],
      [3, false],
      [4, false],
      [5, false],
      [1, true],
    ],
  );
  const s = summarize(v, rows, 'base', 'DE');
  assert.equal(s.world?.link.id, 1);
  assert.equal(s.saving, 0);
  assert.equal(s.currentCount, 1);
});

test('FUNC-12: a row without a current price never says "nicht in DE gültig"', () => {
  const text = (extra: Partial<Link>, reasons: string[] = []) => {
    const row = offerRows(view([link(1, 'India', 500, reasons, { eligible: false, ...extra })], null), 'base')[0];
    return validity(row, 'DE').text;
  };
  assert.equal(text({ data_state: 'stale' }, ['stale']), 'veraltet');
  assert.equal(text({ data_state: 'failed', last_error: 'network' }, ['source_error']), 'Abruffehler');
  assert.equal(text({ data_state: 'unknown' }, ['availability_unknown']), 'Verfügbarkeit unbekannt');
  assert.equal(text({ data_state: 'unknown', observed_at: null }), 'Noch nicht abgefragt');
  assert.equal(text({ data_state: 'current', current: false }, ['no_price']), 'kein gültiger Preis');
  // A confirmed link without any quote and without a reason has no price: that is what the pill says.
  const none = offerRows(view([link(2, 'India', 500, [], { eligible: false, quotes: [], data_state: 'current' })], null), 'base')[0];
  assert.equal(validity(none, 'DE').text, 'kein aktueller Preis');
  assert.ok(![text({ data_state: 'stale' }, ['stale']), validity(none, 'DE').text].some(t => t.includes('nicht in DE gültig')));
  assert.equal(text({ data_state: 'current', current: false }, ['not_a_key']), 'kein Xbox-Key');
});

test('RESP-11: a failed fetch is told apart from "no offers"', () => {
  const failedLink = link(1, 'India', 500, ['source_error'], { data_state: 'failed', last_error: 'network', retry_at: 5000 });
  const v = view([failedLink], null);
  assert.equal(fetchFailed(v, offerRows(v, 'base')), true);
  assert.equal(nextAttempt(v, 1000), 5000);
  assert.equal(nextAttempt(v, 6000), null);
  // Searches that all ended in an error, without any link.
  const searches = { ...view([], null), searches: [{ source: 'eneba', status: 'error', checked_at: 1, last_error: 'network', result_count: null }] };
  assert.equal(fetchFailed(searches, []), true);
  // Nothing wrong, nothing found: "no offers".
  const quiet = { ...view([], null), searches: [{ source: 'eneba', status: 'no_match', checked_at: 1, last_error: null, result_count: 0 }] };
  assert.equal(fetchFailed(quiet, []), false);
  // A current price elsewhere: not a failure.
  const ok = view([link(2, 'DE', 3000), failedLink], 3000);
  assert.equal(fetchFailed(ok, offerRows(ok, 'base')), false);
  assert.equal(fetchFailed(null, []), false);
});

test('SCORE-03: the Prüftempo buckets are häufig from 70, selten up to 30, normal between', () => {
  assert.deepEqual([100, 70, 69, 50, 31, 30, 0].map(tempo), ['häufig', 'häufig', 'normal', 'normal', 'normal', 'selten', 'selten']);
  assert.equal(tempo(null), null);
  assert.equal(tempo(undefined), null);
});
