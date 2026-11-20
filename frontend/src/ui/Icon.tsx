// Line icons, 24 px grid, stroke 1.8, drawn as one path each. Decorative: always pair with text or an aria-label on the control.
const paths: Record<string, string> = {
  home: 'm3 10 9-7 9 7v11H3V10Zm6 11v-7h6v7',
  library: 'M5 4h3v16H5zM10 4h3v16h-3zM15.5 4.5l2.9-.8 3.6 15.4-2.9.7z',
  heart: 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l1.5 2H4.5zM10 20a2 2 0 0 0 4 0',
  settings: 'M4 7h10M18 7h2M4 17h4M12 17h8M14 7a2 2 0 1 0 4 0 2 2 0 1 0-4 0M8 17a2 2 0 1 0 4 0 2 2 0 1 0-4 0',
  search: 'M4.5 11a6.5 6.5 0 1 0 13 0 6.5 6.5 0 1 0-13 0M16 16l4 4',
  close: 'm6 6 12 12M6 18 18 6',
  game: 'M7 6h10c5 0 7 13 4 13-2 0-3-4-5-4H8c-2 0-3 4-5 4C0 19 2 6 7 6ZM5 10h6m-3-3v6m7-3h.1m3 2h.1',
  tag: 'm3 3 9 0 9 9-9 9-9-9V3Zm5 5h.1',
  layers: 'm12 3 10 6-10 6L2 9l10-6Zm-10 11 10 6 10-6M2 18l10 6 10-6',
  globe: 'M22 12A10 10 0 1 1 2 12a10 10 0 0 1 20 0ZM2 12h20M12 2c-6 5-6 15 0 20 6-5 6-15 0-20Z',
  chart: 'M3 3v18h18M6 16l5-5 4 2 5-8',
  info: 'M22 12A10 10 0 1 1 2 12a10 10 0 0 1 20 0ZM12 11v6m0-10v.1',
  plus: 'M12 4v16M4 12h16',
  arrow: 'M9 5l7 7-7 7',
  external: 'M14 3h7v7m0-7L10 14M10 3H3v18h18v-7',
  refresh: 'M21 10a9 9 0 0 0-16-5L2 8m0-5v5h5M3 14a9 9 0 0 0 16 5l3-3m0 5v-5h-5',
  logout: 'M9 3H3v18h6M9 12h13m-5-5 5 5-5 5',
  download: 'M12 3v12m-5-5 5 5 5-5M3 16v5h18v-5',
  check: 'm5 12.5 4.5 4.5L19 7.5',
  clock: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 7v5l3 2',
  target: 'M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0ZM12 2v5m0 10v5M2 12h5m10 0h5',
  alert: 'M12 4 2.5 20h19L12 4ZM12 10v5m0 3v.1',
  cross: 'M6 6l12 12M18 6 6 18',
  minus: 'M6 12h12',
  tabs: 'M4 8h16M4 16h16',
};
/** `name` picks a path from the set above (unknown names show the info icon); `size` is in px. */
export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name] ?? paths.info} /></svg>;
}
