import type { ReactNode } from 'react';
import { Icon } from './Icon';

export type ChipKind = 'best' | 'valid' | 'target' | 'warn' | 'stale' | 'neutral' | 'danger';
const icons: Record<ChipKind, string> = { best: 'check', valid: 'check', target: 'target', warn: 'alert', stale: 'clock', neutral: 'minus', danger: 'cross' };
const defaults: Partial<Record<ChipKind, string>> = { best: 'Bestpreis', valid: 'Gültig', target: 'Ziel erreicht', warn: 'Prüfen', stale: 'Veraltet', danger: 'Fehler' };

/**
 * Chip with an icon and a text, never colour alone (price status vocabulary, spec section 6).
 * kind: best (teal, best valid offer), valid (teal outline, "in DE aktivierbar"), target (orange, "Ziel erreicht"),
 * warn (amber, "Zuordnung prüfen"), stale (grey, "Veraltet · vor 2 T"), neutral (grey outline, "Nicht in DE"),
 * danger (red, "Abruf fehlgeschlagen"). `icon` overrides the icon of the kind.
 */
export function Chip({ kind = 'neutral', icon, children }: { kind?: ChipKind; icon?: string; children: ReactNode }) {
  return <span className={`ui-chip ${kind}`}><Icon name={icon ?? icons[kind]} size={13} />{children}</span>;
}
/** Chip whose text defaults to the standard label of its kind (not for neutral: give it a text). */
export function StatusChip({ kind, children }: { kind: ChipKind; children?: ReactNode }) {
  return <Chip kind={kind}>{children ?? defaults[kind] ?? ''}</Chip>;
}
