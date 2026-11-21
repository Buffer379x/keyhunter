/** Columns of the wishlist table; the settings choose their order (stored on the server, `wishlist_columns`). */
export const WISHLIST_COLUMNS = ['game', 'price', 'world', 'save', 'target', 'status', 'trend', 'open'] as const;
export type WishlistColumn = typeof WISHLIST_COLUMNS[number];

/** Names in the settings list (the price column is named after the target country there, like its header). */
export const columnNames: Record<WishlistColumn, string> = {
  game: 'Spiel (Cover und Titel)', price: 'Preis im Zielland', world: 'Günstigste Region', save: 'Ersparnis',
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

export const isDefaultOrder = (order: readonly string[]) => order.every((key, index) => key === WISHLIST_COLUMNS[index]);
