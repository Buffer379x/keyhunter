import test from 'node:test';
import assert from 'node:assert/strict';
import { badgePollDelay, whenVisible } from '../src/poll.ts';

// Minimal document stand-in: a visibility state and visibilitychange listeners.
const listeners = new Set<() => void>();
const doc = {
  visibilityState: 'visible',
  addEventListener: (_: string, f: () => void) => listeners.add(f),
  removeEventListener: (_: string, f: () => void) => listeners.delete(f),
};
Object.assign(globalThis, { document: doc, window: globalThis });
const show = (state: string) => {
  doc.visibilityState = state;
  for (const f of [...listeners]) f();
};
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('a visible tab polls on time', async () => {
  let runs = 0;
  whenVisible(() => runs++, 5);
  await wait(20);
  assert.equal(runs, 1);
});

test('a hidden tab waits and polls once when it is shown again', async () => {
  let runs = 0;
  doc.visibilityState = 'hidden';
  whenVisible(() => runs++, 5);
  await wait(20);
  assert.equal(runs, 0);
  show('visible');
  show('visible');
  assert.equal(runs, 1);
  assert.equal(listeners.size, 0);
});

test('cancel stops a pending poll, also while hidden', async () => {
  let runs = 0;
  doc.visibilityState = 'hidden';
  const cancel = whenVisible(() => runs++, 1);
  await wait(10);
  cancel();
  show('visible');
  assert.equal(runs, 0);
  assert.equal(listeners.size, 0);
});

test('badgePollDelay: only a fetch the owner triggered polls fast, a backlog waits 60 s (PERF-02)', () => {
  assert.equal(badgePollDelay([{ pending: true, refreshing: false }]), 60000);
  assert.equal(badgePollDelay([{ pending: true }]), 60000);
  assert.equal(badgePollDelay([{ pending: false, refreshing: false }, undefined, null]), 60000);
  assert.equal(badgePollDelay([]), 60000);
  assert.equal(
    badgePollDelay([
      { pending: true, refreshing: false },
      { pending: true, refreshing: true },
    ]),
    3000,
  );
});
