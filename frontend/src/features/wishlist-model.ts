import type { AlertEvent, FetchStatusResponse, PriceBadgeData, WishlistItem } from '../api.ts';

/**
 * Pure derivations of the wishlist page (rows, filter chips, KPI tiles) from real API data only:
 * the items, their price badges, the alarm rules, the alert log and the fetch status. Nothing here invents a number;
 * a value that cannot be derived is `null` (or an empty tick list) and the page leaves it out.
 */

/** Share below the target-country price from which the cheapest region counts as "Weltweit günstiger". */
export const WORLD_SHARE = 0.2;

/** The part of an alarm rule the list needs (see PriceAlerts.Rule). */
export interface TargetRule {
  mode: 'target' | 'low';
  basis: 'base' | 'estimate';
  target_cents: number | null;
  enabled: boolean;
}

/** Prices of the list: base prices ("Ohne Gebühren") or estimated totals with the shop fee ("Mit Gebühren", 0.7.3). */
export type PriceBasis = 'base' | 'estimate';

export interface RowFacts {
  /** Best price valid in the target country on the chosen basis (the badge price), null without one. */
  price: number | null;
  /** The same offer on the other basis: the estimated total of a base price, the base price of a total; null when unknown. */
  other: number | null;
  /** Shop of `price`, and whether it is only the last known one. */
  source: string | null;
  stale: boolean;
  /** Cheapest current offer of any region; `other` as above. */
  world: { cents: number; other: number | null; region: string | null; source: string | null; activation: 'confirmed' | 'blocked' | 'unknown' | null } | null;
  /** Cents the cheapest region saves against `price` (only when it is really cheaper). */
  saving: number | null;
  /** `saving` as a share of `price` (0..1). */
  share: number | null;
  /** Alarm target in cents (target rules only, enabled or not). */
  target: number | null;
  /** Enabled base-price target met by the current price. */
  reached: boolean;
  /** Cents above an enabled base-price target ("4,99 € über Ziel"), null when reached or not comparable. */
  over: number | null;
  /** Daily target-country best price, oldest → newest (the badge trend), null when the badge has none. */
  trend: (number | null)[] | null;
  /** Basis of every price above. */
  basis: PriceBasis;
}

const positive = (cents: number | null | undefined) => (typeof cents === 'number' && Number.isFinite(cents) && cents > 0 ? cents : null);
/** Only enabled target rules on the shown basis can be compared with the price ("Ziel erreicht", "über Ziel"). */
const comparable = (rule: TargetRule | null | undefined, basis: PriceBasis) =>
  !!rule && rule.enabled && rule.mode === 'target' && rule.basis === basis && rule.target_cents !== null;

export function rowFacts(badge: PriceBadgeData | undefined, rule: TargetRule | null | undefined, basis: PriceBasis = 'base'): RowFacts {
  const fees = basis === 'estimate' ? badge?.with_fees : undefined;
  const priced = !!badge && badge.state === 'price';
  const price = !priced ? null : basis === 'estimate' ? positive(fees?.cents) : positive(badge!.cents);
  const other = price === null ? null : basis === 'estimate' ? positive(fees?.base_cents) : positive(badge!.estimate_cents);
  const best = basis === 'estimate' ? fees?.world : badge?.world;
  const world =
    best && Number.isFinite(best.cents)
      ? {
          cents: best.cents,
          other: positive(basis === 'estimate' ? best.base_cents : best.estimate_cents),
          region: best.region,
          source: best.source ?? null,
          activation: best.activation,
        }
      : null;
  // A saving against a price that is only the last known one would be invented (FUNC-03).
  const stale = price !== null && !!(basis === 'estimate' ? fees?.stale : badge?.stale);
  const saving = price !== null && !stale && world !== null && world.cents < price ? price - world.cents : null;
  const target = rule && rule.mode === 'target' ? rule.target_cents : null;
  const days = basis === 'estimate' ? fees?.trend : badge?.trend;
  const trend = days && days.some(value => value !== null) ? days : null;
  const reachable = price !== null && comparable(rule, basis);
  return {
    price,
    other,
    source: price === null ? null : ((basis === 'estimate' ? fees?.source : badge?.source) ?? null),
    stale,
    world,
    saving,
    share: saving !== null ? saving / price! : null,
    target,
    reached: reachable && price <= rule!.target_cents!,
    over: reachable && price > rule!.target_cents! ? price - rule!.target_cents! : null,
    trend,
    basis,
  };
}

/**
 * Shops named by the filter text (0.7.4): every shop whose name starts with it, from three letters on ("eneb", "Driffle").
 * The list then also shows the rows where such a shop has the cheapest price, in Preis DE or Preis INT.
 */
export function filterShops(text: string, names: Record<string, string>): string[] {
  const query = text.trim().toLocaleLowerCase('de-DE');
  if (query.length < 3) return [];
  return Object.entries(names)
    .filter(([, name]) => name.toLocaleLowerCase('de-DE').startsWith(query))
    .map(([id]) => id);
}

/** The text filter: a title or alias contains the text, or a named shop ([filterShops]) has the row's cheapest price. */
export function matchesText(titles: string[], facts: RowFacts, text: string, shops: string[]): boolean {
  const query = text.trim().toLocaleLowerCase('de-DE');
  if (!query) return true;
  if (titles.some(title => title.toLocaleLowerCase('de-DE').includes(query))) return true;
  return shops.some(shop => facts.source === shop || facts.world?.source === shop);
}

/** 'pause': wishes paused on their own (0.9.0); a fact of the item, checked by the list itself. */
export type ChipFilter = 'alle' | 'ziel' | 'welt' | 'offen' | 'pause';
const isWorldCheaper = (facts: RowFacts) => facts.share !== null && facts.share >= WORLD_SHARE - 1e-9;
export function matchesChip(facts: RowFacts, chip: ChipFilter): boolean {
  if (chip === 'ziel') return facts.reached;
  if (chip === 'welt') return isWorldCheaper(facts);
  if (chip === 'offen') return facts.price === null;
  return true;
}

export interface Row {
  item: WishlistItem;
  facts: RowFacts;
}

const localDay = (seconds: number) => {
  const date = new Date(seconds * 1000);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
};

/** "Wünsche" ticks: cumulative number of items per local day they were added (empty without creation dates). */
export function addedTicks(items: WishlistItem[]): number[] {
  const dates = items
    .map(item => item.created_at)
    .filter(at => Number.isFinite(at) && at > 0)
    .sort((a, b) => a - b);
  if (!dates.length) return [];
  const ticks: number[] = [];
  let last = '';
  dates.forEach((at, index) => {
    const day = localDay(at);
    if (day === last) ticks[ticks.length - 1] = index + 1;
    else {
      ticks.push(index + 1);
      last = day;
    }
  });
  return ticks;
}

const reachedOn = (row: Row, rule: TargetRule | null | undefined, day: number) => {
  const value = row.facts.trend?.[day];
  return comparable(rule, row.facts.basis) && value !== null && value !== undefined && value <= rule!.target_cents!;
};

/**
 * "Ziel erreicht" from the trend: `since` = items reached now that were not reached at the end of yesterday
 * (null when no row carries a trend), `ticks` = reached items per day of the last `days` days (empty without a trend).
 */
export function reachedTrend(rows: Row[], rules: Record<string, TargetRule | undefined>, days = 9): { since: number | null; ticks: number[] } {
  const withTrend = rows.filter(row => row.facts.trend !== null);
  if (!withTrend.length) return { since: null, ticks: [] };
  const length = Math.max(...withTrend.map(row => row.facts.trend!.length));
  const yesterday = length - 2;
  const since = rows.filter(row => row.facts.reached && row.facts.trend !== null && !reachedOn(row, rules[row.item.id], yesterday)).length;
  const ticks: number[] = [];
  for (let day = Math.max(0, length - days); day < length; day++) ticks.push(withTrend.filter(row => reachedOn(row, rules[row.item.id], day)).length);
  return { since, ticks };
}

interface CheaperKpi {
  count: number;
  best: Row | null;
  ticks: number[];
}
/** "Weltweit günstiger": rows whose cheapest region is at least 20 % below the target-country price, the biggest saving and the sorted savings. */
export function cheaperKpi(rows: Row[]): CheaperKpi {
  const cheaper = rows.filter(row => isWorldCheaper(row.facts));
  const best = rows.reduce<Row | null>((top, row) => (row.facts.saving !== null && (top === null || row.facts.saving > top.facts.saving!) ? row : top), null);
  return { count: cheaper.length, best, ticks: cheaper.map(row => row.facts.saving!).sort((a, b) => a - b) };
}

/** First two words of a title for the KPI foot ("Indiana Jones und der Große Kreis" → "Indiana Jones"). */
export const shortTitle = (title: string) =>
  title
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .join(' ')
    .replace(/[:,–-]+$/, '');

interface FetchKpi {
  used: number;
  limit: number;
  demand: number;
  ticks: number[];
  /** The owner paused the automatic checks (0.7.0). */
  paused: boolean;
  /**
   * Shops whose daily demand is above their own limit (PROD-14). Per shop, not summed: a shop with room to spare cannot run
   * the checks of another one.
   */
  short: string[];
}
/** "Abrufe heute" summed over the enabled shops; with demand and the hourly ticks. */
export function fetchKpi(status: FetchStatusResponse | null, nowMs = Date.now()): FetchKpi | null {
  const shops = status?.shops.filter(shop => shop.enabled) ?? [];
  if (!shops.length) return null;
  const used = shops.reduce((sum, shop) => sum + shop.budget.used, 0);
  const limit = shops.reduce((sum, shop) => sum + shop.budget.limit, 0);
  const demand = shops.reduce((sum, shop) => sum + shop.budget.demand_per_day, 0);
  const hours = shops.map(shop => shop.budget.by_hour);
  const perHour = Array.from({ length: 24 }, (_, hour) => hours.reduce((sum, list) => sum + (list[hour] ?? 0), 0));
  // Up to the current hour (or the last hour with requests, if the server clock is ahead): later hours are still empty.
  const lastActive = perHour.reduce((last, value, hour) => (value > 0 ? hour : last), -1);
  const end = Math.max(new Date(nowMs).getHours(), lastActive);
  let total = 0;
  const ticks = perHour.slice(0, end + 1).map(value => (total += value));
  const short = shops.filter(shop => shop.budget.demand_per_day > shop.budget.limit).map(shop => shop.source);
  return { used, limit, demand, ticks, paused: !!status?.paused_at, short };
}

/** Was an alarm (not a test message) delivered today (local day)? */
export function alarmSentToday(events: AlertEvent[] | null | undefined, nowMs = Date.now()): boolean {
  const today = localDay(nowMs / 1000);
  return !!events?.some(event => event.wish_id !== null && event.sent_at !== null && localDay(event.sent_at) === today);
}

/** Bar heights (px) of the 14-day sparkline, scaled like the prototype (22 px track, min 3 px); null days stay empty. */
export function sparkHeights(trend: (number | null)[]): (number | null)[] {
  const values = trend.filter((value): value is number => value !== null);
  if (!values.length) return trend.map(() => null);
  const low = Math.min(...values) * 0.92,
    high = Math.max(...values);
  return trend.map(value => (value === null ? null : Math.max(3, ((value - low) / (high - low || 1)) * 22)));
}
