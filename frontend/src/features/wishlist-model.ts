import type { AlertEvent, FetchStatusResponse, PriceBadgeData, WishlistItem } from '../api.ts';

/**
 * Pure derivations of the wishlist page (rows, filter chips, KPI tiles) from real API data only:
 * the items, their price badges, the alarm rules, the alert log and the fetch status. Nothing here invents a number;
 * a value that cannot be derived is `null` (or an empty tick list) and the page leaves it out.
 */

/** Share below the target-country price from which the cheapest region counts as "Weltweit günstiger". */
export const WORLD_SHARE = 0.2;

/** The part of an alarm rule the list needs (see PriceAlerts.Rule). */
export interface TargetRule { mode: 'target' | 'low'; basis: 'base' | 'estimate'; target_cents: number | null; enabled: boolean }

export interface RowFacts {
  /** Best base price valid in the target country (the badge price), null without one. */
  price: number | null;
  /** Cheapest current offer of any region. */
  world: { cents: number; region: string | null; source: string | null } | null;
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
}

const hasPrice = (badge?: PriceBadgeData) => !!badge && badge.state === 'price' && badge.cents !== null && badge.cents > 0;
/** The badge price is a base price, so only enabled target rules on the base price can be compared with it. */
const comparable = (rule?: TargetRule | null) => !!rule && rule.enabled && rule.mode === 'target' && rule.basis === 'base' && rule.target_cents !== null;

export function rowFacts(badge: PriceBadgeData | undefined, rule: TargetRule | null | undefined): RowFacts {
  const price = hasPrice(badge) ? badge!.cents! : null;
  const world = badge?.world && Number.isFinite(badge.world.cents) ? { cents: badge.world.cents, region: badge.world.region, source: badge.world.source ?? null } : null;
  const saving = price !== null && world !== null && world.cents < price ? price - world.cents : null;
  const target = rule && rule.mode === 'target' ? rule.target_cents : null;
  const trend = badge?.trend && badge.trend.some(value => value !== null) ? badge.trend : null;
  return {
    price, world, saving, share: saving !== null ? saving / price! : null, target,
    reached: price !== null && comparable(rule) && price <= rule!.target_cents!,
    over: price !== null && comparable(rule) && price > rule!.target_cents! ? price - rule!.target_cents! : null, trend,
  };
}

export type ChipFilter = 'alle' | 'ziel' | 'welt' | 'offen';
export const isWorldCheaper = (facts: RowFacts) => facts.share !== null && facts.share >= WORLD_SHARE - 1e-9;
export function matchesChip(facts: RowFacts, chip: ChipFilter): boolean {
  if (chip === 'ziel') return facts.reached;
  if (chip === 'welt') return isWorldCheaper(facts);
  if (chip === 'offen') return facts.price === null;
  return true;
}

export interface Row { item: WishlistItem; facts: RowFacts }

const localDay = (seconds: number) => { const date = new Date(seconds * 1000); return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`; };

/** "Wünsche" ticks: cumulative number of items per local day they were added (empty without creation dates). */
export function addedTicks(items: WishlistItem[]): number[] {
  const dates = items.map(item => item.created_at).filter(at => Number.isFinite(at) && at > 0).sort((a, b) => a - b);
  if (!dates.length) return [];
  const ticks: number[] = [];
  let last = '';
  dates.forEach((at, index) => {
    const day = localDay(at);
    if (day === last) ticks[ticks.length - 1] = index + 1; else { ticks.push(index + 1); last = day; }
  });
  return ticks;
}

const reachedOn = (row: Row, rule: TargetRule | null | undefined, day: number) => {
  const value = row.facts.trend?.[day];
  return comparable(rule) && value !== null && value !== undefined && value <= rule!.target_cents!;
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

export interface CheaperKpi { count: number; best: Row | null; ticks: number[] }
/** "Weltweit günstiger": rows whose cheapest region is at least 20 % below the target-country price, the biggest saving and the sorted savings. */
export function cheaperKpi(rows: Row[]): CheaperKpi {
  const cheaper = rows.filter(row => isWorldCheaper(row.facts));
  const best = rows.reduce<Row | null>((top, row) => row.facts.saving !== null && (top === null || row.facts.saving > top.facts.saving!) ? row : top, null);
  return { count: cheaper.length, best, ticks: cheaper.map(row => row.facts.saving!).sort((a, b) => a - b) };
}

/** First two words of a title for the KPI foot ("Indiana Jones und der Große Kreis" → "Indiana Jones"). */
export const shortTitle = (title: string) => title.split(/\s+/).filter(Boolean).slice(0, 2).join(' ').replace(/[:,–-]+$/, '');

export interface FetchKpi { used: number; limit: number; demand: number | null; ticks: number[];
  /** The owner paused the automatic checks (0.7.0). */
  paused: boolean }
/** "Abrufe heute" summed over the enabled shops; demand and the hourly ticks only when the backend reports them. */
export function fetchKpi(status: FetchStatusResponse | null, nowMs = Date.now()): FetchKpi | null {
  const shops = status?.shops.filter(shop => shop.enabled) ?? [];
  if (!shops.length) return null;
  const used = shops.reduce((sum, shop) => sum + shop.budget.used, 0);
  const limit = shops.reduce((sum, shop) => sum + shop.budget.limit, 0);
  const demands = shops.map(shop => shop.budget.demand_per_day).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const demand = demands.length ? demands.reduce((sum, value) => sum + value, 0) : null;
  const hours = shops.map(shop => shop.budget.by_hour).filter((value): value is number[] => Array.isArray(value) && value.length > 0);
  let ticks: number[] = [];
  if (hours.length) {
    const perHour = Array.from({ length: 24 }, (_, hour) => hours.reduce((sum, list) => sum + (Number(list[hour]) || 0), 0));
    // Up to the current hour (or the last hour with requests, if the server clock is ahead): later hours are still empty.
    const lastActive = perHour.reduce((last, value, hour) => value > 0 ? hour : last, -1);
    const end = Math.max(new Date(nowMs).getHours(), lastActive);
    let total = 0;
    ticks = perHour.slice(0, end + 1).map(value => (total += value));
  }
  return { used, limit, demand, ticks, paused: !!status?.paused_at };
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
  const low = Math.min(...values) * .92, high = Math.max(...values);
  return trend.map(value => value === null ? null : Math.max(3, (value - low) / (high - low || 1) * 22));
}
