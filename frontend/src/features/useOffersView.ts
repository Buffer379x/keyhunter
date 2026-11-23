import { useCallback, useState } from 'react';
import { api, sessionEnded } from '../api';
import { notify } from '../notify';
import type { PriceBadgeData } from '../api';
import { BADGE_POLL_MS, refreshing } from '../poll';
import { usePolled } from '../usePolled';
import type { OffersView } from './offers-model';

/**
 * Loads GET /wishlist/{id}/offers and keeps it fresh: every 3 s while a fetch the owner triggered is pending
 * (`price_badge.refreshing`: "Jetzt prüfen", the first search of a new wish), every 60 s otherwise, only while the tab is visible.
 */
export function useOffersView(id: string, onBadge?: (id: string, badge: PriceBadgeData) => void) {
  const path = `/wishlist/${encodeURIComponent(id)}/offers`;
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const view = usePolled<OffersView>(path, {
    every: BADGE_POLL_MS,
    fastWhen: data => refreshing([data.price_badge]),
    retry: 10_000,
    restart: [reload],
    onData: data => {
      if (data.price_badge) onBadge?.(id, data.price_badge as PriceBadgeData);
      setError('');
    },
    onError: e => {
      if (!sessionEnded(e)) setError(e instanceof Error ? e.message : 'Angebote konnten nicht geladen werden.');
    },
  });
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
