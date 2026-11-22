import type { WishlistItem } from '../api.ts';
import type { RowFacts } from './wishlist-model.ts';

/**
 * Sorting of the wishlist by its column headers. `added` (newest first) is the order without a sorted column.
 * title: game name · price: target-country price · world: cheapest region worldwide · save: saving abroad ·
 * target: alarm target · status: distance to the alarm target (reached ones lead).
 */
export type SortKey = 'added' | 'title' | 'price' | 'world' | 'save' | 'target' | 'status';
export type SortDir = 'asc' | 'desc';
export interface WishlistSort {
  key: SortKey;
  dir: SortDir;
}
export const sortKeys: SortKey[] = ['added', 'title', 'price', 'world', 'save', 'target', 'status'];
export const DEFAULT_SORT: WishlistSort = { key: 'added', dir: 'desc' };

/** Direction of the first click on a header: the saving starts with the biggest one, everything else ascending. */
export const firstDir = (key: SortKey): SortDir => (key === 'save' || key === 'added' ? 'desc' : 'asc');

/** A click on a header: first click sorts in its natural direction, the second reverses it, the third goes back to "newest first". */
export function nextSort(current: WishlistSort, key: SortKey): WishlistSort {
  if (current.key !== key) return { key, dir: firstDir(key) };
  if (current.dir === firstDir(key)) return { key, dir: firstDir(key) === 'asc' ? 'desc' : 'asc' };
  return DEFAULT_SORT;
}

/** Reads the stored sort. Also understands the sort modes of 0.6.1 and older ("price", "save", "target"). */
export function parseSort(value: string | null | undefined): WishlistSort {
  if (!value) return DEFAULT_SORT;
  const legacy: Record<string, WishlistSort> = {
    added: DEFAULT_SORT,
    price: { key: 'price', dir: 'asc' },
    save: { key: 'save', dir: 'desc' },
    target: { key: 'status', dir: 'asc' },
  };
  if (legacy[value]) return legacy[value];
  const [key, dir] = value.split(':');
  return (sortKeys as string[]).includes(key) && (dir === 'asc' || dir === 'desc') ? { key: key as SortKey, dir } : DEFAULT_SORT;
}
export const serializeSort = (sort: WishlistSort) => `${sort.key}:${sort.dir}`;

const name = (item: WishlistItem) => item.game?.name ?? item.manual_title ?? '';
const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });

/**
 * Sorts a copy of `items`. Missing values (no price, no saving, no target) always go last, in both directions, and never count as zero.
 * Ties fall back to the newest addition, then to the original order.
 */
export function sortWishlist(items: WishlistItem[], facts: Record<string, RowFacts | undefined>, sort: WishlistSort): WishlistItem[] {
  const position = new Map(items.map((item, index) => [item.id, index]));
  const sign = sort.dir === 'asc' ? 1 : -1;
  const value = (item: WishlistItem): number | null => {
    const row = facts[item.id];
    if (!row) return null;
    switch (sort.key) {
      case 'price':
        return row.price;
      case 'world':
        return row.world?.cents ?? null;
      case 'save':
        return row.saving;
      case 'target':
        return row.target;
      case 'status':
        return row.price !== null && row.target !== null ? row.price - row.target : null;
      default:
        return null;
    }
  };
  const newest = (a: WishlistItem, b: WishlistItem) => b.created_at - a.created_at || position.get(a.id)! - position.get(b.id)!;
  return [...items].sort((a, b) => {
    if (sort.key === 'added') return sort.dir === 'desc' ? newest(a, b) : a.created_at - b.created_at || position.get(a.id)! - position.get(b.id)!;
    if (sort.key === 'title') return sign * collator.compare(name(a), name(b)) || newest(a, b);
    const first = value(a),
      second = value(b);
    if (first !== second) {
      if (first === null) return 1;
      if (second === null) return -1;
      return sign * (first - second);
    }
    return newest(a, b);
  });
}
