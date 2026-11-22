import { useCallback, useEffect, useRef, useState } from 'react';
import { NOTIFY } from '../notify';
import type { Notification } from '../notify';
import { Icon } from './Icon';
import { IconButton } from './Button';

const SHOWN = 4;
const DURATION = { success: 4500, info: 4500, error: 9000 } as const;

/**
 * Popups at the bottom right (0.9.1), newest at the bottom, at most four. Each closes by itself (errors stay longer), with its
 * button, or with Escape while it has the focus; hovering keeps it open. Successes are announced politely, errors at once.
 */
export function Toaster() {
  const [items, setItems] = useState<Notification[]>([]);
  const timers = useRef(new Map<number, number>());
  const close = useCallback((id: number) => {
    window.clearTimeout(timers.current.get(id)); timers.current.delete(id);
    setItems(current => current.filter(item => item.id !== id));
  }, []);
  const schedule = useCallback((item: Notification) => {
    window.clearTimeout(timers.current.get(item.id));
    timers.current.set(item.id, window.setTimeout(() => close(item.id), DURATION[item.tone]));
  }, [close]);
  useEffect(() => {
    const add = (event: Event) => {
      const item = (event as CustomEvent<Notification>).detail;
      // The same text again restarts its popup instead of stacking a copy.
      setItems(current => [...current.filter(other => other.message !== item.message), item].slice(-SHOWN));
      schedule(item);
    };
    window.addEventListener(NOTIFY, add);
    const all = timers.current;
    return () => { window.removeEventListener(NOTIFY, add); all.forEach(timer => window.clearTimeout(timer)); };
  }, [schedule]);
  return <div className="toaster" aria-label="Meldungen">
    <div role="status" aria-live="polite" className="toaster-list">{items.filter(i => i.tone !== 'error').map(item => <Toast key={item.id} item={item} close={close} hold={() => window.clearTimeout(timers.current.get(item.id))} resume={() => schedule(item)} />)}</div>
    <div role="alert" className="toaster-list">{items.filter(i => i.tone === 'error').map(item => <Toast key={item.id} item={item} close={close} hold={() => window.clearTimeout(timers.current.get(item.id))} resume={() => schedule(item)} />)}</div>
  </div>;
}

function Toast({ item, close, hold, resume }: { item: Notification; close: (id: number) => void; hold: () => void; resume: () => void }) {
  return <div className={`toast-pop ${item.tone}`} onMouseEnter={hold} onMouseLeave={resume} onKeyDown={event => { if (event.key === 'Escape') close(item.id); }}>
    <Icon name={item.tone === 'error' ? 'alert' : item.tone === 'info' ? 'info' : 'check'} />
    <span className="toast-text">{item.message}</span>
    <IconButton variant="ghost" label="Meldung schließen" onClick={() => close(item.id)}><Icon name="x" /></IconButton>
  </div>;
}
