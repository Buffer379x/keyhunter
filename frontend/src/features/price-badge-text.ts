import type { PriceBadgeData } from '../api';
import { dateTime } from './price-format';

/** Tooltip of a saved price: scope, time of the query and whether the value is the last known one. */
export function badgeTitle(badge: PriceBadgeData | undefined, scopeLabel: string) {
  const timestamp = badge?.observed_at ?? badge?.checked_at;
  return [
    scopeLabel,
    timestamp ? `Abfrage: ${dateTime(timestamp)}` : badge ? 'Noch keine Abfrage' : 'Gespeicherter Preis wird geladen',
    badge?.stale ? 'Letzter bekannter Preis · erneute Prüfung ausstehend' : null,
    badge?.pending ? 'Aktualisierung eingeplant' : null,
  ]
    .filter(Boolean)
    .join(' · ');
}
