import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { Icon, IconButton, Switch } from '../../components';
import { moveColumn, moveColumnTo } from '../wishlist-columns';

/**
 * Ordered list of table columns with a switch each (wishlist 0.6.5/0.7.1, offers 0.8.2); the top row is the leftmost column.
 * Each row can be dragged by its grip (mouse, pen or touch; the list reorders live and Escape cancels) or moved with
 * "nach oben" and "nach unten"; with the buttons the focus stays on the moved column, so it can be moved several places with
 * the keyboard.
 */
export default function ColumnList<T extends string>({ order: saved, label, name, note, shown, disabled, lockedTitle, onToggle, onOrder }: {
  order: T[]; label: string; name: (column: T) => string; note?: (column: T) => ReactNode;
  shown: (column: T) => boolean; disabled: (column: T) => boolean; lockedTitle?: (column: T) => string | undefined;
  onToggle: (column: T, on: boolean) => void; onOrder: (next: T[]) => void;
}) {
  /** While dragging: the column held and the order shown so far. */
  const [drag, setDrag] = useState<{ column: T; order: T[] } | null>(null);
  const order = drag?.order ?? saved;
  const rows = useRef(new Map<T, HTMLLIElement>());
  // The list holds the pointer capture: it stays in place while its rows are reordered under the pointer.
  const list = useRef<HTMLOListElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const [focus, setFocus] = useState<{ column: T; step: -1 | 1 } | null>(null);
  useLayoutEffect(() => {
    if (!focus) return;
    const index = order.indexOf(focus.column);
    // At the first or last place the pressed button is disabled; the other button of the same column takes the focus.
    const step = (focus.step === -1 && index === 0) || (focus.step === 1 && index === order.length - 1) ? -focus.step : focus.step;
    buttons.current.get(`${focus.column}:${step}`)?.focus();
    setFocus(null);
  }, [focus, order]);
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    const cancel = (event: KeyboardEvent) => { if (event.key === 'Escape') setDrag(null); };
    window.addEventListener('keydown', cancel);
    return () => window.removeEventListener('keydown', cancel);
  }, [dragging]);
  function move(index: number, step: -1 | 1) {
    onOrder(moveColumn(order, index, step));
    setFocus({ column: order[index], step });
  }
  function grab(event: ReactPointerEvent<HTMLSpanElement>, column: T) {
    if (event.button !== 0) return;
    event.preventDefault();
    list.current?.setPointerCapture(event.pointerId);
    setDrag({ column, order: saved });
  }
  function follow(event: ReactPointerEvent<HTMLOListElement>) {
    if (!drag) return;
    // New place = number of other rows whose middle lies above the pointer.
    const others = drag.order.filter(column => column !== drag.column);
    const target = others.filter(column => {
      const box = rows.current.get(column)?.getBoundingClientRect();
      return box ? box.top + box.height / 2 < event.clientY : false;
    }).length;
    const next = moveColumnTo(drag.order, drag.order.indexOf(drag.column), target);
    if (next !== drag.order) setDrag({ ...drag, order: next });
  }
  function drop() {
    if (drag && drag.order.some((column, index) => column !== saved[index])) onOrder(drag.order);
    setDrag(null);
  }
  return <ol ref={list} className={`col-order${drag ? ' dragging' : ''}`} aria-label={label}
    onPointerMove={follow} onPointerUp={drop} onPointerCancel={() => setDrag(null)} onLostPointerCapture={() => setDrag(null)}>
    {order.map((column, index) => <li key={column} className={drag?.column === column ? 'held' : undefined}
      ref={element => { if (element) rows.current.set(column, element); else rows.current.delete(column); }}>
      <span className="col-grip" aria-hidden="true" title="Ziehen zum Verschieben"
        onPointerDown={event => grab(event, column)}><Icon name="grip" /></span>
      <span className="col-pos mono" aria-hidden="true">{index + 1}</span>
      <span className="col-name">{name(column)}{note?.(column)}</span>
      <Switch checked={shown(column)} disabled={disabled(column)} onChange={on => onToggle(column, on)}
        title={lockedTitle?.(column)}><span className="sr-only">{name(column)} anzeigen</span></Switch>
      <IconButton ref={element => { if (element) buttons.current.set(`${column}:-1`, element); else buttons.current.delete(`${column}:-1`); }}
        label={`${name(column)} nach oben`} disabled={index === 0} onClick={() => move(index, -1)}><Icon name="up" /></IconButton>
      <IconButton ref={element => { if (element) buttons.current.set(`${column}:1`, element); else buttons.current.delete(`${column}:1`); }}
        label={`${name(column)} nach unten`} disabled={index === order.length - 1} onClick={() => move(index, 1)}><Icon name="down" /></IconButton>
    </li>)}
  </ol>;
}
