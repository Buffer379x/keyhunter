import type { Settings } from '../../api';
import { Button, Help } from '../../components';
import type { SettingsDraft } from './draft';
import ColumnList from './ColumnList';
import { OFFERS_COLUMNS, OFFERS_DEFAULT_HIDDEN, OFFERS_REQUIRED, offersColumnName, offersOrder } from '../offers-columns';
import type { OffersColumn } from '../offers-columns';

/** Order and visibility of the offers table on the game page (tab Angebote, 0.8.2), part of the settings draft; a tab of "Tabellenspalten" since 0.8.3. */
export default function OffersColumns({ settings, edit }: { settings: Settings; edit: SettingsDraft['edit'] }) {
  const order = offersOrder(settings.offers_columns);
  const hidden = settings.offers_hidden ?? [];
  const toggle = (column: OffersColumn, on: boolean) =>
    edit(current => {
      const rest = (current.offers_hidden ?? []).filter(key => key !== column);
      return { ...current, offers_hidden: on ? rest : [...rest, column] };
    });
  const standard =
    order.every((column, index) => column === OFFERS_COLUMNS[index]) &&
    hidden.length === OFFERS_DEFAULT_HIDDEN.length &&
    OFFERS_DEFAULT_HIDDEN.every(column => hidden.includes(column));
  return (
    <div className="form-grid">
      <div className="col-tools">
        <span className="spacer" />
        <Help label="Hilfe zu den Spalten der Angebote">
          <span>Spalten der Angebote auf der Seite eines Spiels. Oben steht die erste Spalte links.</span>
          <span>Warenkorb und „Zum Shop“ stehen immer am Ende, der Preis bleibt immer sichtbar.</span>
          <span>Das Prüftempo (häufig, normal, selten) zeigt, wie oft KeyHunter ein Angebot prüft. Es ist keine Bewertung und standardmäßig ausgeblendet.</span>
        </Help>
        <Button
          size="sm"
          variant="ghost"
          disabled={standard}
          onClick={() => edit(current => ({ ...current, offers_columns: [...OFFERS_COLUMNS], offers_hidden: [...OFFERS_DEFAULT_HIDDEN] }))}
        >
          Standard wiederherstellen
        </Button>
      </div>
      <ColumnList
        order={order}
        label="Spaltenreihenfolge der Angebote"
        name={column => offersColumnName(column, settings.target_country ?? '')}
        shown={column => column === OFFERS_REQUIRED || !hidden.includes(column)}
        disabled={column => column === OFFERS_REQUIRED}
        lockedTitle={column => (column === OFFERS_REQUIRED ? 'Der Preis bleibt sichtbar' : undefined)}
        onToggle={toggle}
        onOrder={next => edit(current => ({ ...current, offers_columns: next }))}
      />
    </div>
  );
}
