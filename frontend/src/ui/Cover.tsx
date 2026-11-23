import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';

type CoverSize = 'xs' | 'sm' | 'md' | 'lg' | 'fluid';

/** Up to two initials of the title, letters and digits only: "Forza Horizon 5" → "FH". */
const coverInitials = (title: string) =>
  title
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map(word => word[0])
    .join('')
    .toUpperCase();
/** A stable hue per title, so a game without cover art keeps its colour. */
const coverHue = (title: string) => [...title].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7) % 360;

/**
 * Game cover (`.cover`, 1.0 / DS-09): the one cover of the app. Sizes: xs 30 × 40 (cart), sm 34 × 44 (lists, search),
 * md 48 × 64, lg 72 × 96 (game page), fluid (the library grid; 3 : 4 at the width of its box). Without an image, or when it
 * fails to load, the prototype's fallback: the title's initials on a gradient whose hue comes from the title (`--hue`, the
 * formula is in ui.css). Decorative: the title always stands next to it.
 */
export function Cover({ src, title, size = 'sm', className = '' }: { src: string | null | undefined; title: string; size?: CoverSize; className?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  const image = !!src && !failed;
  return (
    <span
      className={`cover ${size}${image ? '' : ' initials'} ${className}`.trim()}
      style={image ? undefined : ({ '--hue': coverHue(title) } as CSSProperties)}
      aria-hidden="true"
    >
      {image ? <img src={src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : coverInitials(title)}
    </span>
  );
}
