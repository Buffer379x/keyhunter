import type { PriceBadgeData } from '../api';
import { Price } from '../components';
import { countryData } from './Country';
import Flag from './Flag';
import { dateTime, money } from './price-format';

// Status vocabulary of the design (03 §6): a missing price is named by its cause.
const states: Record<string, string> = { unknown: 'Noch nicht abgefragt', no_offer: 'Kein Angebot', review: 'Zuordnung prüfen', error: 'Abruf fehlgeschlagen' };

/**
 * Permanent price of one item (list row, edition): the saved price with split cents, or the state as text. A missing price is
 * never drawn as a price. `title` carries scope, time of the query and whether the value is the last known one.
 */
export default function PriceBadge({ badge, className = '', scopeLabel = 'Beobachteter Grundpreis' }: { badge?: PriceBadgeData; className?: string; scopeLabel?: string }) {
  const hasPrice = !!badge && badge.state === 'price' && badge.cents !== null && badge.cents > 0;
  const timestamp = badge?.observed_at ?? badge?.checked_at;
  const title = [scopeLabel, timestamp ? `Abfrage: ${dateTime(timestamp)}` : badge ? 'Noch keine Abfrage' : 'Gespeicherter Preis wird geladen', badge?.stale ? 'Letzter bekannter Preis · erneute Prüfung ausstehend' : null, badge?.pending ? 'Aktualisierung eingeplant' : null].filter(Boolean).join(' · ');
  return <span className={`price-badge ${className} ${hasPrice ? 'known' : 'unknown'} ${badge?.stale ? 'stale' : ''}`} title={title}>
    {hasPrice ? <Price cents={badge!.cents} size="sm" tone={badge!.stale ? 'stale' : 'default'} /> : !badge ? 'Preis wird geladen …' : (badge.state === 'unknown' && badge.pending ? 'Wird gesucht …' : states[badge.state] ?? 'Preis nicht abrufbar')}
  </span>;
}

/** "Indien 12,90 € · −16,00 €": the cheapest region worldwide when it undercuts the target-country price (or when there is none). */
export function WorldCompare({ badge }: { badge?: PriceBadgeData }) {
  const world = badge?.world;
  if (!badge || !world || !Number.isFinite(world.cents)) return null;
  const mine = badge.state === 'price' && badge.cents ? badge.cents : null;
  if (mine !== null && world.cents >= mine) return null;
  const region = countryData(world.region).name;
  return <span className="world-line" title={`Günstigste Region weltweit: ${region} ${money(world.cents)}${world.observed_at ? ` · Abfrage ${dateTime(world.observed_at)}` : ''}. Nicht automatisch im Zielland aktivierbar.`}>
    <Flag region={world.region} /><span>{mine === null ? 'weltweit ab ' : ''}{region} {money(world.cents)}{mine !== null && <> · <strong>−{money(mine - world.cents)}</strong></>}</span>
  </span>;
}
