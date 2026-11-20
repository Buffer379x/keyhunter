import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Icon } from './Icon';
import type { IconName } from './Icon';

/** Filter chip (`.chip`): a toggle button with aria-pressed and an optional mono count ("Alle 12"). */
export function Chip({ pressed, count, className = '', children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  pressed: boolean; count?: number | null; children: ReactNode;
}) {
  return <button type="button" className={`chip ${className}`.trim()} aria-pressed={pressed} {...props}>
    {children}{count !== undefined && count !== null && <span className="mono">{count}</span>}
  </button>;
}

export type PillTone = 'default' | 'ok' | 'warn' | 'hot' | 'dim' | 'danger';
/**
 * Status pill (`.pill`, 22 px): icon plus text, never colour alone.
 * tone: ok (green, "in DE aktivierbar", "Ziel erreicht" as a state), warn (amber, unclear), hot (orange, your target),
 * dim (grey, inactive or waiting), danger (red, failed), default (neutral outline).
 */
export function Pill({ tone = 'default', icon, className = '', children }: { tone?: PillTone; icon?: IconName; className?: string; children: ReactNode }) {
  return <span className={`pill${tone === 'default' ? '' : ` ${tone}`} ${className}`.trim()}>{icon && <Icon name={icon} size={12} />}{children}</span>;
}

/** Region code badge (`.reg`): "DE", "IN", "GL". `home` marks the target country (orange). Replaces flag images. */
export function Reg({ code, home = false, title }: { code: string; home?: boolean; title?: string }) {
  return <span className={home ? 'reg home' : 'reg'} title={title}>{code.toUpperCase()}</span>;
}
