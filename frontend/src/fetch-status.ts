import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { api, FETCH_STATUS_CHANGED } from './api';
import type { FetchStatusResponse } from './api';
import { whenVisible } from './poll';

/** Polling of GET /status/fetch: every 60 s, every 30 s while a settings section that shows it is open. */
const FETCH_REFRESH_MS = 60_000;
const FETCH_FAST_MS = 30_000;

type FetchStatusState = {
  data: FetchStatusResponse | null;
  /** The last read failed; `data` keeps the last answer. */
  failed: boolean;
  /** Time of the last successful read (ms). */
  loadedAt: number | null;
};

/**
 * One poller for the whole app (CODE-08, PERF-06): the sidebar card, the "Abrufe heute" tile and the settings share it.
 * It reads while at least one component uses it, never while the tab is hidden, at once when a component mounts or
 * asks for fast polling, and after FETCH_STATUS_CHANGED (pause, resume).
 */
let state: FetchStatusState = { data: null, failed: false, loadedAt: null };
const listeners = new Set<() => void>();
let fast = 0;
let controller: AbortController | null = null;
let cancel = () => {};

function publish(next: FetchStatusState) {
  state = next;
  for (const listener of listeners) listener();
}

function load() {
  cancel();
  controller?.abort();
  const current = new AbortController();
  controller = current;
  api<FetchStatusResponse>('/status/fetch', 'GET', undefined, current.signal)
    .then(data => {
      if (!current.signal.aborted) publish({ data, failed: false, loadedAt: Date.now() });
    })
    .catch(() => {
      if (!current.signal.aborted) publish({ ...state, failed: true });
    })
    .finally(() => {
      if (current.signal.aborted) return;
      controller = null;
      if (listeners.size) cancel = whenVisible(load, fast ? FETCH_FAST_MS : FETCH_REFRESH_MS);
    });
}

/** Reads at once, unless a read is already on its way. */
function refresh() {
  if (!controller) load();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    cancel();
    controller?.abort();
    controller = null;
  };
}

if (typeof window !== 'undefined')
  window.addEventListener(FETCH_STATUS_CHANGED, () => {
    if (listeners.size) load();
  });

/** The shared fetch status; `fastPolling` while a section that shows it is open. `reload` reads at once. */
export function useFetchStatus(fastPolling = false) {
  const current = useSyncExternalStore(subscribe, () => state);
  useEffect(() => {
    if (fastPolling) fast += 1;
    refresh();
    return () => {
      if (fastPolling) fast -= 1;
    };
  }, [fastPolling]);
  const reload = useCallback(() => load(), []);
  return { ...current, reload };
}
