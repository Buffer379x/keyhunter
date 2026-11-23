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

type ReviewFacts = Pick<WishlistItem, 'review_count' | 'verification'>;
const countText = (count: number) => (count === 1 ? '1 ungeprüfte Zuordnung' : `${count} ungeprüfte Zuordnungen`);
/** Why a wish carries the warning symbol (0.9.1): mappings to review under Zuordnungen, or a catalog choice that is not confirmed. */
function reviewText(item: ReviewFacts): string {
  const parts: string[] = [];
  const count = item.review_count ?? 0;
  if (count > 0) parts.push(countText(count));
  // A manual title has no catalog entry by choice; only a catalog choice that no longer matches is a task.
  if (item.verification === 'needs_review') parts.push('Katalogzuordnung prüfen');
  return parts.join(' · ');
}
/** Accessible name of the warning button (1.1, PROD-03), which opens the Zuordnungen tab: "2 ungeprüfte Zuordnungen von Halo prüfen". */
export function reviewAction(item: ReviewFacts, title: string): string {
  const count = item.review_count ?? 0;
  const what = [count > 0 ? countText(count) : '', item.verification === 'needs_review' ? 'Katalogzuordnung' : ''].filter(Boolean).join(' und ');
  return `${what} von ${title} prüfen`;
}

interface WishFlag {
  kind: 'cart' | 'paused' | 'review';
  /** Accessible name. */
  label: string;
  /** Tooltip. */
  title: string;
}
/**
 * The symbols behind a wish's title (1.0.1, one list for the wishlist row and the cart): the basket when it lies in the cart
 * (`showCart`; the cart itself leaves it out), the pause with its end, the warning for mappings to review.
 */
export function wishFlags(item: Pick<WishlistItem, 'in_cart' | 'paused' | 'paused_until' | 'review_count' | 'verification'>, showCart: boolean): WishFlag[] {
  const flags: WishFlag[] = [];
  if (showCart && item.in_cart) flags.push({ kind: 'cart', label: 'im Warenkorb', title: 'Liegt im Warenkorb' });
  if (item.paused) flags.push({ kind: 'paused', label: pauseText(item), title: pauseText(item) });
  const review = reviewText(item);
  if (review) flags.push({ kind: 'review', label: review, title: `${review} · unter Zuordnungen` });
  return flags;
}
