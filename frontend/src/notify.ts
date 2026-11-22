/**
 * Notifications (0.9.1): short messages after an action ("… pausiert", "Gespeichert", an error) appear as a popup at the bottom
 * right instead of a notice inside the page, so the layout never shifts. Any part of the app calls `notify`; the `Toaster`
 * in the app shell shows them. An empty message is ignored, so `notify` can replace a `setMessage` that also clears.
 */
export type NotifyTone = 'success' | 'error' | 'info';
export interface Notification { id: number; message: string; tone: NotifyTone }
export const NOTIFY = 'keyhunter:notify';
let next = 0;
export function notify(message: string, tone: NotifyTone = 'success') {
  if (!message) return;
  window.dispatchEvent(new CustomEvent<Notification>(NOTIFY, { detail: { id: ++next, message, tone } }));
}
/** The error of a failed action as a popup; `fallback` when the error has no message. */
export const notifyError = (error: unknown, fallback: string) => notify(error instanceof Error && error.message ? error.message : fallback, 'error');
