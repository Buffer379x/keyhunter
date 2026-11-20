import type { PriceBadgeData } from '../api';
import { Price } from '../components';
import { dateTime } from './price-format';

// Status vocabulary of the design (03 §6): a missing price is named by its cause.
const states: Record<string, string> = { unknown: 'Noch nicht abgefragt', no_offer: 'Kein Angebot', review: 'Zuordnung prüfen', error: 'Abruf fehlgeschlagen' };
/** Text for a badge without a price ("Wird gesucht …", "Kein Angebot", …); the wishlist rows and the edition list share it. */
export const badgeStateText = (badge: PriceBadgeData | undefined) => !badge ? 'Preis wird geladen …' : badge.state === 'unknown' && badge.pending ? 'Wird gesucht …' : states[badge.state] ?? 'Preis nicht abrufbar';
/** Tooltip of a saved price: scope, time of the query and whether the value is the last known one. */
export function badgeTitle(badge: PriceBadgeData | undefined, scopeLabel: string) {
  const timestamp = badge?.observed_at ?? badge?.checked_at;
  return [scopeLabel, timestamp ? `Abfrage: ${dateTime(timestamp)}` : badge ? 'Noch keine Abfrage' : 'Gespeicherter Preis wird geladen', badge?.stale ? 'Letzter bekannter Preis · erneute Prüfung ausstehend' : null, badge?.pending ? 'Aktualisierung eingeplant' : null].filter(Boolean).join(' · ');
}

/**
 * Permanent price of one item (edition list): the saved price with split cents, or the state as text. A missing price is
 * never drawn as a price. `title` carries scope, time of the query and whether the value is the last known one.
 */
export default function PriceBadge({ badge, className = '', scopeLabel = 'Beobachteter Grundpreis' }: { badge?: PriceBadgeData; className?: string; scopeLabel?: string }) {
  const hasPrice = !!badge && badge.state === 'price' && badge.cents !== null && badge.cents > 0;
  return <span className={`price-badge ${className} ${hasPrice ? 'known' : 'unknown'} ${badge?.stale ? 'stale' : ''}`} title={badgeTitle(badge, scopeLabel)}>
    {hasPrice ? <Price cents={badge!.cents} tone={badge!.stale ? 'stale' : 'default'} /> : badgeStateText(badge)}
  </span>;
}
