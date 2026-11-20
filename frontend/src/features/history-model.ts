// Pure helpers for the price history: time window, lowest point, statistics. See PriceHistoryPlot.tsx.
import type { HistoryPoint } from './offers-model.ts';
export const DAY = 86400;
export type Range = 30 | 90 | 365;
export const ranges: Range[] = [30, 90, 365];

const valid = (rows: HistoryPoint[]) => rows.filter(row => row.base_cents !== null);
export const lowestPoint = (rows: HistoryPoint[]): HistoryPoint | null =>
  valid(rows).reduce<HistoryPoint | null>((best, row) => !best || row.base_cents! < best.base_cents! ? row : best, null);
export const highestPoint = (rows: HistoryPoint[]): HistoryPoint | null =>
  valid(rows).reduce<HistoryPoint | null>((best, row) => !best || row.base_cents! > best.base_cents! ? row : best, null);

/** Observations in the last `days` days up to `now` (Unix seconds). */
export const inRange = (rows: HistoryPoint[], days: number, now: number) => rows.filter(row => row.observed_at >= now - days * DAY);

/** Smallest range that holds all observations, so a young history does not sit in the corner of a wide chart. */
export function defaultRange(rows: HistoryPoint[], now: number): Range {
  const first = Math.min(...rows.map(row => row.observed_at));
  if (!Number.isFinite(first)) return 30;
  return ranges.find(days => first >= now - days * DAY) ?? 365;
}

/** Mean of the observed minima (not time-weighted); null for fewer than two observations. */
export function mean(rows: HistoryPoint[]): number | null {
  const cents = valid(rows).map(row => row.base_cents!);
  return cents.length < 2 ? null : Math.round(cents.reduce((a, b) => a + b, 0) / cents.length);
}

/** Change from the first to the last observation in percent; null for fewer than two observations. */
export function changePercent(rows: HistoryPoint[]): number | null {
  const sorted = valid(rows).sort((a, b) => a.observed_at - b.observed_at);
  if (sorted.length < 2) return null;
  return Math.round((sorted[sorted.length - 1].base_cents! - sorted[0].base_cents!) / sorted[0].base_cents! * 100);
}

/** First day of each month inside [start, end] (Unix seconds, local time), for the axis. */
export function monthStarts(start: number, end: number): number[] {
  const out: number[] = [];
  const date = new Date(start * 1000);
  date.setHours(0, 0, 0, 0); date.setDate(1);
  for (let guard = 0; guard < 40; guard++) {
    date.setMonth(date.getMonth() + (guard === 0 ? 0 : 1));
    const at = date.getTime() / 1000;
    if (at > end) break;
    if (at >= start) out.push(at);
  }
  return out;
}
