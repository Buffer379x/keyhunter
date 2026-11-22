import type { WishlistItem } from '../api';
import { itemName, platformName } from './catalog-ui';

/**
 * JSON export of the wishlist (title, platform, IGDB id, kind and verification state), the same file the wishlist's own
 * "Liste exportieren" writes. The settings page loads /wishlist and calls this, so it does not depend on Wishlist.tsx.
 */
export function wishlistExport(items: WishlistItem[]) {
  return {
    version: 1,
    exported_at: new Date().toISOString(),
    items: items.map(item => ({
      title: itemName(item),
      platform: platformName(item.platform_id),
      igdb_id: item.game?.igdb_id ?? null,
      kind: item.game?.kind ?? null,
      verification: item.verification,
    })),
  };
}

export function downloadJson(filename: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
