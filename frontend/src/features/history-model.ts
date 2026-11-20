// Pure helpers for the price history: time windows, day buckets for the dot-matrix chart and statistics. No React, no DOM.
//
// The backend sends each scope ("preferred": valid in the target country, "all": any region) as a step series of
// minima: a point holds from its time until the next point. A measurement never holds longer than FRESH (24 h) and
// never beyond now, so days without a valid measurement stay empty and nothing is interpolated.
import type { HistoryPoint } from './offers-model.ts';
export const DAY = 86400;
const FRESH = DAY;
export type Range = 30 | 90 | 180;
export const ranges: Range[] = [30, 90, 180];

/** 30 days while the whole history fits into it, otherwise 90 (the prototype's default). */
export function defaultRange(rows: HistoryPoint[], now: number): Range {
  const first = Math.min(...rows.filter(row => row.base_cents !== null).map(row => row.observed_at));
  return !Number.isFinite(first) || first >= now - 30 * DAY ? 30 : 90;
}

type Interval = { start: number; end: number; cents: number; region: string | null };
/** The time each price of a step series was valid: until the next point, at most FRESH, never after now. */
export function intervals(points: HistoryPoint[], now: number): Interval[] {
  const sorted = [...points].sort((a, b) => a.observed_at - b.observed_at);
  const out: Interval[] = [];
  sorted.forEach((point, i) => {
    if (point.base_cents === null || point.base_cents <= 0) return;
    const next = sorted[i + 1]?.observed_at ?? Infinity;
    const end = Math.min(next, point.observed_at + FRESH, now);
    if (end > point.observed_at) out.push({ start: point.observed_at, end, cents: point.base_cents, region: point.region ?? null });
  });
  return out;
}

/** Unix seconds of local midnight `back` days before the day of `now`. */
export function dayStart(now: number, back: number): number {
  const date = new Date(now * 1000);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - back);
  return date.getTime() / 1000;
}

export type Cell = { cents: number; region: string | null } | null;
export type Column = {
  /** Days back from today of the first and the last day in the column (0 = today). */
  fromBack: number; toBack: number;
  start: number; end: number;
  /** Lowest valid price in the column per scope; null when no measurement was valid on any of its days. */
  home: Cell; world: Cell;
};

function lowest(series: Interval[], start: number, end: number): Cell {
  let best: Cell = null;
  for (const part of series) if (part.start < end && part.end > start && (!best || part.cents < best.cents)) best = { cents: part.cents, region: part.region };
  return best;
}

/**
 * `days` days up to today in `count` columns of whole local days, oldest first; the last column ends with today.
 * Each column holds the lowest price per scope (minimum per bucket).
 */
export function columns(home: HistoryPoint[], world: HistoryPoint[], days: number, count: number, now: number): Column[] {
  const per = Math.max(1, Math.round(days / count));
  const homeSeries = intervals(home, now), worldSeries = intervals(world, now);
  const out: Column[] = [];
  for (let i = 0; i < count; i++) {
    const toBack = (count - 1 - i) * per, fromBack = toBack + per - 1;
    if (fromBack >= days) continue;
    const start = dayStart(now, fromBack), end = dayStart(now, toBack - 1);
    out.push({ fromBack, toBack, start, end, home: lowest(homeSeries, start, end), world: lowest(worldSeries, start, end) });
  }
  return out;
}

export type Stats = { low: { cents: number; back: number; region: string | null } | null; high: number | null; average: number | null };
/** Lowest (with its most recent day), highest and mean of the daily minima over the last `days` days; days without data do not count. */
export function dailyStats(points: HistoryPoint[], days: number, now: number): Stats {
  const daily = columns(points, [], days, days, now).flatMap(column => column.home ? [{ ...column.home, back: column.toBack }] : []);
  if (!daily.length) return { low: null, high: null, average: null };
  const low = daily.reduce((best, day) => day.cents < best.cents || (day.cents === best.cents && day.back < best.back) ? day : best);
  return {
    low: { cents: low.cents, back: low.back, region: low.region },
    high: Math.max(...daily.map(day => day.cents)),
    average: Math.round(daily.reduce((sum, day) => sum + day.cents, 0) / daily.length),
  };
}

/** "20 Nov." for a day `back` days before today (the prototype's axis label). */
export const dayLabel = (now: number, back: number) =>
  new Date(dayStart(now, back) * 1000).toLocaleDateString('de-DE', { day: '2-digit', month: 'short' }).replace('.', '');
