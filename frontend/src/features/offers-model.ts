// Pure model of the offers view: rows in price order, the target-country best price against the cheapest
// region worldwide, and the numbers behind the price ruler. No React, no DOM, so it can be unit-tested.
export type Quote = { id: string; seller: string | null; base_cents: number; estimated_total_cents: number | null };
export type Link = {
  id: number; source: string; url: string; review: string; can_confirm: boolean; eligible: boolean; queued: boolean; enabled: boolean;
  stale: boolean; observed_at: number | null; attempted_at: number | null; last_error: string | null; retry_at: number;
  reasons?: string[]; renamed?: { from: string; to: string } | null;
  product: { name: string; region: string | null; market: string | null; activation: string; availability: string } | null;
  quotes: Quote[];
};
export type HistoryPoint = { observed_at: number; base_cents: number | null; link_id: number | null; region?: string | null; source?: string | null };
export type PriceBadgeLike = { cents: number | null; state: string; observed_at: number | null; checked_at: number | null; stale: boolean; pending: boolean; world?: { cents: number; region: string | null; observed_at: number | null } | null };
export type OffersView = {
  price_badge?: PriceBadgeLike; links: Link[]; history: HistoryPoint[];
  histories?: { preferred: HistoryPoint[]; all: HistoryPoint[] };
  best_base: number | null; best_estimate: number | null; last_known?: { cents: number; observed_at: number } | null;
  target_country: string; discovery_running: boolean;
  sources: { source: string; status: { enabled: boolean; state: string; last_error: string | null } }[];
  searches: { source: string; status: string; checked_at: number | null; last_error: string | null; result_count: number | null }[];
};
export type Basis = 'base' | 'estimate';

/** Reasons why a confirmed offer does not count as a current price in the target country, most important first. */
const reasonLabels: [string, string][] = [
  ['activation_blocked', 'In {c} nicht aktivierbar'], ['activation_unknown', 'Aktivierung in {c} ungeklärt'],
  ['purchase_context_mismatch', 'Anderer Kaufkontext'], ['sold_out', 'Ausverkauft'], ['availability_unknown', 'Verfügbarkeit unbekannt'],
  ['source_error', 'Abruffehler'], ['stale', 'Veraltet'], ['no_target_country', 'Kein Zielland gewählt'],
];
/** All reasons of a link in a fixed order, with the target country filled in ("DE"). */
export function reasonList(link: Link, country: string): string[] {
  return reasonLabels.filter(([reason]) => link.reasons?.includes(reason)).map(([, label]) => label.replace('{c}', country || 'Zielland'));
}

export type OfferRow = {
  key: string; link: Link; quote: Quote | null;
  /** Price in cents on the chosen basis; null when there is none (sold out, to be reviewed, fees unknown). */
  price: number | null;
  eligible: boolean; current: boolean;
  status: 'priced' | 'fees_unknown' | 'sold_out' | 'review' | 'none';
};

/** One row per observed price, plus one status row per product without a price. Ordered by price only. */
export function offerRows(view: OffersView | null, basis: Basis): OfferRow[] {
  const rows: OfferRow[] = [];
  for (const link of view?.links ?? []) {
    if (link.review === 'rejected' || !link.enabled || !link.product) continue;
    const dead = !!link.stale || !!link.reasons?.some(r => r === 'stale' || r === 'source_error');
    if (link.review === 'confirmed' && link.quotes.length) {
      for (const quote of link.quotes) {
        const price = basis === 'estimate' ? quote.estimated_total_cents : quote.base_cents;
        rows.push({ key: `${link.id}-${quote.id}`, link, quote, price, eligible: link.eligible, current: !dead && price !== null, status: price === null ? 'fees_unknown' : 'priced' });
      }
    } else {
      const status = link.review !== 'confirmed' ? 'review' : link.product.availability === 'sold_out' ? 'sold_out' : 'none';
      rows.push({ key: `${link.id}-`, link, quote: null, price: null, eligible: false, current: false, status });
    }
  }
  const order = (row: OfferRow) => row.price ?? Infinity;
  return rows.sort((a, b) => order(a) - order(b) || Number(b.eligible) - Number(a.eligible) || a.link.id - b.link.id);
}

export type Excluded = { count: number; reasons: string[]; example: OfferRow | null };
export type Summary = {
  /** Best price that counts in the target country (null: none), and the offer behind it. */
  targetCents: number | null; targetRow: OfferRow | null;
  /** Cheapest current offer of any region. */
  world: OfferRow | null;
  saving: number; savingPercent: number;
  /** Cheaper offers that do not count for the target country. */
  excluded: Excluded;
  validCount: number; pricedCount: number;
};
export function summarize(view: OffersView | null, rows: OfferRow[], basis: Basis, country: string): Summary {
  const targetCents = (basis === 'estimate' ? view?.best_estimate : view?.best_base) ?? null;
  const live = rows.filter(row => row.current && row.price !== null);
  const world = live[0] ?? null;
  const targetRow = targetCents === null ? null : (live.find(row => row.eligible && row.price === targetCents) ?? null);
  const saving = world && targetCents !== null && world.price! < targetCents ? targetCents - world.price! : 0;
  const cheaper = live.filter(row => !row.eligible && (targetCents === null || row.price! < targetCents));
  const reasons = [...new Set(cheaper.map(row => reasonList(row.link, country)[0]).filter(Boolean))];
  return {
    targetCents, targetRow, world, saving, savingPercent: saving > 0 ? Math.round(saving / targetCents! * 100) : 0,
    excluded: { count: cheaper.length, reasons, example: cheaper[0] ?? null },
    validCount: live.filter(row => row.eligible).length, pricedCount: rows.filter(row => row.price !== null).length,
  };
}

/** "1,08 € unter deinem Ziel" numbers: positive when the price is below the target. */
export const belowTarget = (price: number, target: number) => target - price;

/** Scale of the price ruler: the shown range, grid steps and the position (0 to 100 %) of a price. */
export type Ruler = { lo: number; hi: number; ticks: { cents: number; pos: number }[]; pos: (cents: number) => number };
export function ruler(values: number[]): Ruler | null {
  const known = values.filter(Number.isFinite);
  if (!known.length) return null;
  const min = Math.min(...known), max = Math.max(...known);
  const pad = Math.max((max - min) * 0.12, 150);
  const lo = Math.max(0, min - pad), hi = max + pad;
  const step = [100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000].find(s => (hi - lo) / s <= 6) ?? 100000;
  const ticks: Ruler['ticks'] = [];
  for (let cents = Math.ceil(lo / step) * step; cents <= hi; cents += step) ticks.push({ cents, pos: (cents - lo) / (hi - lo) * 100 });
  return { lo, hi, ticks, pos: cents => (cents - lo) / (hi - lo) * 100 };
}

/** Labels on the ruler share two lanes so that close prices do not overprint each other. */
export function labelLanes(positions: number[], minGap = 22): number[] {
  const order = positions.map((pos, i) => ({ pos, i })).sort((a, b) => a.pos - b.pos);
  const lanes: number[] = new Array(positions.length).fill(0);
  const last = [-Infinity, -Infinity];
  for (const { pos, i } of order) {
    const lane = pos - last[0] >= minGap ? 0 : pos - last[1] >= minGap ? 1 : 0;
    lanes[i] = lane; last[lane] = pos;
  }
  return lanes;
}

/** A reason label inside a sentence: "In DE nicht aktivierbar" becomes "in DE nicht aktivierbar", nouns keep their capital. */
export const inSentence = (label: string) => /^(In|Anderer|Ausverkauft|Veraltet|Kein) /.test(label) || label === 'Ausverkauft' || label === 'Veraltet' ? label.charAt(0).toLowerCase() + label.slice(1) : label;
