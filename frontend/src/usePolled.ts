import { useEffect, useRef, useState } from 'react';
import { api, sessionEnded } from './api';
import { FAST_POLL_MS, whenVisible } from './poll';

interface PollOptions<T> {
  /** Read again this many ms after an answer; without it only while `fastWhen` holds. */
  every?: number;
  /** Read again after `fast` ms (default 3 s) while this holds for the last answer, e.g. a fetch the owner asked for runs (PERF-02). */
  fastWhen?: (data: T) => boolean;
  fast?: number;
  /** After a failed read, try again this many ms later (none without it; never after a 401). */
  retry?: number;
  /** Delay of the first read in ms, asked at each start (default: at once). */
  wait?: () => number;
  /** The first request of each start, e.g. a POST that starts preparing; the later reads are GETs. */
  start?: { method: string; body?: unknown };
  /** Values beside the path that start the reads anew when they change. */
  restart?: readonly unknown[];
  onData?: (data: T) => void;
  onError?: (error: unknown) => void;
}

/**
 * Reads `path` (null: nothing) and keeps it fresh: aborted when the path or a `restart` value changes and on unmount,
 * never while the tab is hidden (`whenVisible`). Returns the last answer, kept while a new start reads.
 * The options are read at each request, so callbacks need not be stable.
 */
export function usePolled<T>(path: string | null, options: PollOptions<T> = {}): T | null {
  const [data, setData] = useState<T | null>(null);
  const latest = useRef(options);
  latest.current = options;
  const restart = options.restart ?? [];
  useEffect(() => {
    if (path === null) return;
    const controller = new AbortController();
    let cancel = () => {};
    async function read(first: boolean) {
      const { start, every, fastWhen, fast = FAST_POLL_MS, retry, onData, onError } = latest.current;
      let next: number | undefined;
      try {
        const answer =
          first && start ? await api<T>(path!, start.method, start.body, controller.signal) : await api<T>(path!, 'GET', undefined, controller.signal);
        if (controller.signal.aborted) return;
        setData(answer);
        onData?.(answer);
        next = fastWhen?.(answer) ? fast : every;
      } catch (error) {
        if (controller.signal.aborted) return;
        onError?.(error);
        next = sessionEnded(error) ? undefined : retry;
      }
      if (next !== undefined) cancel = whenVisible(() => void read(false), next);
    }
    const wait = latest.current.wait?.() ?? 0;
    if (wait) cancel = whenVisible(() => void read(true), wait);
    else void read(true);
    return () => {
      controller.abort();
      cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `restart` lists what starts the reads anew; everything else is read through `latest`
  }, [path, ...restart]);
  return data;
}
