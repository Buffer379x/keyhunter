import { useCallback, useEffect, useRef, useState } from 'react';
import { api, HttpError } from '../api';
import type { PriceBadgeData } from '../api';
import { whenVisible } from '../poll';
import type { OffersView } from './offers-model';

/** Loads GET /wishlist/{id}/offers and keeps it fresh (3 s while a search runs, 60 s otherwise, only while the tab is visible). */
export function useOffersView(id: string, csrf: string, onError: (error: unknown) => void, onBadge?: (id: string, badge: PriceBadgeData) => void) {
  const path = `/wishlist/${encodeURIComponent(id)}/offers`;
  const [view, setView] = useState<OffersView | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const latest = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    const generation = ++latest.current;
    let cancel = () => {};
    async function load() {
      try {
        const data = await api<OffersView>(path, 'GET', undefined, undefined, controller.signal);
        if (controller.signal.aborted || generation !== latest.current) return;
        setView(data);
        if (data.price_badge) onBadge?.(id, data.price_badge as PriceBadgeData);
        setError('');
        const pending = data.searches?.some(search => ['queued', 'searching'].includes(search.status)) || data.discovery_running || data.links.some(link => link.queued && link.review !== 'rejected');
        cancel = whenVisible(() => void load(), pending ? 3000 : 60000);
      } catch (e) {
        if (controller.signal.aborted) return;
        if (e instanceof HttpError && e.status === 401) { onError(e); return; }
        setError(e instanceof Error ? e.message : 'Angebote konnten nicht geladen werden.');
        cancel = whenVisible(() => void load(), 10000);
      }
    }
    void load();
    return () => { controller.abort(); cancel(); };
  }, [path, reload, onError, onBadge, id]);
  const write = useCallback(async (endpoint: string, method: string, body: unknown, success = '') => {
    setBusy(true); setError(''); setMessage('');
    try { await api(path + endpoint, method, body, csrf); setMessage(success); setReload(n => n + 1); return true; }
    catch (e) { setError(e instanceof Error ? e.message : 'Angebotsänderung fehlgeschlagen.'); if (e instanceof HttpError && e.status === 401) onError(e); return false; }
    finally { setBusy(false); }
  }, [path, csrf, onError]);
  const refetch = useCallback(() => setReload(n => n + 1), []);
  return { view, error, message, busy, write, refetch };
}
export type OffersState = ReturnType<typeof useOffersView>;
