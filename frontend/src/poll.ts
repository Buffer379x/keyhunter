import type { PriceBadgeData } from './api';

/** Prices and badges are read again once a minute, every 3 s while a fetch the owner asked for runs. */
export const BADGE_POLL_MS = 60_000;
export const FAST_POLL_MS = 3000;
type Badge = Pick<PriceBadgeData, 'pending' | 'refreshing'> | null | undefined;
// Fast only while a fetch the owner triggered runs; a backlog of due checks (`pending` only) is the normal state (PERF-02).
export const refreshing = (badges: Badge[]) => badges.some(badge => badge?.refreshing);
export function badgePollDelay(badges: Badge[]): number {
  return refreshing(badges) ? FAST_POLL_MS : BADGE_POLL_MS;
}

// Run `task` after `ms`, but not while the tab is hidden: a hidden tab waits until it is shown
// again and then runs the task at once. The returned function cancels it.
export function whenVisible(task: () => void, ms: number): () => void {
  let done = false;
  const onShow = () => {
    if (document.visibilityState === 'hidden') return;
    document.removeEventListener('visibilitychange', onShow);
    run();
  };
  const run = () => {
    if (done) return;
    if (document.visibilityState === 'hidden') {
      document.addEventListener('visibilitychange', onShow);
      return;
    }
    done = true;
    task();
  };
  const timer = window.setTimeout(run, ms);
  return () => {
    done = true;
    window.clearTimeout(timer);
    document.removeEventListener('visibilitychange', onShow);
  };
}
