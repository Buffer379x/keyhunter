/** Columns of the wishlist table; the settings choose their order (stored on the server, `wishlist_columns`). */
export const WISHLIST_COLUMNS = ['game', 'price', 'world', 'save', 'target', 'status', 'trend', 'open'] as const;
export type WishlistColumn = typeof WISHLIST_COLUMNS[number];

/** Names in the settings list (the price column is named after the target country there, like its header). */
export const columnNames: Record<WishlistColumn, string> = {
  game: 'Spiel (Cover und Titel)', price: 'Preis im Zielland', world: 'Preis INT', save: 'Ersparnis',
  target: 'Ziel', status: 'Status', trend: '14 Tage', open: 'Details öffnen',
};

/** A valid order (every column exactly once), or the default order. */
export function columnOrder(stored: readonly string[] | null | undefined): WishlistColumn[] {
  const known = new Set<string>(WISHLIST_COLUMNS);
  const valid = !!stored && stored.length === WISHLIST_COLUMNS.length && new Set(stored).size === stored.length && stored.every(key => known.has(key));
  return valid ? [...stored as WishlistColumn[]] : [...WISHLIST_COLUMNS];
}

/** The order with the column at `index` moved one place up (-1) or down (+1). */
export function moveColumn(order: WishlistColumn[], index: number, step: -1 | 1): WishlistColumn[] {
  const target = index + step;
  if (index < 0 || target < 0 || target >= order.length) return order;
  const next = [...order];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** The order with the column at `from` taken out and put in at `to` (drag and drop). */
export function moveColumnTo(order: WishlistColumn[], from: number, to: number): WishlistColumn[] {
  if (from < 0 || from >= order.length) return order;
  const target = Math.max(0, Math.min(order.length - 1, to));
  if (target === from) return order;
  const next = [...order];
  const [column] = next.splice(from, 1);
  next.splice(target, 0, column);
  return next;
}

/** What opens the game page from the list (0.7.1): the details button, the title or the cover; only one of them. */
export type OpenMode = 'button' | 'title' | 'cover';
export const openModes: { value: OpenMode; label: string }[] = [{ value: 'button', label: 'Button' }, { value: 'title', label: 'Titel' }, { value: 'cover', label: 'Cover' }];
export const openMode = (stored: string | null | undefined): OpenMode => stored === 'title' || stored === 'cover' ? stored : 'button';
/** The column that opens the game page and therefore cannot be hidden. */
export const openerColumn = (mode: OpenMode): WishlistColumn => mode === 'button' ? 'open' : 'game';
/** Columns the table shows, in order: not hidden, and the button column only when the button opens the game. */
export function visibleColumns(order: WishlistColumn[], hidden: readonly string[] | null | undefined, mode: OpenMode): WishlistColumn[] {
  const opener = openerColumn(mode);
  return order.filter(column => column === opener || (!hidden?.includes(column) && (column !== 'open' || mode === 'button')));
}
/** Hidden columns after choosing a mode: the new opener is always shown. */
export const hiddenFor = (hidden: readonly string[] | null | undefined, mode: OpenMode) => (hidden ?? []).filter(column => column !== openerColumn(mode));

export const isDefaultOrder = (order: readonly string[]) => order.every((key, index) => key === WISHLIST_COLUMNS[index]);
