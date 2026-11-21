import type { Settings } from '../../api';
import { Button } from '../../components';
import { SettingsPanel } from './parts';
import type { SettingsDraft } from './draft';
import ColumnList from './ColumnList';
import { OFFERS_COLUMNS, OFFERS_REQUIRED, offersColumnName, offersOrder } from '../offers-columns';
import type { OffersColumn } from '../offers-columns';

/** Order and visibility of the offers table on the game page (tab Angebote, 0.8.2), part of the settings draft. */
export default function OffersColumns({ settings, edit }: { settings: Settings; edit: SettingsDraft['edit'] }) {
  const order = offersOrder(settings.offers_columns);
  const hidden = settings.offers_hidden ?? [];
  const toggle = (column: OffersColumn, on: boolean) => edit(current => {
    const rest = (current.offers_hidden ?? []).filter(key => key !== column);
    return { ...current, offers_hidden: on ? rest : [...rest, column] };
  });
  const standard = order.every((column, index) => column === OFFERS_COLUMNS[index]) && hidden.length === 0;
  return <SettingsPanel title="Angebote · Spalten" titleId="general-offers-columns-title"
    aside={<Button size="sm" variant="ghost" disabled={standard}
      onClick={() => edit(current => ({ ...current, offers_columns: [...OFFERS_COLUMNS], offers_hidden: [] }))}>Standard wiederherstellen</Button>}>
    <div className="form-grid">
      <p className="hint col-order-hint">Spalten der Angebote auf der Seite eines Spiels. Oben steht die erste Spalte links; Warenkorb und „Zum Shop“ stehen immer am Ende, der Preis bleibt immer sichtbar.</p>
      <ColumnList order={order} label="Spaltenreihenfolge der Angebote" name={column => offersColumnName(column, settings.target_country ?? '')}
        shown={column => column === OFFERS_REQUIRED || !hidden.includes(column)} disabled={column => column === OFFERS_REQUIRED}
        lockedTitle={column => column === OFFERS_REQUIRED ? 'Der Preis bleibt sichtbar' : undefined}
        onToggle={toggle} onOrder={next => edit(current => ({ ...current, offers_columns: next }))} />
    </div>
  </SettingsPanel>;
}
