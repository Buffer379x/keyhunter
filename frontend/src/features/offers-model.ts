// Pure model of the offers view: rows in price order, the target-country best price against the cheapest
// region worldwide, the validity of each offer and the verdict on the detour. No React, no DOM, so it can be unit-tested.
export type Quote = { id: string; seller: string | null; base_cents: number; estimated_total_cents: number | null };
export type Link = {
  id: number;
  source: string;
  url: string;
  review: string;
  can_confirm: boolean;
  eligible: boolean;
  queued: boolean;
  enabled: boolean;
  stale: boolean;
  observed_at: number | null;
  attempted_at: number | null;
  last_error: string | null;
  retry_at: number;
  reasons?: string[];
  renamed?: { from: string; to: string } | null;
  /** Confirmed by hand although the shop data does not match the game automatically (0.6.4). */
  manual_match?: boolean;
  /** Price trend within the game (0.6.5): 0 = mostly the cheapest, 1 = mostly the most expensive, 0.5 = no comparison yet. */
  cheap_score?: number;
  /** Interval of the next check in seconds: shop interval, validity in the target country and price trend. */
  check_every?: number | null;
  /** Check interval factor as 0 to 100 (0.8.2; shown as "Prüftempo", see `tempo`); null for unconfirmed or not yet measured products. */
  score?: number | null;
  product: { name: string; region: string | null; market: string | null; activation: string; availability: string } | null;
  quotes: Quote[];
  /** Why the product does not match plainly (0.9.3, FUNC-01/FUNC-04); empty for a plain match. */
  mismatch?: Mismatch[];
  /** The owner may confirm it by hand: an Xbox key for the wish's system (accounts and PC-only products never). */
  manual_allowed?: boolean;
  /** State of the link's data (0.9.3): only `current` prices may be offered as a saving or a cart action. */
  data_state?: 'current' | 'stale' | 'failed' | 'unknown';
  /** A current price of its region (confirmed, fresh, in stock), whatever the target country. */
  current?: boolean;
  /** Can be bought for the target country: activation confirmed there and the same market (RESP-14). */
  fits_target?: boolean;
  /** End of the freshness limit of the last observation: twice the check interval, at least 24 h (FUNC-05). */
  fresh_until?: number | null;
};
export type Mismatch = 'title' | 'platform' | 'key_type' | 'year';
export type HistoryPoint = {
  observed_at: number;
  base_cents: number | null;
  link_id: number | null;
  region?: string | null;
  source?: string | null;
  /** End of the validity of the winning observation (its link's freshness limit, at least 24 h). */
  fresh_until?: number | null;
};
export type PriceBadgeLike = {
  cents: number | null;
  state: string;
  observed_at: number | null;
  checked_at: number | null;
  stale: boolean;
  pending: boolean;
  refreshing?: boolean;
  world?: { cents: number; region: string | null; observed_at: number | null } | null;
};
export type OffersView = {
  price_badge?: PriceBadgeLike;
  links: Link[];
  history: HistoryPoint[];
  histories?: { preferred: HistoryPoint[]; all: HistoryPoint[] };
  best_base: number | null;
  best_estimate: number | null;
  last_known?: { cents: number; observed_at: number } | null;
  /** Offers of the game by the server's one rule, the same number the wishlist shows (FUNC-11). */
  offer_count: number;
  target_country: string;
  discovery_running: boolean;
  sources: { source: string; status: { enabled: boolean; state: string; last_error: string | null } }[];
  searches: { source: string; status: string; checked_at: number | null; last_error: string | null; result_count: number | null }[];
};
export type Basis = 'base' | 'estimate';

/** A trend counts from this score on (about four measurements in a row as the cheapest). */
const CHEAP_TREND = 0.3;
const EXPENSIVE_TREND = 0.7;
/** "meist günstig" / "meist teuer" from the price trend; null while the trend is undecided. */
export function trendText(link: Link): string | null {
  const score = link.cheap_score;
  if (score === undefined) return null;
  return score <= CHEAP_TREND ? 'meist günstig' : score >= EXPENSIVE_TREND ? 'meist teuer' : null;
}
/** The confirmed, active product whose region has been the cheapest most steadily, or null without a clear trend. */
export function trendLeader(links: Link[]): Link | null {
  const candidates = links.filter(link => link.review === 'confirmed' && link.enabled && link.product && (link.cheap_score ?? 0.5) <= CHEAP_TREND);
  return candidates.reduce<Link | null>((best, link) => (!best || link.cheap_score! < best.cheap_score! ? link : best), null);
}
/** "alle 12 h", "alle 2 Tage", "alle 45 min". */
export function everyText(seconds: number): string {
  if (seconds < 3600) return `alle ${Math.round(seconds / 60)} min`;
  const hours = Math.round(seconds / 3600);
  return hours < 48 ? `alle ${hours} h` : `alle ${Math.round(hours / 24)} Tage`;
}

/** Reasons why a confirmed offer does not count as a current price in the target country, most important first. */
const reasonLabels: [string, string][] = [
  ['activation_blocked', 'In {c} nicht aktivierbar'],
  ['activation_unknown', 'Aktivierung in {c} ungeklärt'],
  ['purchase_context_mismatch', 'Anderer Kaufkontext'],
  ['sold_out', 'Ausverkauft'],
  ['availability_unknown', 'Verfügbarkeit unbekannt'],
  ['source_error', 'Abruffehler'],
  ['stale', 'Veraltet'],
  ['not_a_key', 'Kein Xbox-Key'],
  ['no_price', 'Kein gültiger Preis'],
  ['no_target_country', 'Kein Zielland gewählt'],
];
/** All reasons of a link in a fixed order, with the target country filled in ("DE"). */
export function reasonList(link: Link, country: string): string[] {
  return reasonLabels.filter(([reason]) => link.reasons?.includes(reason)).map(([, label]) => label.replace('{c}', country || 'Zielland'));
}

export type OfferRow = {
  key: string;
  link: Link;
  quote: Quote | null;
  /** Price in cents on the chosen basis; null when there is none (sold out, to be reviewed, fees unknown). */
  price: number | null;
  eligible: boolean;
  current: boolean;
  status: 'priced' | 'fees_unknown' | 'sold_out' | 'review' | 'none';
};

/**
 * Whether the data of a link is a current price (FUNC-03): only then it may show a saving or a cart action. The server
 * decides (`data_state`, and `current` for a key that counts at all); an older payload without them falls back to the
 * flags it has.
 */
export function isCurrent(link: Link): boolean {
  if (link.data_state !== undefined) return link.data_state === 'current' && link.current !== false;
  // Legacy branch (Phase C removes it): a link never observed or with unknown availability is no price either.
  return !link.stale && link.observed_at !== null && !link.reasons?.some(r => r === 'stale' || r === 'source_error' || r === 'availability_unknown');
}

/** One row per observed price, plus one status row per product without a price. Ordered by price only. */
export function offerRows(view: OffersView | null, basis: Basis): OfferRow[] {
  const rows: OfferRow[] = [];
  for (const link of view?.links ?? []) {
    if (link.review === 'rejected' || !link.enabled || !link.product) continue;
    const live = isCurrent(link);
    if (link.review === 'confirmed' && link.quotes.length) {
      for (const quote of link.quotes) {
        const price = basis === 'estimate' ? quote.estimated_total_cents : quote.base_cents;
        rows.push({
          key: `${link.id}-${quote.id}`,
          link,
          quote,
          price,
          eligible: link.eligible,
          current: live && price !== null,
          status: price === null ? 'fees_unknown' : 'priced',
        });
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
  targetCents: number | null;
  targetRow: OfferRow | null;
  /** Cheapest current offer of any region. */
  world: OfferRow | null;
  saving: number;
  savingPercent: number;
  /** Cheaper offers that do not count for the target country. */
  excluded: Excluded;
  validCount: number;
  pricedCount: number;
  /** Rows with a current price, whatever the region: without one the page has no valid price to show. */
  currentCount: number;
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
    targetCents,
    targetRow,
    world,
    saving,
    savingPercent: saving > 0 ? Math.round((saving / targetCents!) * 100) : 0,
    excluded: { count: cheaper.length, reasons, example: cheaper[0] ?? null },
    validCount: live.filter(row => row.eligible).length,
    pricedCount: rows.filter(row => row.price !== null).length,
    currentCount: live.length,
  };
}

/**
 * The fetch failed and nothing current is left to show (RESP-11): a product link whose latest fetch failed, or searches
 * that all ended in an error or a pause, without a current price. The detail then says "Abruf fehlgeschlagen" instead of
 * "keine Angebote".
 */
export function fetchFailed(view: OffersView | null, rows: OfferRow[]): boolean {
  if (!view || rows.some(row => row.current)) return false;
  const links = view.links.some(
    link => link.enabled && link.review !== 'rejected' && (link.data_state === 'failed' || (link.data_state === undefined && !!link.last_error)),
  );
  const searches =
    view.searches.some(search => search.status === 'error') && view.searches.every(search => search.status === 'error' || search.status === 'paused');
  return links || searches;
}

/** The next attempt of a failed fetch (unix seconds) the detail can name, or null. */
export function nextAttempt(view: OffersView, now: number): number | null {
  const times = view.links
    .filter(link => link.enabled && link.retry_at > now && (link.data_state === 'failed' || !!link.last_error))
    .map(link => link.retry_at);
  return times.length ? Math.min(...times) : null;
}

/** Prüftempo of a link (SCORE-03) from the check interval factor (`score`, 0 to 100: factor 0.5 = 100, 1 = 50, 2 = 0). */
export type Tempo = 'häufig' | 'normal' | 'selten';
/**
 * Buckets: from 70 on "häufig" (the interval is at most about three quarters of the shop interval), up to 30 "selten"
 * (at least about a third longer), else "normal". The Help text of the column names the same limits.
 */
export const TEMPO_OFTEN = 70;
export const TEMPO_RARE = 30;
export function tempo(score: number | null | undefined): Tempo | null {
  if (score === null || score === undefined) return null;
  return score >= TEMPO_OFTEN ? 'häufig' : score <= TEMPO_RARE ? 'selten' : 'normal';
}

/**
 * The first sentence of the review note: what does not match plainly (the server's `mismatch`, FUNC-01). A possible
 * namesake of another release year has no shop data to point at, so it gets its own sentence.
 */
export function mismatchText(mismatch: Mismatch[], game: string): string {
  if (mismatch.includes('year')) return `Möglicherweise gehört der Key zu einem gleichnamigen Spiel aus einem anderen Erscheinungsjahr als „${game}“.`;
  const title = mismatch.includes('title'),
    platform = mismatch.includes('platform');
  const subject =
    title && platform
      ? 'Titel oder Edition und Plattform passen'
      : title
        ? 'Titel oder Edition passen'
        : platform
          ? 'Die Plattform passt'
          : 'Titel, Edition oder Plattform passen';
  return `${subject} laut Shop-Daten nicht automatisch zu „${game}“.`;
}

/** A reason label inside a sentence: "In DE nicht aktivierbar" becomes "in DE nicht aktivierbar", nouns keep their capital. */
export const inSentence = (label: string) =>
  /^(In|Anderer|Ausverkauft|Veraltet|Kein) /.test(label) || label === 'Ausverkauft' || label === 'Veraltet'
    ? label.charAt(0).toLowerCase() + label.slice(1)
    : label;

export type Validity = { tone: 'ok' | 'warn' | 'dim' | 'danger'; icon: 'check' | 'alert' | 'x' | 'clock'; text: string };
/** Whether an offer works in the target country, as pill text: valid, unclear (warn) or the main reason why not. */
export function validity(row: OfferRow, code: string): Validity {
  const country = code || 'Zielland';
  const { link } = row;
  if (row.status === 'review') return { tone: 'warn', icon: 'alert', text: 'Zuordnung prüfen' };
  if (row.status === 'sold_out') return { tone: 'dim', icon: 'x', text: 'Ausverkauft' };
  if (link.reasons?.includes('not_a_key')) return { tone: 'dim', icon: 'x', text: inSentence('Kein Xbox-Key') };
  // Without a current price (FUNC-03, FUNC-12) the pill says what is true about the data, not that the key is invalid.
  if (link.data_state === 'failed' || (link.data_state === undefined && link.last_error && !row.quote))
    return { tone: 'danger', icon: 'alert', text: 'Abruffehler' };
  if (link.data_state === 'stale') return { tone: 'dim', icon: 'clock', text: inSentence('Veraltet') };
  if (link.data_state === 'unknown') return { tone: 'dim', icon: 'alert', text: link.observed_at ? 'Verfügbarkeit unbekannt' : 'Noch nicht abgefragt' };
  if (row.eligible) return { tone: 'ok', icon: 'check', text: `in ${country} aktivierbar` };
  if (link.reasons?.includes('activation_unknown')) return { tone: 'warn', icon: 'alert', text: `Aktivierung in ${country} ungeklärt` };
  const reason = reasonList(link, country)[0];
  if (reason) return { tone: 'dim', icon: 'x', text: inSentence(reason) };
  // No reason and no price: say so instead of "not valid in DE".
  return { tone: 'dim', icon: 'x', text: row.price === null ? inSentence('Kein aktueller Preis') : `nicht in ${country} gültig` };
}

/**
 * The verdict below the price comparison: is the cheapest region worth the detour?
 * same: the target country is the cheapest anywhere. cheaper: another region undercuts it (access says whether the key works
 * in the target country). only_world: no valid offer for the target country, but a price elsewhere.
 */
export type Verdict =
  | { kind: 'same' }
  | {
      kind: 'cheaper';
      region: string;
      saving: number;
      percent: number;
      access: 'ok' | 'unclear' | 'blocked' | 'other';
      reasons: string[];
      effort: 'small' | 'noticeable' | 'large';
    }
  | { kind: 'only_world'; region: string; price: number; access: 'ok' | 'unclear' | 'blocked' | 'other'; reasons: string[] };
const access = (row: OfferRow) =>
  row.eligible ? 'ok' : row.link.reasons?.includes('activation_unknown') ? 'unclear' : row.link.reasons?.includes('activation_blocked') ? 'blocked' : 'other';
export function verdict(summary: Summary, regionName: (row: OfferRow) => string, country: string): Verdict | null {
  const { world, targetCents } = summary;
  if (!world) return null;
  const reasons = reasonList(world.link, country);
  if (targetCents === null) return { kind: 'only_world', region: regionName(world), price: world.price!, access: access(world), reasons };
  if (summary.saving <= 0) return { kind: 'same' };
  const rel = summary.saving / targetCents;
  return {
    kind: 'cheaper',
    region: regionName(world),
    saving: summary.saving,
    percent: summary.savingPercent,
    access: access(world),
    reasons,
    effort: rel < 0.15 ? 'small' : rel < 0.3 ? 'noticeable' : 'large',
  };
}

/** The verdict as two sentences: `lead` is set in bold, `rest` follows (wording of the design v4 prototype). */
export function verdictText(v: Verdict, land: string, money: (cents: number) => string): { lead: string; rest: string } {
  const works = (a: Exclude<Verdict, { kind: 'same' }>) =>
    a.access === 'ok'
      ? `Das Angebot gilt auch in ${land}.`
      : a.access === 'unclear'
        ? `Ob der Key in ${land} funktioniert, ist ungeklärt; meist braucht es eine Regionsumstellung im Konto.`
        : a.access === 'blocked'
          ? `Laut Shop lässt sich der Key in ${land} nicht aktivieren.`
          : `Für ${land} zählt das Angebot nicht: ${a.reasons.map(inSentence).join(', ') || 'nicht gültig'}.`;
  if (v.kind === 'same') return { lead: `${land} ist gerade weltweit am günstigsten.`, rest: `Kein Umweg nötig: Der beste Preis gilt direkt in ${land}.` };
  if (v.kind === 'only_world')
    return { lead: `Für ${land} gibt es gerade kein gültiges Angebot.`, rest: `Am günstigsten ist ${v.region} mit ${money(v.price)}. ${works(v)}` };
  const effort =
    v.effort === 'small'
      ? 'Bei so wenig Unterschied lohnt sich der Aufwand kaum.'
      : v.effort === 'noticeable'
        ? 'Der Umweg spart spürbar, ist aber mit Aufwand verbunden.'
        : 'Der Unterschied ist groß.';
  return { lead: `${v.region} spart ${money(v.saving)} (${v.percent} %).`, rest: `${works(v)} ${effort}` };
}
