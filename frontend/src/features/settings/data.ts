import { useCallback, useEffect, useState } from 'react';
import { api, FETCH_STATUS_CHANGED } from '../../api';
import type { FetchStatusResponse } from '../../api';
import { whenVisible } from '../../poll';

export const FETCH_REFRESH_MS = 30_000;

/**
 * GET /status/fetch: read once when the settings open; while `poll` is true (a section that shows it is open)
 * it is read again every 30 s, never while the tab is hidden. `reload` reads at once.
 * A failed read keeps the last data and sets `failed`.
 */
export function useFetchStatus(poll: boolean) {
  const [data, setData] = useState<FetchStatusResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let cancel = () => {};
    const load = () => {
      api<FetchStatusResponse>('/status/fetch', 'GET', undefined, undefined, controller.signal)
        .then(next => {
          if (!controller.signal.aborted) {
            setData(next);
            setFailed(false);
            setLoadedAt(Date.now());
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) setFailed(true);
        })
        .finally(() => {
          if (!controller.signal.aborted && poll) cancel = whenVisible(load, FETCH_REFRESH_MS);
        });
    };
    load();
    const reload = () => {
      cancel();
      load();
    };
    window.addEventListener(FETCH_STATUS_CHANGED, reload);
    return () => {
      controller.abort();
      cancel();
      window.removeEventListener(FETCH_STATUS_CHANGED, reload);
    };
  }, [poll, tick]);
  const reload = useCallback(() => setTick(n => n + 1), []);
  return { data, failed, loadedAt, reload };
}
