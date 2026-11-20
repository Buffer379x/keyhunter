import type { PriceBadgeData } from '../api';
import { money,dateTime } from './price-format';
export default function PriceBadge({badge,className='',scopeLabel='Beobachteter Grundpreis'}:{badge?:PriceBadgeData;className?:string;scopeLabel?:string}) {
  const label=!badge?'Preis wird geladen …':badge.state==='price'&&badge.cents!==null&&badge.cents>0?`ab ${money(badge.cents)}${badge.stale?' · veraltet':''}`:({unknown:'Unbekannt',no_offer:'Kein Angebot',review:'Zuordnung prüfen',error:'Abfrage fehlgeschlagen'} as Record<string,string>)[badge.state]??'Preis nicht abrufbar';
  const timestamp=badge?.observed_at??badge?.checked_at;
  const title=[scopeLabel,timestamp?`Abfrage: ${dateTime(timestamp)}`:badge?'Noch keine Abfrage':'Gespeicherter Preis wird geladen',badge?.stale?'Letzter bekannter Preis · erneute Prüfung ausstehend':null,badge?.pending?'Aktualisierung eingeplant':null].filter(Boolean).join(' · ');
  return <span className={`price-badge ${className} ${badge?.state==='price'?'known':'unknown'} ${badge?.stale?'stale':''}`} title={title}>{label}</span>;
}
