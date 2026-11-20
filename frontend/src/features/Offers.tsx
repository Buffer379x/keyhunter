import { useState } from 'react';
import { Button, EmptyState, Icon, IconButton, Label, Panel, Pill, Price, Switch } from '../components';
import { relativeTime } from '../time';
import { countryData } from './Country';
import Flag from './Flag';
import { dateTime, money } from './price-format';
import { reasonList } from './offers-model';
import type { Basis, OfferRow, OffersView, Summary } from './offers-model';
import { BasisSwitch } from './PriceTab';
import { shopNames } from './shop-names';
import type { OffersState } from './useOffersView';

export { shopNames } from './shop-names';
export { money, dateTime } from './price-format';
const sourceErrors: Record<string, string> = { network: 'Verbindung fehlgeschlagen', rate_limited: 'Abruflimit erreicht', access_denied: 'Abruf abgelehnt', invalid_response: 'Antwort konnte nicht gelesen werden' };
const searchNames: Record<string, string> = { queued: 'Suche eingeplant', searching: 'Angebote werden gesucht', complete: 'Suche abgeschlossen', no_match: 'Keine passenden Produkte gefunden', error: 'Suche fehlgeschlagen', disabled: 'Deaktiviert', paused: 'Abrufe pausiert' };

type Props = {
  state: OffersState; rows: OfferRow[]; summary: Summary; basis: Basis; onBasis: (basis: Basis) => void;
  targetCode: string; targetLabel: string; editionName: string; wide: boolean; searching: boolean; reviewCount: number; onTab: (tab: string) => void;
};

/** Validity of an offer in the target country as visible text with icon: valid, or the reasons why not. */
function Validity({ row, code, best, view }: { row: OfferRow; code: string; best: boolean; view: OffersView }) {
  if (row.status === 'review') return <Pill tone="warn" icon="alert">Zuordnung prüfen</Pill>;
  if (row.status === 'sold_out') return <Pill tone="default" icon="x">Ausverkauft</Pill>;
  if (row.link.last_error && !row.quote) return <Pill tone="danger" icon="alert">Abruffehler</Pill>;
  if (row.eligible) return <span className="validity"><Pill tone="ok" icon="check">in {code} aktivierbar</Pill>{best && <Pill tone="ok" icon="check">Bestpreis</Pill>}</span>;
  const reasons = reasonList(row.link, view.target_country);
  return <span className="validity"><Pill tone="default" icon="x">{reasons[0] ?? `nicht in ${code}`}</Pill>{reasons.length > 1 && <small>{reasons.slice(1).join(' · ')}</small>}</span>;
}
const missingText = (row: OfferRow) => row.status === 'sold_out' ? 'ausverkauft' : row.status === 'review' ? 'Zuordnung prüfen' : row.status === 'fees_unknown' ? 'Gebühren unbekannt' : 'kein Preis';
function Age({ row }: { row: OfferRow }) {
  const at = row.link.observed_at;
  if (!at) return <span className="age">noch keine Abfrage</span>;
  const stale = row.link.stale || row.link.reasons?.includes('stale');
  return <time className={`age ${stale ? 'stale' : ''}`} dateTime={new Date(at * 1000).toISOString()} title={dateTime(at)}>{stale ? 'Veraltet · ' : ''}{relativeTime(at)}</time>;
}
const shopMark = (source: string) => <span className={`shop-mark ${source}`} aria-hidden="true">{(shopNames[source] ?? source).charAt(0)}</span>;

export default function OffersTab({ state, rows, summary, basis, onBasis, targetCode, targetLabel, editionName, wide, searching, reviewCount, onTab }: Props) {
  const { view, busy, write } = state;
  const [onlyValid, setOnlyValid] = useState(false);
  if (!view) return <p role="status">Preisdaten werden geladen …</p>;
  const code = targetCode || view.target_country;
  const shown = onlyValid ? rows.filter(row => row.eligible) : rows;
  const hidden = rows.length - shown.length;
  const hiddenRows = rows.filter(row => !row.eligible && row.price !== null);
  const bestKey = summary.targetRow?.key;
  const pending = view.links.filter(link => link.review !== 'rejected' && link.enabled && !link.product).length;
  const refresh = <IconButton label="Preise prüfen" disabled={busy || searching} onClick={() => void write('/refresh', 'POST', undefined, 'Angebotssuche angefragt.')}><Icon name="refresh" size={16} /></IconButton>;
  const sortKey = basis === 'estimate' ? 'estimate' : 'base';
  return <Panel padded className="offers-card" aria-labelledby="offers-title">
    <div className="offers-head">
      <Label as="h3" id="offers-title">{summary.validCount} von {summary.pricedCount} in {code} aktivierbar · {editionName}</Label>
      <div className="offers-controls">
        <Switch checked={onlyValid} onChange={setOnlyValid}>Nur in {code} aktivierbar</Switch>
        <BasisSwitch basis={basis} onChange={onBasis} />
        {refresh}
      </div>
    </div>
    {rows.length === 0 && <EmptyState icon="search" title={searching ? 'KeyHunter sucht Angebote' : 'Noch keine regionalen Preise'} headingLevel={3}
      action={!searching && <Button disabled={busy} onClick={() => void write('/refresh', 'POST', undefined)}>Angebote automatisch suchen</Button>}>
      {searching ? 'Die Suche nach regionalen Produkten für diese Edition läuft.' : 'Für diese Edition wurden noch keine Angebote gefunden.'}</EmptyState>}
    {shown.length > 0 && (wide
      ? <div className="offer-scroll" tabIndex={0} role="region" aria-label="Angebotstabelle"><table className="offer-table" aria-label="Angebote nach Preis">
        <thead><tr><th scope="col">Shop</th><th scope="col">Region</th><th scope="col">Verkäufer</th>
          <th scope="col" className="num" aria-sort={sortKey === 'base' ? 'ascending' : undefined}>Grundpreis</th>
          <th scope="col" className="num" aria-sort={sortKey === 'estimate' ? 'ascending' : undefined}>Geschätzt</th>
          <th scope="col">Stand</th><th scope="col"><span className="sr-only">Link</span></th></tr></thead>
        <tbody>{shown.map(row => {
          const region = countryData(row.link.product?.region);
          const best = row.key === bestKey;
          return <tr key={row.key} className={`offer-row ${best ? 'best' : ''} ${row.eligible ? '' : 'invalid'}`}>
            <td><span className="shop-cell">{shopMark(row.link.source)}<strong>{shopNames[row.link.source] ?? row.link.source}</strong></span></td>
            <td><span className="region-cell"><span className="region-name"><Flag region={region.name} />{region.name}</span><Validity row={row} code={code} best={best} view={view} /></span></td>
            <td className="seller" title={row.quote && !row.quote.seller ? 'Verkäufer nicht angegeben' : undefined}>{row.quote?.seller ?? '–'}</td>
            <td className="num">{row.quote ? <Price cents={row.quote.base_cents} /> : <span className="missing">{missingText(row)}</span>}</td>
            <td className="num muted">{row.quote ? row.quote.estimated_total_cents !== null ? <Price cents={row.quote.estimated_total_cents} tone="stale" /> : 'Gebühren unbekannt' : '–'}</td>
            <td><Age row={row} /></td>
            <td className="link-cell"><a className="icon-btn open-offer" aria-label={`Angebot bei ${shopNames[row.link.source] ?? row.link.source} · ${region.name} öffnen`} href={row.link.url} target="_blank" rel="noopener noreferrer"><Icon name="ext" size={16} /></a></td>
          </tr>;
        })}</tbody></table></div>
      : <ul className="offer-cards" aria-label="Angebote nach Preis">{shown.map(row => {
        const region = countryData(row.link.product?.region);
        const best = row.key === bestKey;
        const price = row.quote ? (basis === 'estimate' ? row.quote.estimated_total_cents : row.quote.base_cents) : null;
        return <li key={row.key} className={`offer-card ${best ? 'best' : ''} ${row.eligible ? '' : 'invalid'}`}>
          {shopMark(row.link.source)}
          <div className="offer-card-main"><strong>{shopNames[row.link.source] ?? row.link.source} · <span className="region-name"><Flag region={region.name} />{region.name}</span></strong>
            <Validity row={row} code={code} best={best} view={view} />
            <small>{row.quote?.seller ? `${row.quote.seller} · ` : ''}<Age row={row} /></small></div>
          <div className="offer-card-price">{price !== null ? <Price cents={price} /> : <span className="missing">{missingText(row)}</span>}
            {row.quote && price !== null && basis === 'base' && row.quote.estimated_total_cents !== null && <small>{money(row.quote.estimated_total_cents)} geschätzt</small>}
            <a className="icon-btn open-offer" aria-label={`Angebot bei ${shopNames[row.link.source] ?? row.link.source} · ${region.name} öffnen`} href={row.link.url} target="_blank" rel="noopener noreferrer"><Icon name="ext" size={16} /></a></div>
        </li>;
      })}</ul>)}
    {onlyValid && hidden > 0 && <button type="button" className="hidden-strip" onClick={() => setOnlyValid(false)}>
      <span>{hidden} {hidden === 1 ? 'Angebot' : 'Angebote'} in {code} nicht aktivierbar · {[...new Set(hiddenRows.map(row => countryData(row.link.product?.region).name))].slice(0, 4).join(', ')}{hiddenRows[0] ? ` · ab ${money(hiddenRows[0].price!)}` : ''}</span><strong>Anzeigen</strong></button>}
    <div className="offers-foot">
      <span>{basis === 'estimate' ? 'Geschätzte Gesamtpreise mit den Gebühren aus den Einstellungen' : 'Grundpreise ohne Gebühren'}</span>
      {reviewCount > 0 && <button type="button" className="review-link" onClick={() => onTab('infos')}>{reviewCount} {reviewCount === 1 ? 'Zuordnung' : 'Zuordnungen'} prüfen</button>}
      {pending > 0 && <span>{pending} Produktabrufe ausstehend</span>}
    </div>
    {view.searches.map(search => <div className="source-state" key={search.source}><span className={`status-dot ${['queued', 'searching'].includes(search.status) ? 'searching' : ''}`} aria-hidden="true" /><strong>{shopNames[search.source] ?? search.source}</strong><span>{searchNames[search.status] ?? search.status}</span>{search.last_error && <span>{sourceErrors[search.last_error] ?? 'Quelle vorübergehend nicht erreichbar'}</span>}</div>)}
    {view.sources?.filter(source => !source.status.enabled || source.status.last_error).map(source => <div className="source-state" key={source.source}><strong>{shopNames[source.source] ?? source.source}</strong><span>{!source.status.enabled ? 'Deaktiviert' : sourceErrors[source.status.last_error ?? ''] ?? 'Quelle pausiert'}</span></div>)}
  </Panel>;
}

