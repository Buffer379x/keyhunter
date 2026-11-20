import { Button, Card, Chip, Icon, MonoLabel, Price, SegmentedControl, StatusChip } from '../components';
import { relativeTime } from '../time';
import { countryData } from './Country';
import Flag from './Flag';
import { dateTime, money } from './price-format';
import { DAY, inRange, lowestPoint, mean } from './history-model';
import { inSentence, labelLanes, reasonList, ruler } from './offers-model';
import type { Basis, OfferRow, OffersView, Summary } from './offers-model';
import { ruleTarget, targetReached } from './PriceAlerts';
import type { Rule } from './PriceAlerts';
import { shopNames } from './shop-names';

const time = (seconds: number) => new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' }).format(seconds * 1000);
const basisLabel: Record<Basis, string> = { base: 'Grundpreis', estimate: 'Gesamtpreis geschätzt' };
export function BasisSwitch({ basis, onChange }: { basis: Basis; onChange: (basis: Basis) => void }) {
  return <SegmentedControl label="Preisgrundlage" value={basis} onChange={onChange} options={[{ value: 'base', label: 'Grundpreis' }, { value: 'estimate', label: 'Gesamtpreis geschätzt' }]} />;
}
const feeNote = (row: OfferRow, basis: Basis) => basis === 'estimate'
  ? `Grundpreis ${money(row.quote!.base_cents)}`
  : row.quote?.estimated_total_cents != null ? `Gebühren nicht enthalten, geschätzt gesamt ${money(row.quote.estimated_total_cents)}` : 'Gebühren unbekannt';

type Props = {
  view: OffersView | null; rows: OfferRow[]; summary: Summary; basis: Basis; onBasis: (basis: Basis) => void;
  targetCode: string; targetLabel: string; rule: Rule | null; searching: boolean;
  history: { observed_at: number; base_cents: number | null; link_id: number | null; region?: string | null }[];
  onTab: (tab: string) => void;
};

export default function PriceTab({ view, rows, summary, basis, onBasis, targetCode, targetLabel, rule, searching, history, onTab }: Props) {
  const code = targetCode || view?.target_country || 'Zielland';
  const { targetCents, targetRow, world } = summary;
  const row = targetRow;
  const now = Date.now() / 1000;
  const ruleOnBasis = rule && rule.basis === basis ? rule : null;
  const target = ruleTarget(ruleOnBasis);
  const reached = targetReached(ruleOnBasis, targetCents);
  const observed = row?.link.observed_at ?? null;
  const live = rows.filter(r => r.current);
  const soldOut = rows.some(r => r.status === 'sold_out') && !live.length;

  // Preis-Visier: only markers that data backs. The history holds base prices, so it is used on that basis only.
  const lastNinety = basis === 'base' ? inRange(history, 90, now) : [];
  const lowest = lowestPoint(lastNinety)?.base_cents ?? null;
  const average = basis === 'base' ? mean(inRange(history, 30, now)) : null;
  const dots = [...new Set(live.filter(r => r.eligible).map(r => r.price!))];
  const hasPrices = targetCents !== null || lowest !== null || average !== null || dots.length > 0;
  const scale = !hasPrices ? null : ruler([...dots, ...(targetCents !== null ? [targetCents] : []), ...(lowest !== null ? [lowest] : []), ...(average !== null ? [average] : []), ...(target !== null ? [target] : [])]);
  const markers = scale ? ([
    lowest !== null && { key: 'low', label: `TIEFST ${plain(lowest)}`, cents: lowest },
    average !== null && { key: 'avg', label: `Ø 30 T ${plain(average)}`, cents: average },
    target !== null && { key: 'target', label: `ZIEL ${plain(target)}`, cents: target },
  ].filter(Boolean) as { key: string; label: string; cents: number }[]) : [];
  const lanes = scale ? labelLanes(markers.map(m => scale.pos(m.cents))) : [];
  const delta = targetCents !== null && target !== null ? target - targetCents : null;
  const bandStart = dots.length ? Math.min(...dots) : null, bandEnd = dots.length ? Math.max(...dots) : null;
  const rulerText = scale ? `Preisskala ${plain(scale.lo)} bis ${plain(scale.hi)} Euro: ${[
    lowest !== null && `Tiefstwert 90 Tage ${plain(lowest)}`, targetCents !== null && `bester Preis ${plain(targetCents)}`,
    dots.length > 1 && `${dots.length} gültige Angebote von ${plain(Math.min(...dots))} bis ${plain(Math.max(...dots))}`,
    target !== null && `Ziel ${plain(target)}`, average !== null && `Durchschnitt 30 Tage ${plain(average)}`].filter(Boolean).join(', ')} Euro` : '';

  const excluded = summary.excluded;
  const exampleRegion = excluded.example?.link.product ? countryData(excluded.example.link.product.region).name : '';
  const why: { mark: 'ok' | 'info' | 'no'; title: string; detail: string }[] = [];
  if (row) {
    why.push({ mark: 'ok', title: 'Richtiges Produkt', detail: 'Titel, Edition und Plattform sind bestätigt' });
    why.push({ mark: 'ok', title: `In ${targetLabel} aktivierbar`, detail: row.link.product?.activation === 'confirmed' ? 'laut Produktseite des Shops' : 'Aktivierung geprüft' });
    why.push({ mark: 'ok', title: 'Aktuell', detail: `${observed ? `${relativeTime(observed)} abgerufen` : 'abgerufen'}, ${row.link.product?.availability === 'in_stock' ? 'auf Lager' : 'Verfügbarkeit laut Shop'}` });
    why.push(row.quote?.estimated_total_cents != null
      ? { mark: 'info', title: 'Gebühren nicht enthalten', detail: `Geschätzter Gesamtpreis ${money(row.quote.estimated_total_cents)}` }
      : { mark: 'info', title: 'Gebühren unbekannt', detail: 'Der Grundpreis kann sich im Warenkorb ändern' });
  }
  const summaryLine = excluded.count > 0
    ? `${excluded.count} günstigere${excluded.count === 1 ? 's Angebot zählt' : ' Angebote zählen'} nicht: ${excluded.reasons.map(inSentence).join(', ')}${excluded.example ? ` (z. B. ${exampleRegion} ${money(excluded.example.price!)})` : ''}.`
    : row ? 'Kein günstigeres Angebot wird ausgeschlossen.' : '';

  return <div className="price-grid">
    <Card lock className="best-card" aria-labelledby="best-title">
      <div className="best-head">
        <MonoLabel as="h3" id="best-title">Bester gültiger Preis · {code}</MonoLabel>
        {observed !== null && <MonoLabel title={dateTime(observed)}>{time(observed)} · {relativeTime(observed)}</MonoLabel>}
      </div>
      <div className="best-body">
        <div className="best-price">
          {!view ? <p className="status-big" role="status">Preis wird geladen …</p>
            : targetCents !== null ? <Price cents={targetCents} size="xl" />
            : view.last_known ? <><p className="status-big">Kein aktueller Preis</p><p className="last-known"><Price cents={view.last_known.cents} size="sm" tone="stale" /><span>zuletzt bekannt am {dateTime(view.last_known.observed_at)}</span></p></>
            : soldOut ? <p className="status-big">Ausverkauft</p>
            : !rows.length ? <p className="status-big">{searching ? 'Angebote werden gesucht …' : 'Noch keine Angebote'}</p>
            : <p className="status-big">Kein gültiges Angebot in {targetLabel}</p>}
          <div className="chip-row">
            {targetCents !== null && <><StatusChip kind="best" />
              <Chip kind="valid">in {code} aktivierbar</Chip>
              {reached && <StatusChip kind="target" />}</>}
            {targetCents === null && view?.last_known && <Chip kind="stale">Veraltet · {relativeTime(view.last_known.observed_at)}</Chip>}
            {targetCents === null && view && !view.last_known && !soldOut && rows.length > 0 && <Chip kind="neutral" icon="minus">nichts in {code} gültig</Chip>}
          </div>
          {row && <p className="best-line">{basis === 'estimate' ? 'Gesamtpreis geschätzt bei' : 'Grundpreis bei'} <strong>{shopNames[row.link.source] ?? row.link.source}</strong> · {countryData(row.link.product?.region).name} · {feeNote(row, basis)}</p>}
          {!row && view && !view.last_known && !rows.length && !searching && <Button variant="secondary" onClick={() => onTab('infos')}>Produktlink ergänzen</Button>}
        </div>
        <div className="best-actions">
          {row && <a className="button" href={row.link.url} target="_blank" rel="noopener noreferrer">Zum Angebot <Icon name="external" size={16} /></a>}
          {summary.pricedCount > 0 && <button type="button" className="button ghost" onClick={() => onTab('angebote')}>{summary.pricedCount} {summary.pricedCount === 1 ? 'Angebot' : 'Angebote'} vergleichen</button>}
        </div>
      </div>
      {scale && <div className="visier">
        <div className="visier-head"><MonoLabel as="h4">Preis-Visier</MonoLabel>
          {delta !== null && <span className="visier-delta">{delta >= 0 ? `${money(delta)} unter deinem Ziel` : `${money(-delta)} über deinem Ziel`}</span>}</div>
        <div className="visier-scale" role="img" aria-label={rulerText}>
          <span className="visier-axis" />
          {bandStart !== null && bandEnd !== null && bandEnd > bandStart && <span className="visier-band" style={{ left: `${scale.pos(bandStart)}%`, width: `${scale.pos(bandEnd) - scale.pos(bandStart)}%` }} />}
          {scale.ticks.map(tick => <span key={tick.cents} className="visier-tick" style={{ left: `${tick.pos}%` }}><i /><b>{Math.round(tick.cents / 100)} €</b></span>)}
          {lowest !== null && <span className="visier-low" style={{ left: `${scale.pos(lowest)}%` }} />}
          {average !== null && <span className="visier-avg" style={{ left: `${scale.pos(average)}%` }} />}
          {dots.map(cents => <span key={cents} className={`visier-dot ${cents === targetCents ? 'best' : ''}`} style={{ left: `${scale.pos(cents)}%` }} />)}
          {target !== null && <span className="visier-target" style={{ left: `${scale.pos(target)}%` }}><Icon name="target" size={28} /></span>}
          {markers.map((marker, i) => <span key={marker.key} className={`visier-label ${marker.key} lane${lanes[i]}`} style={{ left: `clamp(44px, ${scale.pos(marker.cents)}%, calc(100% - 44px))` }}>{marker.label}</span>)}
        </div>
      </div>}
    </Card>

    <div className="price-side">
      <Compare view={view} summary={summary} basis={basis} onBasis={onBasis} code={code} targetLabel={targetLabel} onTab={onTab} />
      <Card className="why-card" aria-labelledby="why-title">
        <h3 id="why-title">Warum dieser Preis zählt</h3>
        {why.length > 0 && <ul className="why-list">{why.map(item => <li key={item.title}><span className={`why-mark ${item.mark}`} aria-hidden="true">{item.mark === 'ok' ? '✓' : 'i'}</span><span><strong>{item.title}</strong><small>{item.detail}</small></span></li>)}</ul>}
        {why.length === 0 && view && <p className="field-help">{rows.length ? `Kein Angebot erfüllt alle Bedingungen für ${targetLabel}: bestätigtes Produkt, Aktivierung im Zielland, aktueller Abruf, lieferbar.` : 'Sobald Angebote gefunden sind, steht hier, warum der beste Preis zählt.'}</p>}
        {summaryLine && <p className="why-summary" id="why-summary">{summaryLine}</p>}
      </Card>
    </div>
  </div>;
}
const plain = (cents: number) => (cents / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Best price that counts in the target country next to the cheapest region worldwide, with the difference. */
function Compare({ view, summary, basis, onBasis, code, targetLabel, onTab }: { view: OffersView | null; summary: Summary; basis: Basis; onBasis: (basis: Basis) => void; code: string; targetLabel: string; onTab: (tab: string) => void }) {
  const { world, targetCents, targetRow, saving, savingPercent } = summary;
  if (!view || (!world && targetCents === null && !view.last_known)) return null;
  const worldReasons = world && !world.eligible ? reasonList(world.link, view.target_country) : [];
  const worldRegion = world?.link.product ? countryData(world.link.product.region) : null;
  const same = world && targetCents !== null && world.price === targetCents;
  return <Card className="compare-card" aria-labelledby="compare-title">
    <div className="compare-head"><h3 id="compare-title">{targetLabel} und weltweit</h3><BasisSwitch basis={basis} onChange={onBasis} /></div>
    <div className="price-compare" aria-label="Preisvergleich">
      <div className={`compare-tile target ${targetCents === null ? 'none' : ''}`}><MonoLabel>{targetCents === null && view.last_known ? `Zuletzt bekannt · ${code}` : `Bester Preis · in ${code} aktivierbar`}</MonoLabel>
        {targetCents !== null ? <><Price cents={targetCents} size="md" /><small>{targetRow ? `${countryData(targetRow.link.product?.region).name} · ${shopNames[targetRow.link.source] ?? targetRow.link.source}` : 'Gültiges Angebot'}</small></>
          : view.last_known ? <><Price cents={view.last_known.cents} size="md" tone="stale" /><small>Kein aktueller Preis · zuletzt am {dateTime(view.last_known.observed_at)}</small></>
          : <><span className="tile-missing">kein gültiges Angebot</span><small>in {targetLabel}</small></>}
      </div>
      {world && <div className="compare-tile world"><MonoLabel>Günstigste Region · alle Länder</MonoLabel>
        <Price cents={world.price} size="md" />
        <small><Flag region={world.link.product?.region} /> {worldRegion?.name} · {shopNames[world.link.source] ?? world.link.source}</small>
        {world.eligible ? <Chip kind="valid">in {code} aktivierbar</Chip> : <Chip kind="neutral" icon="cross">{worldReasons[0] ?? `nicht für ${targetLabel}`}</Chip>}
      </div>}
    </div>
    <p className="compare-delta" aria-live="polite">{saving > 0 && world
      ? <><strong>{money(saving)} günstiger</strong> ({savingPercent} %) in {worldRegion?.name} als dein bester Preis für {targetLabel}.{!world.eligible && <> Dort gilt das Angebot aber nicht für {targetLabel}: {(worldReasons.map(inSentence).join(', ') || 'nicht aktivierbar')}.</>}</>
      : same || (world && targetCents !== null) ? <>Dein Angebot für {targetLabel} ist auch weltweit am günstigsten.</>
      : world && !world.eligible ? <>Für {targetLabel} gibt es derzeit kein gültiges Angebot zum Vergleich.</> : null}</p>
    {summary.pricedCount > 1 && <button type="button" className="text-button" onClick={() => onTab('angebote')}>Alle Regionen und Angebote ansehen</button>}
  </Card>;
}
