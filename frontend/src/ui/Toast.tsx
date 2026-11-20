import { useEffect } from 'react';

/**
 * Toast (`.toast`): a short confirmation at the bottom centre, e.g. "Zielland: Österreich". Polite live region.
 * Controlled: render it with a `message` (empty hides it); `onDone` runs after `duration` ms so the caller can clear it.
 * A new message restarts the timer.
 */
export function Toast({ message, onDone, duration = 2600 }: { message: string; onDone: () => void; duration?: number }) {
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(onDone, duration);
    return () => window.clearTimeout(timer);
  }, [message, onDone, duration]);
  return <div className="toast" role="status" hidden={!message}>{message}</div>;
}
