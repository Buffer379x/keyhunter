import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Settings } from '../../api';
import { Button, Icon, IconButton } from '../../components';
import { SettingsPanel } from './parts';
import type { SettingsDraft } from './draft';
import { WISHLIST_COLUMNS, columnNames, columnOrder, isDefaultOrder, moveColumn, moveColumnTo } from '../wishlist-columns';
import type { WishlistColumn } from '../wishlist-columns';

/**
 * Order of the wishlist table columns (top of the list = leftmost column), part of the settings draft. Each row can be
 * dragged by its grip (mouse, pen or touch; the list reorders live and Escape cancels) or moved with "nach oben" and
 * "nach unten"; with the buttons the focus stays on the moved column, so it can be moved several places with the keyboard.
 * Phones keep their fixed card layout in the wishlist.
 */
export default function WishlistColumns({ settings, edit }: { settings: Settings; edit: SettingsDraft['edit'] }) {
  const saved = columnOrder(settings.wishlist_columns);
  /** While dragging: the column held and the order shown so far. */
  const [drag, setDrag] = useState<{ column: WishlistColumn; order: WishlistColumn[] } | null>(null);
  const order = drag?.order ?? saved;
  const rows = useRef(new Map<WishlistColumn, HTMLLIElement>());
  // The list holds the pointer capture: it stays in place while its rows are reordered under the pointer.
  const list = useRef<HTMLOListElement>(null);
  const code = settings.target_country;
  const name = (column: WishlistColumn) => column === 'price' && code ? `Preis ${code}` : columnNames[column];
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const [focus, setFocus] = useState<{ column: WishlistColumn; step: -1 | 1 } | null>(null);
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
  const save = (next: WishlistColumn[]) => edit(current => ({ ...current, wishlist_columns: next }));
  function move(index: number, step: -1 | 1) {
    save(moveColumn(order, index, step));
    setFocus({ column: order[index], step });
  }
  function grab(event: ReactPointerEvent<HTMLSpanElement>, column: WishlistColumn) {
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
    if (drag && drag.order.some((column, index) => column !== saved[index])) save(drag.order);
    setDrag(null);
  }
  return <SettingsPanel title="Wunschliste · Spalten" titleId="general-columns-title"
    aside={<Button size="sm" variant="ghost" disabled={isDefaultOrder(order)} onClick={() => save([...WISHLIST_COLUMNS])}>Standard wiederherstellen</Button>}>
    <div className="form-grid">
    <p className="hint col-order-hint">Oben steht die erste Spalte links in der Tabelle. Zum Verschieben eine Zeile am Griff ziehen oder die Pfeile nutzen. Auf dem Handy bleibt die Kartenansicht gleich.</p>
    <ol ref={list} className={`col-order${drag ? ' dragging' : ''}`} aria-label="Spaltenreihenfolge der Wunschliste"
      onPointerMove={follow} onPointerUp={drop} onPointerCancel={() => setDrag(null)} onLostPointerCapture={() => setDrag(null)}>
      {order.map((column, index) => <li key={column} className={drag?.column === column ? 'held' : undefined}
        ref={element => { if (element) rows.current.set(column, element); else rows.current.delete(column); }}>
        <span className="col-grip" aria-hidden="true" title="Ziehen zum Verschieben"
          onPointerDown={event => grab(event, column)}><Icon name="grip" /></span>
        <span className="col-pos mono" aria-hidden="true">{index + 1}</span>
        <span className="col-name">{name(column)}</span>
        <IconButton ref={element => { if (element) buttons.current.set(`${column}:-1`, element); else buttons.current.delete(`${column}:-1`); }}
          label={`${name(column)} nach oben`} disabled={index === 0} onClick={() => move(index, -1)}><Icon name="up" /></IconButton>
        <IconButton ref={element => { if (element) buttons.current.set(`${column}:1`, element); else buttons.current.delete(`${column}:1`); }}
          label={`${name(column)} nach unten`} disabled={index === order.length - 1} onClick={() => move(index, 1)}><Icon name="down" /></IconButton>
      </li>)}
    </ol>
    </div>
  </SettingsPanel>;
}
