// Brand v3 for 0.7.0 (docs/modernization/branding/v3/ENTSCHEIDUNG.md, direction D "Preisschild massiv").
// The mark is a dark price tag with one large key hole on a solid orange tile, drawn on a 32 grid (master: v3/d-icon.svg).
// TAG is the master's stroked tag (stroke 1.6, round joins) expanded to a plain outline, with the key hole cut out (even-odd),
// so the mark needs no stroke, mask or id and renders identically in every browser.
const TAG = 'M4.392 15.481L11.392 7.281A.8 .8 0 0 1 12 7H26.2A.8 .8 0 0 1 27 7.8V24.2A.8 .8 0 0 1 26.2 25H12A.8 .8 0 0 1 11.392 24.719L4.392 16.519A.8 .8 0 0 1 4.392 15.481ZM16.956 16.537A3.3 3.3 0 1 1 20.644 16.537L21.6 21H16Z';
// "KEYHUNTER" in JetBrains Mono SemiBold (600), converted to outlined paths (no font file needed).
// 0.7.1: cap height 15 (between the 12 of the old wordmark and the 18 of 0.7.0), centred on the tile (y 8.5 to 23.5);
// letter spacing .252em so the ink spans x 41 to 190.8 like before and fills the logo box (no gap on the right).
const WORDMARK = 'M43.41 23.50L41.00 23.50L41.00 8.50L43.41 8.50L43.41 14.66L45.28 14.66L48.24 8.50L50.83 8.50L47.39 15.69L51.01 23.50L48.32 23.50L45.26 16.82L43.41 16.82L43.41 23.50ZM67.63 23.50L58.73 23.50L58.73 8.50L67.63 8.50L67.63 10.60L61.10 10.60L61.10 14.68L66.91 14.68L66.91 16.78L61.10 16.78L61.10 21.40L67.63 21.40L67.63 23.50ZM81.73 23.50L79.34 23.50L79.34 18.01L74.90 8.50L77.39 8.50L79.90 13.95Q80.16 14.52 80.34 15.05Q80.51 15.59 80.58 15.90L80.58 15.90Q80.64 15.59 80.81 15.05Q80.99 14.52 81.23 13.95L81.23 13.95L83.68 8.50L86.16 8.50L81.73 18.01L81.73 23.50ZM95.94 23.50L93.54 23.50L93.54 8.50L95.94 8.50L95.94 14.62L100.13 14.62L100.13 8.50L102.54 8.50L102.54 23.50L100.13 23.50L100.13 16.84L95.94 16.84L95.94 23.50ZM115.54 23.71L115.54 23.71Q113.37 23.71 112.16 22.51Q110.96 21.32 110.96 19.27L110.96 19.27L110.96 8.50L113.34 8.50L113.34 19.25Q113.34 20.36 113.90 20.98Q114.45 21.61 115.54 21.61L115.54 21.61Q116.61 21.61 117.18 20.98Q117.74 20.36 117.74 19.25L117.74 19.25L117.74 8.50L120.13 8.50L120.13 19.27Q120.13 21.32 118.93 22.51Q117.74 23.71 115.54 23.71ZM130.66 23.50L128.47 23.50L128.47 8.50L131.43 8.50L135.70 20.79Q135.66 20.17 135.59 19.32Q135.51 18.47 135.47 17.55Q135.43 16.64 135.43 15.92L135.43 15.92L135.43 8.50L137.63 8.50L137.63 23.50L134.67 23.50L130.42 11.21Q130.48 11.77 130.53 12.59Q130.58 13.41 130.62 14.28Q130.66 15.16 130.66 15.90L130.66 15.90L130.66 23.50ZM151.74 23.50L149.36 23.50L149.36 10.70L145.38 10.70L145.38 8.48L155.73 8.48L155.73 10.70L151.74 10.70L151.74 23.50ZM172.66 23.50L163.76 23.50L163.76 8.50L172.66 8.50L172.66 10.60L166.13 10.60L166.13 14.68L171.94 14.68L171.94 16.78L166.13 16.78L166.13 21.40L172.66 21.40L172.66 23.50ZM183.43 23.50L181.04 23.50L181.04 8.50L185.77 8.50Q187.23 8.50 188.31 9.04Q189.38 9.59 189.98 10.59Q190.58 11.58 190.58 12.92L190.58 12.92Q190.58 14.42 189.82 15.54Q189.06 16.66 187.76 17.11L187.76 17.11L190.78 23.50L188.09 23.50L185.40 17.44L183.43 17.44L183.43 23.50ZM183.43 10.62L183.43 15.32L185.77 15.32Q186.86 15.32 187.50 14.70Q188.15 14.07 188.15 12.98L188.15 12.98Q188.15 11.89 187.50 11.25Q186.86 10.62 185.77 10.62L185.77 10.62L183.43 10.62Z';

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
