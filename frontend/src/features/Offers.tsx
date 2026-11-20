import { useState } from 'react';
import { Button, EmptyState, Icon, Inset, Label, Panel, PanelHead, Pill, Price, Reg, Switch } from '../components';
import { relativeTime } from '../time';
import { regionCode } from './regions';
import { dateTime, money } from './price-format';
import { reasonList, validity } from './offers-model';
import type { Basis, OfferRow, Summary } from './offers-model';
import { BasisSwitch, regionName, shopName } from './PriceTab';
import { shopNames } from './shop-names';
import type { OffersState } from './useOffersView';

export { shopNames } from './shop-names';
export { money, dateTime } from './price-format';
const sourceErrors: Record<string, string> = { network: 'Verbindung fehlgeschlagen', rate_limited: 'Abruflimit erreicht', access_denied: 'Abruf abgelehnt', invalid_response: 'Antwort konnte nicht gelesen werden' };
const searchNames: Record<string, string> = { queued: 'Suche eingeplant', searching: 'Angebote werden gesucht', no_match: 'Keine passenden Produkte gefunden', error: 'Suche fehlgeschlagen', disabled: 'Deaktiviert', paused: 'Abrufe pausiert' };
const missingText = (row: OfferRow) => row.status === 'sold_out' ? 'ausverkauft' : row.status === 'review' ? 'Zuordnung prüfen' : row.status === 'fees_unknown' ? 'Gebühren unbekannt' : 'kein Preis';

type Props = {
  state: OffersState; rows: OfferRow[]; summary: Summary; basis: Basis; onBasis: (basis: Basis) => void; hasEstimates: boolean;
  code: string; searching: boolean; reviewCount: number; onTab: (tab: string) => void;
};

function Seen({ row }: { row: OfferRow }) {
  const at = row.link.observed_at;
  if (!at) return <span className="muted">noch nicht abgefragt</span>;
  const stale = row.link.stale || row.link.reasons?.includes('stale');
  return <time className={stale ? 'seen stale' : 'seen'} dateTime={new Date(at * 1000).toISOString()} title={dateTime(at)}>{stale ? 'veraltet · ' : ''}{relativeTime(at)}</time>;
}

/** Angebote: every offer of every region, ordered by price only, with its validity in the target country and the difference to its best price. */
export default function OffersTab({ state, rows, summary, basis, onBasis, hasEstimates, code, searching, reviewCount, onTab }: Props) {
  const { view, busy, write } = state;
  // Off by default: cheaper regions are never hidden unless the owner asks for it.
  const [onlyValid, setOnlyValid] = useState(false);
  if (!view) return null;
  const shown = onlyValid ? rows.filter(row => row.eligible) : rows;
  const hidden = rows.filter(row => !row.eligible && row.price !== null);
  const bestKey = summary.targetRow?.key;
  const pending = view.links.filter(link => link.review !== 'rejected' && link.enabled && !link.product).length;
  // Search and source states that need attention ("Eneba: Suche eingeplant"), each status as its own text.
  const notes: { who: string; what: string }[] = [
    ...view.searches.filter(search => searchNames[search.status]).map(search => ({ who: shopNames[search.source] ?? search.source, what: `${searchNames[search.status]}${search.last_error ? ` (${sourceErrors[search.last_error] ?? 'Quelle vorübergehend nicht erreichbar'})` : ''}` })),
    ...(view.sources ?? []).filter(source => !source.status.enabled || source.status.last_error).map(source => ({ who: shopNames[source.source] ?? source.source, what: !source.status.enabled ? 'deaktiviert' : sourceErrors[source.status.last_error ?? ''] ?? 'pausiert' })),
    ...(pending > 0 ? [{ who: '', what: `${pending} Produktabrufe ausstehend` }] : []),
  ];
  return <Panel aria-labelledby="offers-title">
    <PanelHead><Label id="offers-title">Angebote · nach Preis</Label><span className="mono faint count">{shown.length} von {rows.length}</span><span className="spacer" />
      {hasEstimates && <BasisSwitch basis={basis} onChange={onBasis} />}
      <Switch checked={onlyValid} onChange={setOnlyValid}>Nur in {code} aktivierbar</Switch></PanelHead>
    <Inset className="table-wrap" tabIndex={0} role="region" aria-label="Angebotstabelle">
      {rows.length === 0 ? <EmptyState icon="search" title={searching ? 'KeyHunter sucht Angebote' : 'Noch keine regionalen Preise'} headingLevel={3}
        action={!searching && <Button disabled={busy} onClick={() => void write('/refresh', 'POST', undefined)}>Angebote automatisch suchen</Button>}>
        {searching ? 'Die Suche nach regionalen Produkten für diese Edition läuft.' : 'Für diese Edition wurden noch keine Angebote gefunden.'}</EmptyState>
        : <table className="offers" aria-label="Angebote nach Preis">
          <thead><tr><th scope="col">Shop</th><th scope="col">Region</th><th scope="col">Gültigkeit</th><th scope="col" className="r" aria-sort="ascending">Preis</th><th scope="col" className="r">vs. {code}</th><th scope="col">Gesehen</th><th scope="col"><span className="sr-only">Link</span></th></tr></thead>
          <tbody>{shown.map(row => {
            const valid = validity(row, code), reasons = row.eligible ? [] : reasonList(row.link, code).slice(1);
            const diff = row.price !== null && summary.targetCents !== null ? row.price - summary.targetCents : null;
            return <tr key={row.key} className={row.key === bestKey ? 'best' : undefined}>
              <td><b className="shop">{shopName(row)}</b>{row.quote?.seller && <small className="muted seller">{row.quote.seller}</small>}</td>
              <td><div className="world-cell"><Reg code={regionCode(row.link.product?.region)} home={regionCode(row.link.product?.region) === code} />{regionName(row)}</div></td>
              <td><Pill tone={valid.tone} icon={valid.icon}>{valid.text}</Pill>{reasons.length > 0 && <small className="muted reasons">{reasons.join(' · ')}</small>}</td>
              <td className="r">{row.price !== null ? <Price cents={row.price} tone={row.key === bestKey ? 'hot' : 'default'} /> : <span className="price-missing">{missingText(row)}</span>}</td>
              <td className="r">{diff === null ? <span className="save none">–</span> : Math.abs(diff) < 1 ? <span className="save none">bester</span>
                : <span className={diff < 0 ? 'save big' : 'save none'}>{diff < 0 ? '−' : '+'}{money(Math.abs(diff))}</span>}</td>
              <td className="muted nowrap"><Seen row={row} /></td>
              <td className="r"><a className="btn sm" href={row.link.url} target="_blank" rel="noopener noreferrer" aria-label={`Zum Shop: ${shopName(row)} · ${regionName(row)}`}>Zum Shop<Icon name="ext" /></a></td>
            </tr>;
          })}</tbody>
        </table>}
      {onlyValid && hidden.length > 0 && <button type="button" className="hidden-strip" onClick={() => setOnlyValid(false)}>
        <span>{hidden.length} {hidden.length === 1 ? 'Angebot' : 'Angebote'} in {code} nicht aktivierbar · {[...new Set(hidden.map(regionName))].slice(0, 4).join(', ')} · ab {money(hidden[0].price!)}</span><b>Anzeigen</b></button>}
    </Inset>
    {(notes.length > 0 || reviewCount > 0 || basis === 'estimate') && <p className="panel-foot">
      {basis === 'estimate' && <span>Geschätzte Gesamtpreise mit den Gebühren aus den Einstellungen</span>}
      {notes.map(note => <span key={note.who + note.what}>{note.who && `${note.who}: `}<span>{note.what}</span></span>)}
      {reviewCount > 0 && <button type="button" className="text-button" onClick={() => onTab('infos')}>{reviewCount} {reviewCount === 1 ? 'Zuordnung' : 'Zuordnungen'} prüfen</button>}
    </p>}
  </Panel>;
}
