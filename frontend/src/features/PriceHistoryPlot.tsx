import { useEffect, useRef, useState } from 'react';
import { countryData } from './Country';
import { DAY, lowestPoint, monthStarts } from './history-model';
import type { Range } from './history-model';
import type { HistoryPoint } from './offers-model';
import { shopNames } from './shop-names';
export type { HistoryPoint } from './offers-model';
export type HistorySeries = { key: string; label: string; history: HistoryPoint[] };

const eur = (cents: number) => (cents / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
const plain = (cents: number) => (cents / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
type Vertex = [number, number];

/**
 * Step lines of the observed minima over a time window. The target-country series (key "preferred") gets an area, all series share
 * one time and price axis. A value stays valid until the next observation, so the last step runs to the end of the window.
 * Month (or week) labels run along the axis, the alarm target is an orange dashed line and the lowest point carries a flag.
 */
export default function PriceHistoryPlot({ series, target, days, now }: { series: HistorySeries[]; target: number | null; days: Range; now: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    setWidth(Math.max(240, el.clientWidth));
    const observer = new ResizeObserver(() => setWidth(Math.max(240, el.clientWidth)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const windowStart = now - days * DAY;
  const all = series.flatMap(s => s.history);
  const lastSeen = Math.max(now, ...all.map(row => row.observed_at));
  const inWindow = (rows: HistoryPoint[]) => rows.filter(row => row.base_cents !== null && row.observed_at >= windowStart);
  const shown = series.map(s => ({ ...s, rows: inWindow(s.history) }));
  const valid = shown.flatMap(s => s.rows);
  const compact = width < 480;
  const height = compact ? 190 : 260, left = compact ? 40 : 48, right = width - (target !== null ? 4 : 8), top = 14, bottom = height - 26;
  const values = [...valid.map(row => row.base_cents!), ...(target !== null ? [target] : [])];
  const min = Math.min(...values), max = Math.max(...values);
  const step = Math.max(100, Math.ceil((max - min) / 400) * 100);
  const low = Math.max(0, Math.floor((min - step / 2) / step) * step), high = Math.ceil((max + step / 2) / step) * step;
  const x = (at: number) => left + (Math.min(Math.max(at, windowStart), lastSeen) - windowStart) / (lastSeen - windowStart) * (right - left);
  const y = (cents: number) => bottom - (cents - low) / (high - low) * (bottom - top);
  const ticks: number[] = [];
  for (let cents = low; cents <= high; cents += step) ticks.push(cents);

  // Segments of vertices per series: a gap (no price) ends a segment, the value before the window carries into it.
  function segments(history: HistoryPoint[]): Vertex[][] {
    const rows = [...history].sort((a, b) => a.observed_at - b.observed_at);
    const out: Vertex[][] = [];
    let current: Vertex[] | null = null;
    const before = [...rows].reverse().find(row => row.observed_at < windowStart);
    if (before && before.base_cents !== null) { current = [[x(windowStart), y(before.base_cents)]]; out.push(current); }
    for (const row of rows) {
      if (row.observed_at < windowStart) continue;
      if (row.base_cents === null) { current = null; continue; }
      const vertex: Vertex = [x(row.observed_at), y(row.base_cents)];
      if (!current) { current = [vertex]; out.push(current); } else current.push(vertex);
    }
    for (const segment of out) { const last = segment[segment.length - 1]; if (rows.at(-1)?.base_cents !== null && segment === out[out.length - 1]) segment.push([x(lastSeen), last[1]]); }
    return out;
  }
  const line = (segment: Vertex[]) => segment.map(([px, py], i) => i === 0 ? `M ${px} ${py}` : `L ${px} ${segment[i - 1][1]} L ${px} ${py}`).join(' ');
  const area = (segment: Vertex[]) => `${line(segment)} L ${segment[segment.length - 1][0]} ${bottom} L ${segment[0][0]} ${bottom} Z`;

  const flagSeries = shown.find(s => s.key === 'preferred' && s.rows.length) ?? shown.find(s => s.rows.length);
  const flag = flagSeries ? lowestPoint(flagSeries.rows) : null;
  const dayLabel = (at: number) => new Date(at * 1000).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
  const axis = days <= 30
    ? Array.from({ length: 5 }, (_, i) => windowStart + i * (lastSeen - windowStart) / 4).map(at => ({ at, text: dayLabel(at) }))
    : monthStarts(windowStart, lastSeen).map(at => ({ at, text: new Date(at * 1000).toLocaleDateString('de-DE', { month: 'short' }).replace('.', '') }));
  const summary = series.map(s => { const rows = shown.find(item => item.key === s.key)!.rows; const lo = lowestPoint(rows); return `${s.label}: ${rows.length} Messungen${lo ? `, niedrigster Preis ${eur(lo.base_cents!)}` : ''}`; }).join('; ');
  if (!valid.length) return <div className="history-chart empty-chart" ref={box} role="status">Keine Messung in den letzten {days} Tagen.</div>;
  const flagLeft = flag ? Math.min(Math.max(x(flag.observed_at), 78), width - 78) : 0;
  return <div className="history-chart" ref={box}>
    <ul className="history-legend">{series.map(s => <li key={s.key} className={`series-${s.key}`}><span aria-hidden="true" />{s.label}</li>)}{target !== null && <li className="series-target"><span aria-hidden="true" />Alarm-Ziel {eur(target)}</li>}</ul>
    <svg className="history-plot" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Verlauf des günstigsten beobachteten Preises, letzte ${days} Tage. ${summary}`}>
      {ticks.map(cents => <g key={cents}><line className="history-grid" x1={left} x2={right} y1={y(cents)} y2={y(cents)} /><text x={left - 8} y={y(cents) + 4} textAnchor="end">{(cents / 100).toLocaleString('de-DE')} €</text></g>)}
      {shown.map(s => <g key={s.key} className={`history-series series-${s.key}`}>
        {s.key === 'preferred' && segments(s.history).map((segment, i) => <path key={`a${i}`} className="history-area" d={area(segment)} />)}
        <path className="history-line" d={segments(s.history).map(line).join(' ')} fill="none" />
        {s.rows.map((row, i) => <circle className="history-point" key={`${row.observed_at}-${i}`} cx={x(row.observed_at)} cy={y(row.base_cents!)} r={s.key === 'preferred' ? 4 : 3}><title>{s.label} · {new Date(row.observed_at * 1000).toLocaleString('de-DE')} · {countryData(row.region).name} · {eur(row.base_cents!)}</title></circle>)}
      </g>)}
      {target !== null && <g className="history-target"><line x1={left} x2={right} y1={y(target)} y2={y(target)} /><text x={right} y={y(target) - 6} textAnchor="end">ZIEL {plain(target)}</text></g>}
      {flag && <circle className="history-low" cx={x(flag.observed_at)} cy={y(flag.base_cents!)} r="6" />}
      {axis.map(tick => <text key={tick.at} className="history-axis" x={Math.min(Math.max(x(tick.at), left + 12), right - 22)} y={height - 8} textAnchor="middle">{tick.text.toUpperCase()}</text>)}
    </svg>
    {flag && !compact && <div className="history-flag" style={{ left: flagLeft, top: Math.max(0, y(flag.base_cents!) - 70) }}>
      <span>{dayLabel(flag.observed_at)} · TIEFSTPREIS</span><strong>{eur(flag.base_cents!)} <small>{flag.source ? `${shopNames[flag.source] ?? flag.source} · ` : ''}{countryData(flag.region).name}</small></strong></div>}
  </div>;
}
