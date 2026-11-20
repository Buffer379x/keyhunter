import { BigPrice, Button, Icon, Inset, Label, Panel, PanelHead, Pill, Reg, Seg } from '../components';
import { relativeTime } from '../time';
import { countryData, regionCode } from './regions';
import { dailyStats } from './history-model';
import { validity, verdict, verdictText } from './offers-model';
import type { Basis, OfferRow, OffersView, Summary } from './offers-model';
import PriceMatrix from './PriceMatrix';
import { ruleTarget, targetReached } from './PriceAlerts';
import type { Rule } from './PriceAlerts';
import { dateTime, money } from './price-format';
import { shopNames } from './shop-names';

/** Grundpreis or Gesamtpreis geschätzt; only shown when a shop has a fee estimate configured. */
export function BasisSwitch({ basis, onChange }: { basis: Basis; onChange: (basis: Basis) => void }) {
  return <Seg label="Preisgrundlage" value={basis} onChange={onChange} options={[{ value: 'base', label: 'Grundpreis' }, { value: 'estimate', label: 'Gesamtpreis geschätzt' }]} />;
}
export const shopName = (row: OfferRow) => shopNames[row.link.source] ?? row.link.source;
export const regionName = (row: OfferRow) => countryData(row.link.product?.region).name;
/** "Stand 20. Nov · 11:00" */
export const stand = (seconds: number) => {
  const date = new Date(seconds * 1000);
  return `Stand ${date.toLocaleDateString('de-DE', { day: 'numeric', month: 'short' }).replace(/\.$/, '')} · ${date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`;
};
const pct = (part: number, whole: number) => `${Math.round(part / whole * 100)} %`;

type Props = {
  view: OffersView | null; rows: OfferRow[]; summary: Summary; basis: Basis; onBasis: (basis: Basis) => void; hasEstimates: boolean;
  /** Target country code ("DE") and name ("Deutschland"). */ code: string; land: string;
  rule: Rule | null; searching: boolean; onTab: (tab: string) => void;
};

/** Preis: the best price in the target country against the cheapest region worldwide, the verdict, 30 days of history, the gauge and the facts. */
export default function PriceTab({ view, rows, summary, basis, onBasis, hasEstimates, code, land, rule, searching, onTab }: Props) {
  const now = Date.now() / 1000;
  const { targetCents, targetRow, world, saving } = summary;
  const same = !!world && targetCents !== null && saving <= 0;
  const preferred = view?.histories?.preferred ?? view?.history ?? [];
  const all = view?.histories?.all ?? [];
  const target = ruleTarget(rule);
  const chartTarget = rule?.basis === 'base' ? target : null;
  const ruleCents = rule?.basis === 'estimate' ? view?.best_estimate ?? null : view?.best_base ?? null;
  const reached = targetReached(rule, ruleCents);
  const v = verdict(summary, regionName, code);
  const text = v ? verdictText(v, land, money) : null;
  const worldValidity = world ? validity(world, code) : null;
  const observed = [targetRow?.link.observed_at, world?.link.observed_at].filter((at): at is number => !!at);
  const asOf = observed.length ? Math.min(...observed) : null;
  const soldOut = rows.some(r => r.status === 'sold_out') && !rows.some(r => r.current);
  const fee = (row: OfferRow) => {
    const estimate = row.quote?.estimated_total_cents;
    if (basis === 'estimate') return `Gesamtpreis geschätzt · Grundpreis ${money(row.quote!.base_cents)}`;
    return estimate != null ? `ohne Gebühren · geschätzt gesamt ${money(estimate)}` : 'ohne Gebühren';
  };

  // Gauge and facts: base prices of the target country over 90 days (the history holds base prices).
  const stats90 = dailyStats(preferred, 90, now);
  const world90 = dailyStats(all, 90, now).low;
  const now90 = view?.best_base ?? null;
  const gaugeValues = [stats90.low?.cents, stats90.average, stats90.high, chartTarget, now90].filter((x): x is number => x != null);
  const lo = gaugeValues.length ? Math.min(...gaugeValues) * .94 : 0, hi = gaugeValues.length ? Math.max(...gaugeValues) * 1.03 : 1;
  const pos = (cents: number) => `${((cents - lo) / (hi - lo || 1) * 100).toFixed(1)}%`;
  const cheaper = rows.filter(r => r.current && r.price !== null && !r.eligible && (targetCents === null || r.price < targetCents));

  return <div className="grid-2">
    <div className="stack">
      <Panel aria-labelledby="compare-title">
        <PanelHead><Label id="compare-title">Preisvergleich</Label><span className="spacer" />
          {hasEstimates && <BasisSwitch basis={basis} onChange={onBasis} />}
          {asOf !== null && <span className="mono faint stand" title={`${dateTime(asOf)} · ${relativeTime(asOf)}`}>{stand(asOf)}</span>}</PanelHead>
        <Inset>
          <div className="compare" aria-label="Preisvergleich" role="group">
            <div className="compare-side home">
              <Label>{targetCents === null && view?.last_known ? `Zuletzt bekannt · ${code}` : `Bester Preis · ${code}`}</Label>
              {targetCents !== null ? <BigPrice cents={targetCents} />
                : view?.last_known ? <BigPrice cents={view.last_known.cents} className="stale" />
                : <span className="compare-missing">{!view ? 'wird geladen …' : soldOut ? 'Ausverkauft' : summary.pricedCount === 0 ? (searching ? 'Angebote werden gesucht …' : 'Noch keine Angebote') : `Kein gültiges Angebot in ${land}`}</span>}
              <div className="chips">
                {targetCents !== null && <Pill tone="ok" icon="check">in {code} aktivierbar</Pill>}
                {targetCents !== null && reached && <Pill tone="hot" icon="target">Ziel erreicht</Pill>}
                {targetCents === null && view?.last_known && <Pill tone="dim" icon="clock">Veraltet · {relativeTime(view.last_known.observed_at)}</Pill>}
                {targetCents === null && !view?.last_known && summary.pricedCount > 0 && <Pill tone="dim" icon="minus">nichts in {code} gültig</Pill>}
              </div>
              {targetRow ? <span className="src">{shopName(targetRow)} · {regionName(targetRow)} · {fee(targetRow)}</span>
                : view?.last_known ? <span className="src">Kein aktueller Preis · zuletzt am {dateTime(view.last_known.observed_at)}</span> : null}
            </div>
            <div className="compare-mid"><div className="delta">
              {same ? <><b className="even">±0</b><span>gleich</span></>
                : world && targetCents !== null ? <><b>−{money(saving)}</b><span>−{pct(saving, targetCents)}</span></>
                : <><b className="none">–</b><span>kein Vergleich</span></>}
            </div></div>
            <div className="compare-side world">
              <Label>Günstigste Region · weltweit</Label>
              {world ? <>
                <BigPrice cents={world.price} world />
                <div className="chips"><Reg code={regionCode(world.link.product?.region)} home={regionCode(world.link.product?.region) === code} title={regionName(world)} />
                  {worldValidity && <Pill tone={worldValidity.tone} icon={worldValidity.icon}>{worldValidity.text}</Pill>}</div>
                <span className="src">{shopName(world)} · {regionName(world)}</span>
              </> : <span className="compare-missing">{searching ? 'wird gesucht …' : 'kein aktuelles Angebot'}</span>}
            </div>
          </div>
          <div className="verdict">
            {text ? <p aria-live="polite"><b>{text.lead}</b> {text.rest}</p>
              : view && <p>{searching ? 'KeyHunter sucht gerade Angebote in allen Regionen.' : rows.length ? `Kein Angebot hat gerade einen aktuellen Preis. Sobald ein Shop wieder liefert, steht hier der Vergleich mit ${land}.` : 'Sobald Angebote gefunden sind, steht hier der Vergleich mit allen Regionen.'}</p>}
            <div className="actions">
              {targetRow && <a className="btn primary" href={targetRow.link.url} target="_blank" rel="noopener noreferrer">Angebot {code} öffnen<Icon name="ext" /></a>}
              {world && !same && <a className="btn" href={world.link.url} target="_blank" rel="noopener noreferrer">Angebot {regionName(world)}<Icon name="ext" /></a>}
              {summary.pricedCount > 0 && <Button variant="ghost" onClick={() => onTab('angebote')}>{summary.pricedCount === 1 ? 'Angebot ansehen' : `Alle ${summary.pricedCount} Angebote`}</Button>}
              {view && !rows.length && !searching && <Button variant="ghost" onClick={() => onTab('infos')}>Produktlink ergänzen</Button>}
            </div>
          </div>
        </Inset>
      </Panel>
      <Panel aria-labelledby="month-title">
        <PanelHead><Label id="month-title">Verlauf · 30 Tage</Label><span className="spacer" />
          <Legend code={code} target={chartTarget} />
          <Button size="sm" variant="ghost" onClick={() => onTab('verlauf')}>Ganzer Verlauf<Icon name="chev" /></Button></PanelHead>
        <Inset><PriceMatrix home={preferred} world={all} days={30} target={chartTarget} now={now} country={land} label={`Preisverlauf ${land} und weltweit, 30 Tage`} /></Inset>
      </Panel>
    </div>
    <div className="stack">
      <Panel aria-labelledby="gauge-title">
        <PanelHead><Label id="gauge-title">Preis-Visier · 90 Tage</Label><span className="spacer" />
          {target !== null && ruleCents !== null && (ruleCents <= target
            ? <span className="save reached">{money(target - ruleCents)} unter Ziel</span>
            : <span className="save big">{money(ruleCents - target)} über Ziel</span>)}</PanelHead>
        <Inset className="gauge">
          {gaugeValues.length > 0 && <div className="gauge-track" role="img" aria-label={[now90 !== null && `Jetzt ${money(now90)}`, chartTarget !== null && `Ziel ${money(chartTarget)}`, stats90.low && `Tiefstwert 90 Tage ${money(stats90.low.cents)}`, stats90.average !== null && `Durchschnitt 90 Tage ${money(stats90.average)}`].filter(Boolean).join(', ')}>
            <span className="line" />
            {stats90.low && stats90.average !== null && <span className="range" style={{ left: pos(stats90.low.cents), width: `calc(${pos(stats90.average)} - ${pos(stats90.low.cents)})` }} />}
            {stats90.low && <span className="gauge-mark" style={{ left: pos(stats90.low.cents) }}><i /></span>}
            {stats90.average !== null && <span className="gauge-mark" style={{ left: pos(stats90.average) }}><i /></span>}
            {chartTarget !== null && <span className="gauge-mark target" style={{ left: pos(chartTarget) }}><i /></span>}
            {now90 !== null && <span className="gauge-mark now" style={{ left: pos(now90) }}><i /></span>}
          </div>}
          <div className="gauge-legend">
            <div><Label>Jetzt</Label><b>{now90 !== null ? money(now90) : '–'}</b></div>
            <div className="t"><Label>Ziel</Label><b>{target !== null ? money(target) : '–'}</b></div>
            <div><Label>Tiefst</Label><b>{stats90.low ? money(stats90.low.cents) : '–'}</b></div>
            <div><Label>Ø 90 T</Label><b>{stats90.average !== null ? money(stats90.average) : '–'}</b></div>
          </div>
        </Inset>
      </Panel>
      <Panel aria-labelledby="why-title">
        <PanelHead><Label id="why-title">Warum dieser Preis zählt</Label></PanelHead>
        <Inset><ul className="facts" id="why-list">
          {targetRow ? <li className="ok"><Icon name="check" /><span>Günstigstes Angebot, das in {land} sicher funktioniert</span><span className="r mono">{money(targetCents!)}</span></li>
            : view && <li className="warn"><Icon name="alert" /><span>{rows.length ? `Kein Angebot erfüllt gerade alle Bedingungen für ${land}: bestätigtes Produkt, Aktivierung im Zielland, aktueller Abruf, lieferbar.` : 'Sobald Angebote gefunden sind, steht hier, warum der beste Preis zählt.'}</span></li>}
          {cheaper.slice(0, 3).map(row => { const valid = validity(row, code); return <li key={row.key} className={valid.tone === 'warn' ? 'warn' : ''}>
            <Icon name={valid.tone === 'warn' ? 'alert' : 'x'} /><span>{shopName(row)} · {regionName(row)} ist günstiger, {valid.text}</span><span className="r mono muted">{money(row.price!)}</span></li>; })}
          {cheaper.length > 3 && <li><Icon name="info" /><span>{cheaper.length - 3} weitere günstigere {cheaper.length - 3 === 1 ? 'Angebot zählt' : 'Angebote zählen'} nicht für {land}</span><Button size="sm" variant="ghost" className="r" onClick={() => onTab('angebote')}>Alle ansehen</Button></li>}
          {stats90.low && <li><Icon name="info" /><span>Tiefstwert in {land} der letzten 90 Tage{world90 ? `, weltweit ${money(world90.cents)}` : ''}</span><span className="r mono muted">{money(stats90.low.cents)}</span></li>}
        </ul></Inset>
      </Panel>
    </div>
  </div>;
}

/** Legend of the matrix chart: target country, worldwide and (when set) the alarm target. */
export function Legend({ code, target, targetLabel }: { code: string; target: number | null; targetLabel?: string }) {
  return <div className="legend" aria-hidden="true"><span><i />{code}</span><span><i className="w" />Weltweit</span>{target !== null && <span><i className="t" />{targetLabel ?? 'Ziel'}</span>}</div>;
}
