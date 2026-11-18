import { useEffect, useState } from 'react';
import { KeyMark } from '../components';
import type { CatalogGame, WishlistItem } from '../api';

export const platformName = (id: number) => id === 169 ? 'Xbox Series X|S' : id === 49 ? 'Xbox One' : 'Plattform unbekannt';
export const itemName = (item: WishlistItem) => item.game?.name ?? item.manual_title ?? 'Unbekannter Titel';
export const selectionAllowed = (game: CatalogGame) => ['base_game', 'edition', 'remake', 'remaster', 'port', 'standalone_expansion'].includes(game.kind);
export function kindName(game: CatalogGame): string {
  return ({ base_game: 'Basisspiel', edition: game.edition_name ?? 'Edition', remake: 'Remake', remaster: 'Remaster', port: 'Portierung', standalone_expansion: 'Eigenständige Erweiterung', dlc: 'DLC / Zusatzinhalt', mod: 'Modifikation', bundle: 'Bündel · Inhalte ungeklärt' } as Record<string, string>)[game.kind] ?? 'Produkttyp ungeklärt';
}
export function releaseYear(timestamp: number | null): string {
  if (timestamp === null) return 'Jahr unbekannt';
  const date = new Date(timestamp * 1000);
  return Number.isFinite(date.getTime()) ? String(date.getUTCFullYear()) : 'Jahr unbekannt';
}
export function Cover({ src, large = false }: { src: string | null; large?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return <div className={`game-cover ${large ? 'large' : ''}`}>
    {src && !failed ? <img src={src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : <div className="cover-fallback"><KeyMark small /><span>Kein Cover</span></div>}
  </div>;
}
