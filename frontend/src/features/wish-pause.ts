import type { WishlistItem } from '../api';

/**
 * Pause of one wish (0.9.0): its automatic checks wait until the end, or until resumed by hand. Independent of the global
 * pause of the fetch status: resuming that leaves a paused wish paused. A check asked for with "Jetzt prüfen" still runs.
 */
export const PAUSE_WEEKS = [1, 2, 4, 8] as const;
export const weeksText = (weeks: number) => (weeks === 1 ? '1 Woche' : `${weeks} Wochen`);
/** End of a pause of `weeks` weeks from now, in unix seconds. */
export const pauseEnd = (weeks: number, nowMs = Date.now()) => Math.floor(nowMs / 1000) + weeks * 7 * 86400;
const date = (seconds: number) => new Date(seconds * 1000).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
/** "Abfragen pausiert bis 06.12.2026" or "… bis du sie fortsetzt"; empty when the wish is not paused. */
export function pauseText(item: Pick<WishlistItem, 'paused' | 'paused_until'>): string {
  if (!item.paused) return '';
  return item.paused_until ? `Abfragen pausiert bis ${date(item.paused_until)}` : 'Abfragen pausiert, bis du sie fortsetzt';
}
