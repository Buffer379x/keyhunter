import { useId } from 'react';

// Brand assets from docs/modernization/branding/v2 (approved drawing, unchanged).
// The mark is the price tag with a key hole inside a target reticle ("Visier").
const TAG = 'M3.5 16l7.1-8.8Q11.5 6 13 6h13q3 0 3 3v14q0 3-3 3H13q-1.5 0-2.4-1.2z';
const TAG_16 = 'M3.5 16l7.1-8.8Q11.5 6 13 6h13q3 0 3 3v14q0 3-3 3H13q-1.5 0-2.4-1.2z M20 11.1a3.2 3.2 0 0 0-1.6 5.97l-1 4.93h5.2l-1-4.93A3.2 3.2 0 0 0 20 11.1z';
// "KEYHUNTER" in Archivo ExtraBold, width 125 %, 18 px, letter spacing 0.4, converted to outlined paths
// (the logo file asks for this) so that no Archivo font file is needed.
const WORDMARK = 'M41.53 27.5L41.53 15.13L45.18 15.13L45.18 21.13L51.92 15.13L56.56 15.13L50.89 20.23L56.69 27.5L52.13 27.5L48.19 22.44L45.18 24.85L45.18 27.5ZM59.05 27.5L59.05 15.13L71.94 15.13L71.94 17.83L62.72 17.83L62.72 19.92L70.8 19.92L70.8 22.55L62.72 22.55L62.72 24.78L72.1 24.78L72.1 27.5ZM79.88 27.5L79.88 22.57L73.76 15.13L78.1 15.13L81.71 19.76L81.88 19.76L85.51 15.13L89.67 15.13L83.55 22.57L83.55 27.5ZM91.91 27.5L91.91 15.13L95.56 15.13L95.56 19.74L102.99 19.74L102.99 15.13L106.65 15.13L106.65 27.5L102.99 27.5L102.99 22.68L95.56 22.68L95.56 27.5ZM117.29 27.72Q114.84 27.72 113.24 27Q111.64 26.28 110.85 24.93Q110.05 23.59 110.05 21.69L110.05 15.13L113.73 15.13L113.73 21.51Q113.73 23.16 114.65 24.07Q115.58 24.98 117.29 24.98Q119.02 24.98 119.94 24.07Q120.87 23.16 120.87 21.51L120.87 15.13L124.54 15.13L124.54 21.69Q124.54 23.59 123.75 24.93Q122.96 26.28 121.36 27Q119.76 27.72 117.29 27.72ZM127.93 27.5L127.93 15.13L131.21 15.13L137.62 20.89Q137.78 21.04 138.04 21.29Q138.3 21.54 138.58 21.82Q138.86 22.1 139.06 22.32L139.22 22.32Q139.22 21.99 139.21 21.51Q139.2 21.02 139.2 20.64L139.2 15.13L142.66 15.13L142.66 27.5L139.42 27.5L133.17 21.85Q132.74 21.47 132.26 21Q131.78 20.53 131.51 20.26L131.37 20.26Q131.37 20.5 131.38 21.02Q131.39 21.54 131.39 22.14L131.39 27.5ZM150.4 27.5L150.4 18.09L145.02 18.09L145.02 15.13L159.42 15.13L159.42 18.09L154.05 18.09L154.05 27.5ZM161.78 27.5L161.78 15.13L174.67 15.13L174.67 17.83L165.45 17.83L165.45 19.92L173.53 19.92L173.53 22.55L165.45 22.55L165.45 24.78L174.83 24.78L174.83 27.5ZM177.71 27.5L177.71 15.13L188.01 15.13Q189.34 15.13 190.23 15.68Q191.12 16.23 191.56 17.14Q192.01 18.05 192.01 19.13Q192.01 20.3 191.46 21.26Q190.91 22.23 189.79 22.78L192.31 27.5L188.17 27.5L186.14 23.38L181.37 23.38L181.37 27.5ZM181.37 20.68L186.8 20.68Q187.47 20.68 187.87 20.27Q188.26 19.87 188.26 19.24Q188.26 18.77 188.08 18.46Q187.9 18.16 187.58 18Q187.25 17.83 186.8 17.83L181.37 17.83Z';

function VisierMask({ id }: { id: string }) {
  return <mask id={id}>
    <rect width="32" height="32" fill="#fff" />
    <circle cx="20" cy="16" r="6.05" fill="none" stroke="#000" strokeWidth="1.6" strokeDasharray="6.9 2.6" strokeDashoffset="8.2" />
    <path d="M20 9.4v3M26.6 16h-3M13.4 16h3" stroke="#000" strokeWidth="1.3" />
    <path d="M20 12.9a2.1 2.1 0 0 0-.8 4.04l-.5 2.76h2.6l-.5-2.76A2.1 2.1 0 0 0 20 12.9z" fill="#000" />
  </mask>;
}
const useMaskId = () => 'visier-' + useId().replace(/[^a-zA-Z0-9]/g, '');

/** The key-hole price tag. Orange via CSS (`.key-mark`); `small` is only a size hint for old call sites. Decorative. */
export function KeyMark({ small = false, simple = false }: { small?: boolean; simple?: boolean }) {
  const id = useMaskId();
  return <svg className={small ? 'key-mark small' : 'key-mark'} viewBox="0 0 32 32" aria-hidden="true">
    {simple ? <path className="key-mark-fill" fillRule="evenodd" d={TAG_16} /> : <><defs><VisierMask id={id} /></defs><path className="key-mark-fill" mask={`url(#${id})`} d={TAG} /></>}
  </svg>;
}
/** Mark and wordmark as one horizontal logo. Give it a size with the CSS height (default 36 px). */
export function Brand({ label = 'KeyHunter' }: { label?: string }) {
  const id = useMaskId();
  return <svg className="brand" viewBox="0 0 196 40" role="img" aria-label={label}>
    <defs><VisierMask id={id} /></defs>
    <g transform="translate(0 4)"><path className="key-mark-fill" mask={`url(#${id})`} d={TAG} /></g>
    <path className="brand-word" d={WORDMARK} />
  </svg>;
}
