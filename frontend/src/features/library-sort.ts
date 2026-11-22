import type { LibraryItem } from '../api.ts';
export function libraryItems(items: LibraryItem[], system: string, sort: 'added' | 'name'): LibraryItem[] {
  return items
    .filter(item => system === 'all' || String(item.platform_id) === system)
    .sort((a, b) => {
      const name = (a.game?.name ?? a.manual_title ?? '').localeCompare(b.game?.name ?? b.manual_title ?? '', 'de', { numeric: true, sensitivity: 'base' });
      return sort === 'name' ? name || b.acquired_at - a.acquired_at : b.acquired_at - a.acquired_at || name;
    });
}
