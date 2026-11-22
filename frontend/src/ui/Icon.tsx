import type { ReactNode } from 'react';

// Line icons from the design v4 prototype: 24 px grid, stroke 1.7, round caps and joins.
// Decorative: always pair with text or an aria-label on the control.
const shapes = {
  heart: <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" />,
  library: <path d="M5 4v16M9 4v16M13 5l4 15M19 19l-4-15" />,
  bell: <><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" /><path d="M10 20a2 2 0 0 0 4 0" /></>,
  sliders: <><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></>,
  activity: <path d="M3 12h4l3-7 4 14 3-7h4" />,
  store: <><path d="M4 9l1.5-5h13L20 9M4 9v11h16V9M4 9h16" /><path d="M9 20v-6h6v6" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4-4" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  chev: <path d="M9 6l6 6-6 6" />,
  back: <path d="M15 6l-6 6 6 6" />,
  down: <path d="M6 9l6 6 6-6" />,
  more: <><circle cx="6" cy="12" r="1.3" /><circle cx="12" cy="12" r="1.3" /><circle cx="18" cy="12" r="1.3" /></>,
  ext: <path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.5" /></>,
  alert: <><path d="M12 4l9 16H3z" /><path d="M12 10v4M12 17v.5" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" /></>,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  play: <path d="M8 5.5v13l11-6.5z" />,
  pause: <path d="M9 5.5v13M15 5.5v13" />,
  tiles: <><rect x="4" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" /></>,
  rows: <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.5M4.5 12h.5M4.5 18h.5" />,
  grip: <><circle cx="9" cy="6" r="1" /><circle cx="15" cy="6" r="1" /><circle cx="9" cy="12" r="1" /><circle cx="15" cy="12" r="1" /><circle cx="9" cy="18" r="1" /><circle cx="15" cy="18" r="1" /></>,
  download: <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />,
  cart: <><path d="M3 4h2.5l2.2 10.5h10.6L20.5 7H6.6" /><circle cx="9.5" cy="19" r="1.4" /><circle cx="17" cy="19" r="1.4" /></>,
  logout: <path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10" />,
  target: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /></>,
  bag: <><path d="M5 8h14l-1 12H6z" /><path d="M9 8V6a3 3 0 0 1 6 0v2" /></>,
  refresh: <path d="M20 11a8 8 0 0 0-14.5-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.5 4.5L20 16M20 20v-4h-4" />,
  // Added in the same style for screens the prototype does not show.
  up: <path d="M6 15l6-6 6 6" />,
  details: <><rect x="4" y="4" width="16" height="16" rx="2.5" /><path d="M8 9h8M8 12.5h8M8 16h5" /></>,
  trash: <><path d="M4 7h16M10 11v6M14 11v6" /><path d="M6 7l1 13h10l1-13M9 7V4h6v3" /></>,
  lock: <><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>,
  unlock: <><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 7.6-1.8" /></>,
  undo: <><path d="M9 14L4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  minus: <path d="M6 12h12" />,
  layers: <path d="M12 4l9 5-9 5-9-5zM3 14l9 5 9-5" />,
  chart: <path d="M4 4v16h16M7 15l4-4 3 2 5-6" />,
  book: <><path d="M5 5a2 2 0 0 1 2-2h12v15H7a2 2 0 0 0-2 2z" /><path d="M5 20a2 2 0 0 0 2 2h12v-4" /></>,
  send: <path d="M20 4L3 11l7 3 3 7zM10 14l10-10" />,
  shield: <><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" /><path d="M9 12l2 2 4-4" /></>,
  // 0.8.3: the help symbol, the settings button in the sidebar and the log tab.
  help: <><circle cx="12" cy="12" r="9" /><path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.4c-.6.3-1 .8-1 1.5v.4M12 16.8v.4" /></>,
  settings: <><path d="M10.3 3.5h3.4l.5 2.4 1.7 1 2.3-.8 1.7 2.9-1.8 1.6v2l1.8 1.6-1.7 2.9-2.3-.8-1.7 1-.5 2.4h-3.4l-.5-2.4-1.7-1-2.3.8-1.7-2.9 1.8-1.6v-2L4.1 9l1.7-2.9 2.3.8 1.7-1z" /><circle cx="12" cy="12" r="2.6" /></>,
  log: <><path d="M6 3h9l4 4v14H6z" /><path d="M14 3v5h5M9 12h7M9 15.5h7M9 19h4" /></>,
  // 0.9.1: to the first and the last page, a chevron against a bar ("|<", ">|").
  first: <path d="M7 6v12M17 6l-6 6 6 6" />,
  last: <path d="M17 6v12M7 6l6 6-6 6" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof shapes;

/** `name` picks a shape from the set above; `size` is in px (default 16, CSS may override it). */
export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{shapes[name]}</svg>;
}
