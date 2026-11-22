import type { Settings } from '../../api';
import { Button, Help, Seg } from '../../components';
import type { SettingsDraft } from './draft';
import ColumnList from './ColumnList';
import { WISHLIST_COLUMNS, columnNames, columnOrder, hiddenFor, isDefaultOrder, openMode, openModes, openerColumn } from '../wishlist-columns';
import type { OpenMode, WishlistColumn } from '../wishlist-columns';

/**
 * Order of the wishlist table columns (top of the list = leftmost column), part of the settings draft. Each column has a
 * switch to show or hide it (0.7.1); the column that opens the game page cannot be hidden. What opens it is chosen above the
 * list: the details button, the title or the cover (only one of them). Phones keep their fixed card layout. Since 0.8.3 a tab
 * of the panel "Tabellenspalten" (TableColumns).
 */
export default function WishlistColumns({ settings, edit }: { settings: Settings; edit: SettingsDraft['edit'] }) {
  const order = columnOrder(settings.wishlist_columns);
  const code = settings.target_country;
  const mode = openMode(settings.wishlist_open);
  const opener = openerColumn(mode);
  const hidden = settings.wishlist_hidden ?? [];
  const shown = (column: WishlistColumn) => column === opener || (!hidden.includes(column) && (column !== 'open' || mode === 'button'));
  const toggle = (column: WishlistColumn, on: boolean) =>
    edit(current => {
      const rest = (current.wishlist_hidden ?? []).filter(key => key !== column);
      return { ...current, wishlist_hidden: on ? rest : [...rest, column] };
    });
  const choose = (next: OpenMode) => edit(current => ({ ...current, wishlist_open: next, wishlist_hidden: hiddenFor(current.wishlist_hidden, next) }));
  const name = (column: WishlistColumn) => (column === 'price' && code ? `Preis ${code}` : columnNames[column]);
  const openHelp =
    mode === 'button'
      ? 'Der Details-Button in der Tabelle öffnet das Spiel.'
      : mode === 'title'
        ? 'Ein Klick auf den Spieletitel öffnet das Spiel; Cover und Button öffnen nichts.'
        : 'Ein Klick auf das Cover öffnet das Spiel; Titel und Button öffnen nichts.';
  return (
    <div className="form-grid">
      <div className="col-tools">
        <div className="form-row">
          <span className="with-help">
            <span id="open-mode-label">Detailseite öffnen über</span>
            <Help label="Hilfe zu Detailseite öffnen über">{openHelp}</Help>
          </span>
          <Seg label="Detailseite öffnen über" value={mode} onChange={choose} options={openModes} />
        </div>
        <span className="spacer" />
        <Help label="Hilfe zu den Spalten der Wunschliste">
          <span>
            Oben steht die erste Spalte links in der Tabelle. Zum Verschieben eine Zeile am Griff ziehen oder die Pfeile nutzen; der Schalter blendet eine
            Spalte ein oder aus.
          </span>
          <span>Auf dem Handy bleibt die Kartenansicht gleich.</span>
        </Help>
        <Button
          size="sm"
          variant="ghost"
          disabled={isDefaultOrder(order) && hidden.length === 0 && mode === 'button'}
          onClick={() => edit(current => ({ ...current, wishlist_columns: [...WISHLIST_COLUMNS], wishlist_hidden: [], wishlist_open: 'button' }))}
        >
          Standard wiederherstellen
        </Button>
      </div>
      <ColumnList
        order={order}
        label="Spaltenreihenfolge der Wunschliste"
        name={name}
        shown={shown}
        note={column => column === 'open' && mode !== 'button' && <small className="faint"> · nur mit Button</small>}
        disabled={column => column === opener || (column === 'open' && mode !== 'button')}
        lockedTitle={column => (column === opener ? 'Öffnet die Detailseite, bleibt sichtbar' : undefined)}
        onToggle={toggle}
        onOrder={next => edit(current => ({ ...current, wishlist_columns: next }))}
      />
    </div>
  );
}
