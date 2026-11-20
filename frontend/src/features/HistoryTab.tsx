import { useState } from 'react';
import { EmptyState, Inset, Kpi, Label, Panel, PanelHead, Seg } from '../components';
import { columns, dailyStats, dayLabel, defaultRange, ranges } from './history-model';
import type { Range } from './history-model';
import type { OffersView, Summary } from './offers-model';
import PriceMatrix from './PriceMatrix';
import { Legend } from './PriceTab';
import { money } from './price-format';
import { countryData } from './regions';

const rangeLabel: Record<Range, string> = { 30: '30 T', 90: '90 T', 180: '180 T' };

/** Verlauf: four KPI tiles, then the dot-matrix chart of the target country against the cheapest region worldwide over 30, 90 or 180 days. */
export default function HistoryTab({ view, summary, code, land, target }: { view: OffersView; summary: Summary; code: string; land: string; target: number | null }) {
  const now = Date.now() / 1000;
  const preferred = view.histories?.preferred ?? view.history ?? [];
  const all = view.histories?.all ?? [];
  const [chosen, setChosen] = useState<Range | null>(null);
  const days = chosen ?? defaultRange([...preferred, ...all], now);
  const home = dailyStats(preferred, days, now), world = dailyStats(all, days, now).low;
  const current = view.best_base;
  const gaps = columns(preferred, all, days, days, now).some(day => !day.home && !day.world);
  const empty = ![...preferred, ...all].some(row => row.base_cents !== null);
  return <div className="stack">
    <div className="kpis">
      <Kpi label={`Tiefstwert ${code}`} value={home.low ? money(home.low.cents) : '–'} foot={<span>{home.low ? `am ${dayLabel(now, home.low.back)}` : 'noch keine Messung'}</span>} />
      <Kpi label="Tiefstwert weltweit" className="world" value={world ? money(world.cents) : '–'} foot={<span>{world ? `am ${dayLabel(now, world.back)}${world.region ? ` · ${countryData(world.region).name}` : ''}` : 'noch keine Messung'}</span>} />
      <Kpi label={`Höchstwert ${code}`} value={home.high !== null ? money(home.high) : '–'} foot={<span>in {days} Tagen</span>} />
      <Kpi label={`Durchschnitt ${code}`} value={home.average !== null ? money(home.average) : '–'}
        foot={<span>{home.average !== null && current !== null ? `jetzt ${current <= home.average ? 'unter' : 'über'} Durchschnitt` : 'Mittel der Tagestiefstwerte'}</span>} />
    </div>
    <Panel aria-labelledby="history-title">
      <PanelHead><Label id="history-title">Preisverlauf</Label><span className="spacer" />
        <Seg label="Zeitraum" value={String(days) as `${Range}`} onChange={value => setChosen(Number(value) as Range)} options={ranges.map(r => ({ value: String(r) as `${Range}`, label: rangeLabel[r] }))} /></PanelHead>
      <Inset>
        {empty ? <EmptyState icon="chart" title="Noch keine Preismessung vorhanden." headingLevel={3}>Sobald KeyHunter Preise abgerufen hat, entsteht hier der Verlauf.</EmptyState> : <>
          <div className="chart-top">
            <span className="muted">Aktuell</span>
            <span className="num now">{current !== null ? money(current) : '–'}</span>
            {summary.world && <span className="num world">{money(summary.world.price!)} weltweit</span>}
            <span className="spacer" />
            <Legend code={land} target={target} targetLabel={target !== null ? `Ziel ${money(target)}` : undefined} />
          </div>
          <PriceMatrix home={preferred} world={all} days={days} target={target} now={now} country={land} label={`Preisverlauf ${land} und weltweit, ${days} Tage`} />
          {gaps && <p className="hint chart-hint">Leere Spalten: an diesen Tagen gab es keine gültige Messung. Ein Messwert gilt bis zur nächsten Abfrage, höchstens 24 Stunden.</p>}
        </>}
      </Inset>
    </Panel>
  </div>;
}
