import type { PriceBadgeData } from '../api.ts';
export function mergeBadges(current: Record<string, PriceBadgeData>, incoming: Record<string, PriceBadgeData>): Record<string, PriceBadgeData> {
  const result = { ...current };
  for (const [id, badge] of Object.entries(incoming)) {
    const previous = result[id];
    if (previous?.checked_at != null && (badge.checked_at ?? -1) < previous.checked_at) continue;
    result[id] = badge;
  }
  return result;
}
