import { sessionEnded } from './api';

/**
 * Notifications (0.9.1): short messages after an action ("… pausiert", "Gespeichert", an error) appear as a popup at the bottom
 * right instead of a notice inside the page, so the layout never shifts. Any part of the app calls `notify`; the `Toaster`
 * in the app shell shows them. An empty message is ignored.
 */
export type NotifyTone = 'success' | 'error' | 'info';
export interface Notification {
  id: number;
  message: string;
  tone: NotifyTone;
}
export const NOTIFY = 'keyhunter:notify';
let next = 0;
export function notify(message: string, tone: NotifyTone = 'success') {
  if (!message) return;
  window.dispatchEvent(new CustomEvent<Notification>(NOTIFY, { detail: { id: ++next, message, tone } }));
}
/**
 * A failed request as an error popup. A 401 shows none: the session ended and the shell shows the sign-in (`onSessionEnd`).
 */
export function notifyError(error: unknown) {
  if (sessionEnded(error)) return;
  notify(error instanceof Error ? error.message : 'Ein Fehler ist aufgetreten.', 'error');
}
