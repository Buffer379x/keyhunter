import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { columns, dayLabel } from './history-model';
import type { Column } from './history-model';
import type { HistoryPoint } from './offers-model';
import { regionCode } from './regions';
import { money } from './price-format';

const ROWS = 20,
  AXIS = 40,
  GAP = 2;

/**
 * Dot-matrix price chart of the design v4 prototype (drawMatrix): per column of whole days a pair of cell stacks, the
 * target country (orange) next to the cheapest region worldwide (warm white). 30 columns, 15 below 520 px; 20 rows up to
 * the next 20 € above the highest price or the alarm target. A column without a valid measurement stays empty.
 * Hover, tap or the arrow keys highlight a column and show its prices; a visually hidden table carries the same data.
 */
export default function PriceMatrix({
  home,
  world,
  days,
  target,
  now,
  country,
  label,
}: {
  home: HistoryPoint[];
  world: HistoryPoint[];
  days: number;
  target: number | null;
  now: number;
  /** Target country name for the tooltip, e.g. "Deutschland". */ country: string;
  label: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [boxWidth, setBoxWidth] = useState(0);
  const [hover, setHover] = useState(-1);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    setBoxWidth(el.clientWidth);
    const observer = new ResizeObserver(() => setBoxWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => setHover(-1), [days]);

  const width = Math.max(280, (boxWidth || 640) - 24);
  const cols = columns(home, world, days, width < 520 ? 15 : 30, now);
  const values = cols.flatMap(c => [c.home?.cents, c.world?.cents]).filter((v): v is number => v !== undefined);
  // Up to the next 20 € so that the labels every 5 rows fall on whole euros (5, 10, 15, 20 …).
  const top = Math.max(2000, Math.ceil(Math.max(...values, target ?? 0) / 2000) * 2000);
  const step = top / ROWS;
  const colW = (width - AXIS) / cols.length;
  const cell = Math.max(3, Math.min(12, (colW - 4) / 2 - GAP));
  const pairW = cell * 2 + GAP;
  const H = ROWS * (cell + GAP);
  const yOf = (cents: number) => H - (cents / step) * (cell + GAP);
  const filled = (c: Column['home']) => (c ? Math.max(1, Math.round(c.cents / step)) : 0);
  const labelEvery = Math.ceil(cols.length / 6);
  const active = hover >= 0 ? cols[hover] : undefined;
  const range = (c: Column) => (c.fromBack === c.toBack ? dayLabel(now, c.fromBack) : `${dayLabel(now, c.fromBack)} – ${dayLabel(now, c.toBack)}`);

  function keys(event: KeyboardEvent) {
    const next =
      event.key === 'ArrowRight'
        ? Math.min(cols.length - 1, hover + 1)
        : event.key === 'ArrowLeft'
          ? Math.max(0, (hover < 0 ? cols.length : hover) - 1)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? cols.length - 1
              : event.key === 'Escape'
                ? -1
                : null;
    if (next === null) return;
    event.preventDefault();
    setHover(next);
  }

  let tip: { left: number; top: number } | null = null;
  if (active && box.current) {
    const scale = Math.min(1, (box.current.clientWidth - 24) / width) || 1;
    let left = (AXIS + hover * colW + colW) * scale + 18;
    if (left + 180 > box.current.clientWidth) left = (AXIS + hover * colW) * scale - 180;
    tip = { left: Math.max(8, left), top: Math.max(8, yOf(Math.max(active.home?.cents ?? 0, active.world?.cents ?? 0)) * scale - 20) };
  }

  return (
    <div className="matrix" ref={box} onMouseLeave={() => setHover(-1)}>
      <svg viewBox={`0 0 ${width} ${H + 26}`} role="img" tabIndex={0} aria-label={label} onKeyDown={keys} onBlur={() => setHover(-1)}>
        {Array.from({ length: ROWS / 5 + 1 }, (_, i) => i * 5).map(r => {
          const y = H - r * (cell + GAP);
          return (
            <g key={r}>
              <text x={AXIS - 8} y={y + 3} textAnchor="end">
                {Math.round((r * step) / 100)} €
              </text>
              <line x1={AXIS - 4} x2={AXIS - 1} y1={y} y2={y} stroke="var(--line-2)" />
            </g>
          );
        })}
        {cols.map((c, i) => {
          const x0 = AXIS + i * colW + (colW - pairW) / 2;
          const nd = filled(c.home),
            nw = filled(c.world);
          const dim = hover >= 0 && i !== hover;
          return (
            <g key={c.start} className={i === hover ? 'on' : undefined}>
              {Array.from({ length: ROWS }, (_, r) => {
                const y = H - (r + 1) * (cell + GAP) + GAP;
                return (
                  <g key={r}>
                    <rect x={x0} y={y} width={cell} height={cell} rx="1" fill={r < nd ? 'var(--accent)' : 'var(--cell)'} opacity={r < nd && dim ? 0.45 : 1} />
                    <rect
                      x={x0 + cell + GAP}
                      y={y}
                      width={cell}
                      height={cell}
                      rx="1"
                      fill={r < nw ? 'var(--world)' : 'var(--cell)'}
                      opacity={r < nw && dim ? 0.45 : 1}
                    />
                  </g>
                );
              })}
              <rect
                className="hit"
                x={AXIS + i * colW}
                y="0"
                width={colW}
                height={H}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
                onClick={() => setHover(i)}
              />
            </g>
          );
        })}
        {target !== null && (
          <line
            className="target"
            x1={AXIS}
            x2={width}
            y1={yOf(target)}
            y2={yOf(target)}
            stroke="var(--accent-2)"
            strokeWidth="1.5"
            strokeDasharray="4 4"
            pointerEvents="none"
          />
        )}
        {active && (
          <line
            x1={AXIS + hover * colW + colW / 2}
            x2={AXIS + hover * colW + colW / 2}
            y1="0"
            y2={H}
            stroke="var(--text-2)"
            strokeDasharray="2 3"
            pointerEvents="none"
          />
        )}
        {cols.map((c, i) =>
          (cols.length - 1 - i) % labelEvery ? null : (
            <text key={c.start} x={AXIS + i * colW + colW / 2} y={H + 18} textAnchor="middle" className={i === hover ? 'on' : undefined}>
              {i === cols.length - 1 ? 'heute' : dayLabel(now, c.toBack)}
            </text>
          ),
        )}
      </svg>
      {active && tip && (
        <div className="tip" role="status" style={{ left: tip.left, top: tip.top }}>
          <div className="tip-h">{range(active)}</div>
          <div className="tip-r">
            <i />
            {country}
            <b className={active.home ? undefined : 'none'}>{active.home ? money(active.home.cents) : 'keine Messung'}</b>
          </div>
          <div className="tip-r">
            <i className="w" />
            Weltweit{active.world?.region && <span className="tip-reg">{regionCode(active.world.region)}</span>}
            <b className={active.world ? undefined : 'none'}>{active.world ? money(active.world.cents) : 'keine Messung'}</b>
          </div>
          <div className="tip-r">
            Differenz
            <b>
              {active.home && active.world ? (active.home.cents - active.world.cents < 1 ? '±0' : `−${money(active.home.cents - active.world.cents)}`) : '–'}
            </b>
          </div>
        </div>
      )}
      <table className="sr-only">
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">Zeitraum</th>
            <th scope="col">{country}</th>
            <th scope="col">Weltweit</th>
          </tr>
        </thead>
        <tbody>
          {cols.map(c => (
            <tr key={c.start}>
              <th scope="row">{range(c)}</th>
              <td>{c.home ? money(c.home.cents) : 'keine Messung'}</td>
              <td>{c.world ? `${money(c.world.cents)}${c.world.region ? ` · ${regionCode(c.world.region)}` : ''}` : 'keine Messung'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
