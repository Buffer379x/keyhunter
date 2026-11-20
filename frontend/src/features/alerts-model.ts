import type { PriceBadgeData } from '../api.ts';

/** What the Preisalarme table needs from one alert rule (GET /alerts). */
export interface AlarmRule { wish_id: string; title: string; mode: 'target' | 'low'; target_cents: number | null; enabled: boolean }

export interface AlarmRow {
  id: string;
  title: string;
  /** Target in cents; null for "Neuer Tiefstpreis" rules. */
  target: number | null;
  /** Best price in the target country in cents, null while there is none. */
  current: number | null;
  /** current − target in cents (negative: below the target); null without both. */
  distance: number | null;
  reached: boolean;
  enabled: boolean;
  stale: boolean;
}

/**
 * Rows of the Preisalarme table, sorted by distance to the target (closest and reached first, as in the prototype),
 * then rules with a target but no price yet, then "Neuer Tiefstpreis" rules; ties by German title order.
 */
export function alarmRows(rules: AlarmRule[], badges: Record<string, PriceBadgeData | undefined>): AlarmRow[] {
  const rank = (row: AlarmRow) => row.distance !== null ? 0 : row.target !== null ? 1 : 2;
  return rules.map(rule => {
    const badge = badges[rule.wish_id];
    const current = badge?.state === 'price' && typeof badge.cents === 'number' ? badge.cents : null;
    const target = rule.mode === 'target' ? rule.target_cents : null;
    const distance = target !== null && current !== null ? current - target : null;
    return { id: rule.wish_id, title: rule.title, target, current, distance, reached: rule.enabled && distance !== null && distance <= 0, enabled: rule.enabled, stale: !!badge?.stale };
  }).sort((a, b) => rank(a) - rank(b) || (a.distance ?? 0) - (b.distance ?? 0) || a.title.localeCompare(b.title, 'de', { sensitivity: 'base', numeric: true }));
}
