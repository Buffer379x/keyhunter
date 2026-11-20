import type { WishlistItem } from '../api.ts';
import type { RowFacts } from './wishlist-model.ts';

/** Sort modes of the wishlist: newest first, target-country price, biggest saving abroad, closest to the alarm target. */
export type SortMode = 'added' | 'price' | 'save' | 'target';
export const sortModes: SortMode[] = ['added', 'price', 'save', 'target'];
export const isSortMode = (value: unknown): value is SortMode => typeof value === 'string' && (sortModes as string[]).includes(value);

/**
 * Sorts a copy of `items`. Missing values (no price, no saving, no target) always go last, never count as zero.
 * Ties fall back to the newest addition, then to the original order.
 */
export function sortWishlist(items: WishlistItem[], facts: Record<string, RowFacts | undefined>, mode: SortMode): WishlistItem[] {
  const position = new Map(items.map((item, index) => [item.id, index]));
  const key = (item: WishlistItem): number => {
    const row = facts[item.id];
    if (!row) return Infinity;
    if (mode === 'price') return row.price ?? Infinity;
    if (mode === 'save') return row.saving !== null ? -row.saving : Infinity;
    if (mode === 'target') return row.price !== null && row.target !== null ? row.price - row.target : Infinity;
    return 0;
  };
  return [...items].sort((a, b) => {
    if (mode !== 'added') {
      const first = key(a), second = key(b);
      if (first !== second) return first === Infinity ? 1 : second === Infinity ? -1 : first - second;
    }
    return b.created_at - a.created_at || position.get(a.id)! - position.get(b.id)!;
  });
}
