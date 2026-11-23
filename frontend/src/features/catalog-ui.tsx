import type { CatalogGame, WishlistItem } from '../api';

/** Xbox systems a game can be added for (IGDB ids), newest first; 360 and the original Xbox since 0.8.1. */
export const PLATFORMS = [169, 49, 12, 11];
const platformNames: Record<number, string> = { 169: 'Xbox Series X|S', 49: 'Xbox One', 12: 'Xbox 360', 11: 'Xbox' };
export const platformName = (id: number) => platformNames[id] ?? 'Plattform unbekannt';
/** "Alle" in the add dialog: the search covers every system in PLATFORMS. */
export const ALL_PLATFORMS = 0;
export const itemName = (item: WishlistItem) => item.game?.name ?? item.manual_title ?? 'Unbekannter Titel';
export const selectionAllowed = (game: CatalogGame) =>
  ['base_game', 'edition', 'remake', 'remaster', 'port', 'standalone_expansion', 'bundle'].includes(game.kind);
export function kindName(game: CatalogGame): string {
  return (
    (
      {
        base_game: 'Basisspiel',
        edition: game.edition_name ?? 'Edition',
        remake: 'Remake',
        remaster: 'Remaster',
        port: 'Portierung',
        standalone_expansion: 'Eigenständige Erweiterung',
        dlc: 'DLC / Zusatzinhalt',
        mod: 'Modifikation',
        bundle: 'Bündel',
      } as Record<string, string>
    )[game.kind] ?? 'Produkttyp ungeklärt'
  );
}
export function releaseYear(timestamp: number | null): string {
  if (timestamp === null) return 'Jahr unbekannt';
  const date = new Date(timestamp * 1000);
  return Number.isFinite(date.getTime()) ? String(date.getUTCFullYear()) : 'Jahr unbekannt';
}
