import { useCallback, useEffect, useRef, useState } from 'react';
import { api, HttpError } from '../../api';
import type { Settings } from '../../api';
import { formatFeePercent, parseFeePercent } from '../../fees';

export type SaveState = 'saved' | 'pending' | 'saving' | 'error';
export const AUTOSAVE_DEBOUNCE_MS = 700;
const shopLabels: Record<string, string> = { eneba: 'Eneba', driffle: 'Driffle' };
const feeError = (id: string) => `${shopLabels[id] ?? id}: Gebühren bitte als Zahl von 0 bis 100 mit höchstens zwei Nachkommastellen eingeben.`;
const feeDrafts = (data: Settings) => Object.fromEntries(data.sources.map(source => [source.id, formatFeePercent(source.fee_basis_points)]));

/**
 * Settings that save themselves.
 * - edit(update): selects and switches, saved at once (next tick, so two changes in one event become one request).
 * - edit(update, true) and editFee(id, text): text and number input, saved 700 ms after the last key.
 * - settle(): save everything that is open now and wait for it. Call it before leaving the page or signing out.
 * - A change made while a request is running is never lost: it is sent right after the running one.
 * - The server answer replaces the draft only if nothing was edited in the meantime.
 * `saved` is the last state the server confirmed; other pages (target country, price scope) read it.
 */
export function useSettingsAutosave({ csrf, onSaved, onProtectedError }: {
  csrf: string; onSaved: (saved: Settings) => void; onProtectedError: (error: unknown) => void;
}) {
  const [settings, setSettingsState] = useState<Settings | null>(null);
  const [saved, setSaved] = useState<Settings | null>(null);
  const [feeDraft, setFeeDraft] = useState<Record<string, string>>({});
  const [state, setState] = useState<SaveState>('saved');
  const [error, setError] = useState('');
  const [retryable, setRetryable] = useState(true);
  const draft = useRef<Settings | null>(null);
  const fees = useRef<Record<string, string>>({});
  const version = useRef(0);
  const savedVersion = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const running = useRef<Promise<void> | null>(null);
  const again = useRef(false);
  const latest = useRef({ csrf, onSaved, onProtectedError });
  latest.current = { csrf, onSaved, onProtectedError };

  const adopt = useCallback((data: Settings) => {
    draft.current = data; fees.current = feeDrafts(data);
    setSettingsState(data); setFeeDraft(fees.current); setSaved(data);
  }, []);
  /** Take the server state as it is (after sign-in, or after adding or removing a shop). Drops unsent edits. */
  const reset = useCallback((data: Settings) => {
    window.clearTimeout(timer.current); timer.current = undefined;
    version.current = savedVersion.current = 0;
    adopt(data); setState('saved'); setError('');
  }, [adopt]);

  /** Sends the draft once. Returns false when saving failed or cannot start. */
  const once = useCallback(async (): Promise<boolean> => {
    const snapshot = draft.current;
    if (!snapshot) return true;
    const sentVersion = version.current;
    if (sentVersion === savedVersion.current) return true;
    const sources = [];
    for (const source of snapshot.sources) {
      const value = source.kind === 'shop' && source.enabled && source.fee_estimation_enabled
        ? parseFeePercent(fees.current[source.id] ?? '') : source.fee_basis_points;
      if (value === null) { setError(feeError(source.id)); setRetryable(false); setState('error'); return false; }
      sources.push({ ...source, fee_basis_points: value });
    }
    setState('saving'); setError('');
    try {
      const result = await api<Settings>('/settings', 'PUT', { ...snapshot, sources }, latest.current.csrf);
      savedVersion.current = sentVersion;
      setSaved(result);
      if (version.current === sentVersion) {
        draft.current = result; fees.current = feeDrafts(result);
        setSettingsState(result); setFeeDraft(fees.current); setState('saved');
      } else setState('pending');
      latest.current.onSaved(result);
      return true;
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) latest.current.onProtectedError(e);
      setError(e instanceof Error ? e.message : 'Einstellungen konnten nicht gespeichert werden.'); setRetryable(true); setState('error');
      return false;
    }
  }, []);

  const run = useCallback((): Promise<void> => {
    if (running.current) { again.current = true; return running.current; }
    const job = (async () => {
      try {
        do { again.current = false; if (!await once()) break; } while (again.current);
      } finally { running.current = null; }
    })();
    running.current = job;
    return job;
  }, [once]);

  const schedule = useCallback((ms: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { timer.current = undefined; void run(); }, ms);
  }, [run]);
  const touch = useCallback((wait: boolean) => { version.current += 1; setState('pending'); setError(''); schedule(wait ? AUTOSAVE_DEBOUNCE_MS : 0); }, [schedule]);

  const edit = useCallback((update: (current: Settings) => Settings, wait = false) => {
    if (!draft.current) return;
    draft.current = update(draft.current);
    setSettingsState(draft.current);
    touch(wait);
  }, [touch]);
  const editFee = useCallback((id: string, text: string) => {
    fees.current = { ...fees.current, [id]: text };
    setFeeDraft(fees.current);
    touch(true);
  }, [touch]);
  const settle = useCallback(async () => {
    window.clearTimeout(timer.current); timer.current = undefined;
    await run();
  }, [run]);
  const retry = useCallback(() => { void settle(); }, [settle]);
  const dirty = state !== 'saved';

  // Warn when the tab is closed with unsaved changes, and start saving.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); void settle(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, settle]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  return { settings, saved, feeDraft, state, error, retryable, dirty, edit, editFee, settle, retry, reset };
}

export type Autosave = ReturnType<typeof useSettingsAutosave>;
