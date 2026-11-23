import { useCallback, useEffect, useRef, useState } from 'react';
import { api, sessionEnded } from '../api';
import { notify } from '../notify';
import type { PriceBadgeData } from '../api';
import { badgePollDelay, whenVisible } from '../poll';
import type { OffersView } from './offers-model';

/**
 * Loads GET /wishlist/{id}/offers and keeps it fresh: every 3 s while a fetch the owner triggered is pending
 * (`price_badge.refreshing`: "Jetzt prüfen", the first search of a new wish), every 60 s otherwise, only while the tab is visible.
 */
export function useOffersView(id: string, onBadge?: (id: string, badge: PriceBadgeData) => void) {
  const path = `/wishlist/${encodeURIComponent(id)}/offers`;
  const [view, setView] = useState<OffersView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const latest = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    const generation = ++latest.current;
    let cancel = () => {};
    async function load() {
      try {
        const data = await api<OffersView>(path, 'GET', undefined, controller.signal);
        if (controller.signal.aborted || generation !== latest.current) return;
        setView(data);
        if (data.price_badge) onBadge?.(id, data.price_badge as PriceBadgeData);
        setError('');
        cancel = whenVisible(() => void load(), badgePollDelay([data.price_badge]));
      } catch (e) {
        if (controller.signal.aborted) return;
        if (sessionEnded(e)) return;
        setError(e instanceof Error ? e.message : 'Angebote konnten nicht geladen werden.');
        cancel = whenVisible(() => void load(), 10000);
      }
    }
    void load();
    return () => {
      controller.abort();
      cancel();
    };
  }, [path, reload, onBadge, id]);
  const write = useCallback(
    async (endpoint: string, method: string, body: unknown, success = '') => {
      setBusy(true);
      // The result of a change is a popup (0.9.1); `error` stays the read error with its "Erneut laden".
      try {
        await api(path + endpoint, method, body);
        notify(success);
        setReload(n => n + 1);
        return true;
      } catch (e) {
        if (!sessionEnded(e)) notify(e instanceof Error ? e.message : 'Angebotsänderung fehlgeschlagen.', 'error');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [path],
  );
  const refetch = useCallback(() => setReload(n => n + 1), []);
  return { view, error, busy, write, refetch };
}
export type OffersState = ReturnType<typeof useOffersView>;
