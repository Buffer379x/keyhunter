import { useState } from 'react';
import { EmptyState, Label, Panel, Seg } from '../components';
import { relativeTime } from '../time';
import { countryData } from './Country';
import Flag from './Flag';
import { changePercent, defaultRange, highestPoint, inRange, lowestPoint, mean, ranges } from './history-model';
import type { Range } from './history-model';
import type { HistoryPoint, OffersView } from './offers-model';
import PriceHistoryPlot from './PriceHistoryPlot';
import type { HistorySeries } from './PriceHistoryPlot';
import { dateTime, money } from './price-format';
import { shopNames } from './shop-names';

const day = (at: number) => new Date(at * 1000).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
const where = (row: HistoryPoint) => `${countryData(row.region).name}${row.source ? ` · ${shopNames[row.source] ?? row.source}` : ''} · ${day(row.observed_at)}`;
const rangeLabel: Record<Range, string> = { 30: '30 T', 90: '90 T', 365: '1 J' };

/** Verlauf: both series (target country and all countries), the alarm target, statistics and the measurement table. */
export default function HistoryTab({ view, targetCode, targetLabel, target }: { view: OffersView; targetCode: string; targetLabel: string; target: number | null }) {
  const now = Date.now() / 1000;
  const preferredAll = view.histories?.preferred ?? view.history ?? [];
  const allAll = view.histories?.all ?? [];
  const everything = [...preferredAll, ...allAll].filter(row => row.base_cents !== null);
  const [chosen, setChosen] = useState<Range | null>(null);
  const days = chosen ?? defaultRange(everything, now);
  // Both histories are always shown: the target country against the cheapest region anywhere.
  const series: HistorySeries[] = [{ key: 'all', label: 'Alle Länder', history: allAll }, { key: 'preferred', label: `In ${targetCode} aktivierbar`, history: preferredAll }];
  const preferred = inRange(preferredAll, days, now), all = inRange(allAll, days, now);
  const lowTarget = lowestPoint(preferred), lowAll = lowestPoint(all), highTarget = highestPoint(preferred);
  const change = changePercent(preferred);
  const firstDay = preferred.length ? day(Math.min(...preferred.map(row => row.observed_at))) : '';
  const average = mean(preferred);
  const byTime = new Map<number, { at: number; preferred?: HistoryPoint; all?: HistoryPoint }>();
  for (const [key, rows] of [['preferred', preferredAll], ['all', allAll]] as const) for (const row of rows) { const entry = byTime.get(row.observed_at) ?? { at: row.observed_at }; entry[key] = row; byTime.set(row.observed_at, entry); }
  const measurements = [...byTime.values()].sort((a, b) => b.at - a.at);
  if (!everything.length) return <Panel padded><EmptyState icon="chart" title="Noch keine Preismessung vorhanden." headingLevel={3}>Sobald KeyHunter Preise abgerufen hat, entsteht hier der Verlauf.</EmptyState></Panel>;
  return <div className="history-tab">
    <Panel padded className="history-card" aria-labelledby="history-title">
      <div className="history-head">
        <Label as="h3" id="history-title">Bester gültiger Grundpreis{change !== null ? ` · ${change > 0 ? '+' : '−'}${Math.abs(change)} % seit ${firstDay}` : ''}</Label>
        <Seg label="Zeitraum" value={String(days) as `${Range}`} onChange={value => setChosen(Number(value) as Range)} options={ranges.map(r => ({ value: String(r) as `${Range}`, label: rangeLabel[r] }))} />
      </div>
      <PriceHistoryPlot series={series} target={target} days={days} now={now} />
      {everything.length === 1 && <p className="field-help">Bisher eine Messung. Weitere Abfragen ergänzen die Verlaufslinie.</p>}
    </Panel>
    <div className="history-caption">
      {lowTarget ? <div className="stat series-preferred"><Label>Tiefstwert · in {targetCode} aktivierbar</Label><strong>{money(lowTarget.base_cents!)}</strong><small>{where(lowTarget)}</small></div>
        : <div className="stat series-preferred"><Label>In {targetCode} aktivierbar</Label><strong>–</strong><small>Noch keine passende Messung</small></div>}
      {lowAll && <div className="stat series-all"><Label>Tiefstwert · alle Länder</Label><strong>{money(lowAll.base_cents!)}</strong><small>{where(lowAll)}</small></div>}
      {highTarget && preferred.length > 1 && <div className="stat"><Label>Höchstwert · {targetCode}</Label><strong>{money(highTarget.base_cents!)}</strong><small>{day(highTarget.observed_at)}</small></div>}
      {average !== null && <div className="stat"><Label>Ø im Zeitraum · {targetCode}</Label><strong>{money(average)}</strong><small>Mittel der Messwerte</small></div>}
      <div className="stat"><Label>Messungen</Label><strong>{measurements.length}</strong><small>seit {day(Math.min(...everything.map(row => row.observed_at)))}</small></div>
    </div>
    <Panel padded className="history-table-card">
      <details open>
        <summary>Messungen anzeigen</summary>
        <div className="table-scroll" tabIndex={0} role="region" aria-label="Preismessungen als Tabelle"><table className="measure-table" aria-label="Preismessungen">
          <thead><tr><th scope="col">Abfrage</th><th scope="col">In {targetCode} aktivierbar</th><th scope="col">Günstigste Region</th></tr></thead>
          <tbody>{measurements.map(row => <tr key={row.at}>
            <td title={dateTime(row.at)}>{dateTime(row.at)} <small>{relativeTime(row.at)}</small></td>
            <td>{row.preferred?.base_cents == null ? '–' : money(row.preferred.base_cents)}</td>
            <td>{row.all?.base_cents == null ? '–' : <><Flag region={row.all.region} /> {countryData(row.all.region).name} · {money(row.all.base_cents)}</>}</td>
          </tr>)}</tbody></table></div>
      </details>
      <p className="card-footnote">Messwerte gelten bis zur nächsten Abfrage, höchstens 24 Stunden. {targetLabel} ist dein Zielland.</p>
    </Panel>
  </div>;
}
