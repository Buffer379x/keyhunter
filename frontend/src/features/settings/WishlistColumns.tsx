import { useLayoutEffect, useRef, useState } from 'react';
import type { Settings } from '../../api';
import { Button, Icon, IconButton } from '../../components';
import { SettingsPanel } from './parts';
import type { Autosave } from './autosave';
import { WISHLIST_COLUMNS, columnNames, columnOrder, isDefaultOrder, moveColumn } from '../wishlist-columns';
import type { WishlistColumn } from '../wishlist-columns';

/**
 * Order of the wishlist table columns (top of the list = leftmost column): every column with "nach oben" and "nach unten", saved at once. The focus stays on the
 * moved column, so it can be moved several places with the keyboard. Phones keep their fixed card layout.
 */
export default function WishlistColumns({ settings, edit }: { settings: Settings; edit: Autosave['edit'] }) {
  const order = columnOrder(settings.wishlist_columns);
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
  const save = (next: WishlistColumn[]) => edit(current => ({ ...current, wishlist_columns: next }));
  function move(index: number, step: -1 | 1) {
    save(moveColumn(order, index, step));
    setFocus({ column: order[index], step });
  }
  return <SettingsPanel title="Wunschliste · Spalten" titleId="general-columns-title"
    aside={<Button size="sm" variant="ghost" disabled={isDefaultOrder(order)} onClick={() => save([...WISHLIST_COLUMNS])}>Standard wiederherstellen</Button>}>
    <div className="form-grid">
    <p className="hint col-order-hint">Oben steht die erste Spalte links in der Tabelle. Auf dem Handy bleibt die Kartenansicht gleich.</p>
    <ol className="col-order" aria-label="Spaltenreihenfolge der Wunschliste">
      {order.map((column, index) => <li key={column}>
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
