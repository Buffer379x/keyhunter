// Brand v3 for 0.7.0 (docs/modernization/branding/v3/ENTSCHEIDUNG.md, direction D "Preisschild massiv").
// The mark is a dark price tag with one large key hole on a solid orange tile, drawn on a 32 grid (master: v3/d-icon.svg).
// TAG is the master's stroked tag (stroke 1.6, round joins) expanded to a plain outline, with the key hole cut out (even-odd),
// so the mark needs no stroke, mask or id and renders identically in every browser.
const TAG = 'M4.392 15.481L11.392 7.281A.8 .8 0 0 1 12 7H26.2A.8 .8 0 0 1 27 7.8V24.2A.8 .8 0 0 1 26.2 25H12A.8 .8 0 0 1 11.392 24.719L4.392 16.519A.8 .8 0 0 1 4.392 15.481ZM16.956 16.537A3.3 3.3 0 1 1 20.644 16.537L21.6 21H16Z';
// "KEYHUNTER" in JetBrains Mono SemiBold (600), letter spacing .1em, converted to outlined paths (no font file needed).
// Sized to the icon: cap height 18 = the visible height of the tag (y 7 to 25), so the wordmark sits on the tile's optical centre;
// the ink starts 9 units after the 32-unit tile.
const WORDMARK = 'M43.89 25L41 25L41 7L43.89 7L43.89 14.4L46.13 14.4L49.68 7L52.79 7L48.67 15.63L53.01 25L49.78 25L46.11 16.99L43.89 16.99L43.89 25ZM69.21 25L58.53 25L58.53 7L69.21 7L69.21 9.52L61.37 9.52L61.37 14.42L68.35 14.42L68.35 16.94L61.37 16.94L61.37 22.48L69.21 22.48L69.21 25ZM82.38 25L79.52 25L79.52 18.42L74.19 7L77.18 7L80.18 13.53Q80.5 14.22 80.71 14.87Q80.92 15.51 81 15.88L81 15.88Q81.07 15.51 81.28 14.87Q81.49 14.22 81.79 13.53L81.79 13.53L84.72 7L87.7 7L82.38 18.42L82.38 25ZM95.69 25L92.81 25L92.81 7L95.69 7L95.69 14.35L100.72 14.35L100.72 7L103.61 7L103.61 25L100.72 25L100.72 17.01L95.69 17.01L95.69 25ZM115.47 25.25L115.47 25.25Q112.85 25.25 111.41 23.82Q109.97 22.39 109.97 19.92L109.97 19.92L109.97 7L112.83 7L112.83 19.9Q112.83 21.23 113.5 21.98Q114.16 22.73 115.47 22.73L115.47 22.73Q116.75 22.73 117.43 21.98Q118.11 21.23 118.11 19.9L118.11 19.9L118.11 7L120.97 7L120.97 19.92Q120.97 22.39 119.54 23.82Q118.11 25.25 115.47 25.25ZM129.87 25L127.23 25L127.23 7L130.78 7L135.91 21.75Q135.86 21.01 135.77 19.98Q135.69 18.96 135.64 17.86Q135.59 16.76 135.59 15.9L135.59 15.9L135.59 7L138.23 7L138.23 25L134.68 25L129.57 10.25Q129.65 10.92 129.71 11.91Q129.77 12.89 129.82 13.94Q129.87 14.99 129.87 15.88L129.87 15.88L129.87 25ZM151.42 25L148.56 25L148.56 9.64L143.78 9.64L143.78 6.98L156.2 6.98L156.2 9.64L151.42 9.64L151.42 25ZM172.77 25L162.1 25L162.1 7L172.77 7L172.77 9.52L164.93 9.52L164.93 14.42L171.91 14.42L171.91 16.94L164.93 16.94L164.93 22.48L172.77 22.48L172.77 25ZM181.95 25L179.08 25L179.08 7L184.76 7Q186.51 7 187.8 7.65Q189.1 8.31 189.81 9.5Q190.53 10.7 190.53 12.3L190.53 12.3Q190.53 14.1 189.61 15.45Q188.7 16.79 187.15 17.33L187.15 17.33L190.77 25L187.54 25L184.31 17.73L181.95 17.73L181.95 25ZM181.95 9.54L181.95 15.19L184.76 15.19Q186.06 15.19 186.84 14.43Q187.62 13.68 187.62 12.38L187.62 12.38Q187.62 11.07 186.84 10.3Q186.06 9.54 184.76 9.54L184.76 9.54L181.95 9.54Z';

/** The key-hole price tag without the tile. Colour via CSS (`.key-mark-fill`); `small` and `simple` are kept for old call sites. Decorative. */
export function KeyMark({ small = false }: { small?: boolean; simple?: boolean }) {
  return <svg className={small ? 'key-mark small' : 'key-mark'} viewBox="0 0 32 32" aria-hidden="true">
    <path className="key-mark-fill" fillRule="evenodd" d={TAG} />
  </svg>;
}
/** Mark (orange tile with the tag) and wordmark as one horizontal logo. Give it a size with the CSS height (default 32 px). */
export function Brand({ label = 'KeyHunter' }: { label?: string }) {
  return <svg className="brand" viewBox="0 0 191 32" role="img" aria-label={label}>
    <rect className="brand-tile" width="32" height="32" rx="7" />
    <path className="brand-tag" fillRule="evenodd" d={TAG} />
    <path className="brand-word" d={WORDMARK} />
  </svg>;
}
