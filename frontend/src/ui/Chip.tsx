import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Icon } from './Icon';
import type { IconName } from './Icon';

/** Filter chip (`.chip`): a toggle button with aria-pressed and an optional mono count ("Alle 12"). */
export function Chip({
  pressed,
  count,
  className = '',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  pressed: boolean;
  count?: number | null;
  children: ReactNode;
}) {
  return (
    <button type="button" className={`chip ${className}`.trim()} aria-pressed={pressed} {...props}>
      {children}
      {count !== undefined && count !== null && <span className="mono">{count}</span>}
    </button>
  );
}

export type PillTone = 'default' | 'ok' | 'warn' | 'hot' | 'dim' | 'danger';
/**
 * Status pill (`.pill`, 22 px): icon plus text, never colour alone.
 * tone: ok (green, "in DE aktivierbar", "Ziel erreicht" as a state), warn (amber, unclear), hot (orange, your target),
 * dim (grey, inactive or waiting), danger (red, failed), default (neutral outline).
 */
export function Pill({ tone = 'default', icon, className = '', children }: { tone?: PillTone; icon?: IconName; className?: string; children: ReactNode }) {
  return (
    <span className={`pill${tone === 'default' ? '' : ` ${tone}`} ${className}`.trim()}>
      {icon && <Icon name={icon} size={12} />}
      {children}
    </span>
  );
}

// Flag images (flag-icons, 4:3), emitted as separate files so the bundle stays small and the CSP needs no data: URLs.
const flags = import.meta.glob<string>('/node_modules/flag-icons/flags/4x3/*.svg', { eager: true, query: '?url&no-inline', import: 'default' });
const flagUrl = (code: string) => flags[`/node_modules/flag-icons/flags/4x3/${code.toLowerCase()}.svg`];
const areas: Record<string, string> = { GL: 'Global', NA: 'Nordamerika', ROW: 'Rest der Welt', LATAM: 'Lateinamerika' };
let regionNames: Intl.DisplayNames | null = null;
/** German name of a region code: "Indien", "Europa", "Global". */
function regName(code: string): string {
  const upper = code.toUpperCase();
  if (upper === 'EU') return 'Europa';
  if (areas[upper]) return areas[upper];
  if (/^[A-Z]{2}$/.test(upper)) {
    try {
      regionNames ??= new Intl.DisplayNames(['de'], { type: 'region' });
      return regionNames.of(upper) ?? upper;
    } catch {
      return upper;
    }
  }
  return code;
}

/**
 * Region badge (`.reg`): the country flag ("DE", "IN", "EU"), a globe for areas without a flag (GL, NA, ROW, LATAM),
 * the code as text when nothing fits. `home` marks the target country with an orange ring. Screen readers get the
 * country name, unless `decorative` is set because the name is written right next to it.
 */
export function Reg({ code, home = false, title, decorative = false }: { code: string; home?: boolean; title?: string; decorative?: boolean }) {
  const upper = code.toUpperCase();
  const name = regName(upper);
  // Areas first: "GL" (Global) and "NA" (Nordamerika) are also the ISO codes of Greenland and Namibia.
  const url = !areas[upper] && /^[A-Z]{2}$/.test(upper) ? flagUrl(upper) : undefined;
  const label = decorative ? { 'aria-hidden': true as const } : { role: 'img', 'aria-label': name };
  const className = `reg${url ? ' flag' : areas[upper] ? ' area' : ''}${home ? ' home' : ''}`;
  return (
    <span className={className} title={title ?? name} data-code={upper} {...label}>
      {url ? <img src={url} alt="" /> : areas[upper] ? <Icon name="globe" size={12} /> : upper}
    </span>
  );
}
