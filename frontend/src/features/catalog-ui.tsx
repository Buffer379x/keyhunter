import { useEffect, useState } from 'react';
import { KeyMark } from '../components';
import type { CatalogGame, WishlistItem } from '../api';

/** Xbox systems a game can be added for (IGDB ids), newest first; 360 and the original Xbox since 0.8.1. */
export const PLATFORMS = [169, 49, 12, 11];
const platformNames: Record<number, string> = { 169: 'Xbox Series X|S', 49: 'Xbox One', 12: 'Xbox 360', 11: 'Xbox' };
export const platformName = (id: number) => platformNames[id] ?? 'Plattform unbekannt';
/** "Alle" in the add dialog: the search covers every system in PLATFORMS. */
export const ALL_PLATFORMS = 0;
export const itemName = (item: WishlistItem) => item.game?.name ?? item.manual_title ?? 'Unbekannter Titel';
export const selectionAllowed = (game: CatalogGame) => ['base_game', 'edition', 'remake', 'remaster', 'port', 'standalone_expansion'].includes(game.kind);
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
        bundle: 'Bündel · Inhalte ungeklärt',
      } as Record<string, string>
    )[game.kind] ?? 'Produkttyp ungeklärt'
  );
}
export function releaseYear(timestamp: number | null): string {
  if (timestamp === null) return 'Jahr unbekannt';
  const date = new Date(timestamp * 1000);
  return Number.isFinite(date.getTime()) ? String(date.getUTCFullYear()) : 'Jahr unbekannt';
}
const initials = (title: string) =>
  title
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map(word => word[0])
    .join('')
    .toUpperCase();
/** A stable hue per title, so a game without cover art keeps its colour (prototype cover gradient). */
const titleHue = (title: string) => [...title].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7) % 360;
/**
 * Cover image. Without an image (or when it fails to load) it shows the key mark, or, with `title`, the prototype's
 * gradient with the title's initials.
 */
export function Cover({ src, large = false, title }: { src: string | null; large?: boolean; title?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  const hue = title ? titleHue(title) : 0;
  return (
    <div className={`game-cover ${large ? 'large' : ''}`}>
      {src && !failed ? (
        <img src={src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      ) : title ? (
        <div
          className="cover-initials"
          aria-hidden="true"
          style={{ background: `linear-gradient(150deg, hsl(${hue} 38% 30%), hsl(${(hue + 30) % 360} 30% 14%))` }}
        >
          {initials(title)}
        </div>
      ) : (
        <div className="cover-fallback">
          <KeyMark small />
          <span>Kein Cover</span>
        </div>
      )}
    </div>
  );
}
