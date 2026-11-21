/**
 * Columns of the offers table on the game page (tab Angebote, 0.8.2): order and visibility come from the settings
 * (`offers_columns`, `offers_hidden`), like the wishlist columns. The actions (cart, "Zum Shop") always stay last.
 */
export const OFFERS_COLUMNS = ['shop', 'region', 'validity', 'price', 'diff', 'score', 'seen'] as const;
export type OffersColumn = typeof OFFERS_COLUMNS[number];
/** Without the price the table has no purpose: it is always shown. */
export const OFFERS_REQUIRED: OffersColumn = 'price';

/** Names in the settings and the table head ("vs. DE" carries the target country). */
export const offersColumnName = (column: OffersColumn, code: string) => ({
  shop: 'Shop', region: 'Region', validity: 'Gültigkeit', price: 'Preis', diff: `vs. ${code || 'Zielland'}`, score: 'Score', seen: 'Gesehen',
} as Record<OffersColumn, string>)[column];

/** A valid order (every column exactly once), or the default order. */
export function offersOrder(stored: readonly string[] | null | undefined): OffersColumn[] {
  const known = new Set<string>(OFFERS_COLUMNS);
  const valid = !!stored && stored.length === OFFERS_COLUMNS.length && new Set(stored).size === stored.length && stored.every(key => known.has(key));
  return valid ? [...stored as OffersColumn[]] : [...OFFERS_COLUMNS];
}

/** Columns the table shows, in order: not hidden, the price always. */
export const visibleOffersColumns = (order: OffersColumn[], hidden: readonly string[] | null | undefined) =>
  order.filter(column => column === OFFERS_REQUIRED || !hidden?.includes(column));

/**
 * Half of the colour scale a score (0 to 100) lies on: the CSS mixes red into yellow up to 50 ("lo") and yellow into green
 * from 50 ("hi"), so every score has its own colour between red (0) and green (100).
 */
export const scoreTone = (score: number) => score < 50 ? 'lo' : 'hi';
