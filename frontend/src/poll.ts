import type { PriceBadgeData } from './api';

// Fast only while a fetch the owner triggered runs; a backlog of due checks (`pending` only) is the normal state (PERF-02).
export function badgePollDelay(badges: (Pick<PriceBadgeData, 'pending' | 'refreshing'> | null | undefined)[]): number {
  return badges.some(badge => badge?.refreshing) ? 3000 : 60000;
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
