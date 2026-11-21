import { useCallback, useEffect, useRef, useState } from 'react';
import { api, HttpError } from '../../api';
import type { Settings } from '../../api';
import { formatFeePercent, parseFeePercent } from '../../fees';

export type SaveState = 'clean' | 'dirty' | 'saving' | 'error';
const shopLabels: Record<string, string> = { eneba: 'Eneba', driffle: 'Driffle' };
const feeError = (id: string) => `${shopLabels[id] ?? id}: Gebühren bitte als Zahl von 0 bis 100 mit höchstens zwei Nachkommastellen eingeben.`;
const feeDrafts = (data: Settings) => Object.fromEntries(data.sources.map(source => [source.id, formatFeePercent(source.fee_basis_points)]));

/**
 * Settings that the owner saves by hand (0.6.5).
 * - edit(update) and editFee(id, text) change only the draft; nothing is sent.
 * - save() sends the draft (fees are checked first), discard() returns to the last saved state.
 * - A change made while saving is kept: the draft stays dirty with it.
 * `saved` is the last state the server confirmed; every other page reads only that.
 */
export function useSettingsDraft({ csrf, onSaved, onProtectedError }: {
  csrf: string; onSaved: (saved: Settings) => void; onProtectedError: (error: unknown) => void;
}) {
  const [settings, setSettingsState] = useState<Settings | null>(null);
  const [saved, setSavedState] = useState<Settings | null>(null);
  const [feeDraft, setFeeDraft] = useState<Record<string, string>>({});
  const [state, setState] = useState<SaveState>('clean');
  const [error, setError] = useState('');
  const draft = useRef<Settings | null>(null);
  const base = useRef<Settings | null>(null);
  const fees = useRef<Record<string, string>>({});
  const version = useRef(0);
  const savedVersion = useRef(0);
  const latest = useRef({ csrf, onSaved, onProtectedError });
  latest.current = { csrf, onSaved, onProtectedError };

  const adopt = useCallback((data: Settings) => {
    draft.current = data; base.current = data; fees.current = feeDrafts(data);
    setSettingsState(data); setFeeDraft(fees.current); setSavedState(data);
  }, []);
  /** Take the server state as it is (after sign-in, or after adding or removing a shop). Drops unsaved edits. */
  const reset = useCallback((data: Settings) => {
    version.current = savedVersion.current = 0;
    adopt(data); setState('clean'); setError('');
  }, [adopt]);
  const touch = useCallback(() => { version.current += 1; setState('dirty'); setError(''); }, []);

  const edit = useCallback((update: (current: Settings) => Settings) => {
    if (!draft.current) return;
    draft.current = update(draft.current);
    setSettingsState(draft.current);
    touch();
  }, [touch]);
  const editFee = useCallback((id: string, text: string) => {
    fees.current = { ...fees.current, [id]: text };
    setFeeDraft(fees.current);
    touch();
  }, [touch]);

  const failed = useCallback((e: unknown) => {
    if (e instanceof HttpError && e.status === 401) latest.current.onProtectedError(e);
    setError(e instanceof Error ? e.message : 'Einstellungen konnten nicht gespeichert werden.'); setState('error');
  }, []);

  /** Sends the draft. Returns false when a fee is invalid or the server refused it. */
  const save = useCallback(async (): Promise<boolean> => {
    const snapshot = draft.current;
    const sentVersion = version.current;
    if (!snapshot || sentVersion === savedVersion.current) return true;
    const sources = [];
    for (const source of snapshot.sources) {
      const value = source.kind === 'shop' && source.enabled && source.fee_estimation_enabled
        ? parseFeePercent(fees.current[source.id] ?? '') : source.fee_basis_points;
      if (value === null) { setError(feeError(source.id)); setState('error'); return false; }
      sources.push({ ...source, fee_basis_points: value });
    }
    setState('saving'); setError('');
    try {
      const result = await api<Settings>('/settings', 'PUT', { ...snapshot, sources }, latest.current.csrf);
      savedVersion.current = sentVersion;
      base.current = result; setSavedState(result);
      if (version.current === sentVersion) { adopt(result); setState('clean'); } else setState('dirty');
      latest.current.onSaved(result);
      return true;
    } catch (e) { failed(e); return false; }
  }, [adopt, failed]);

  const discard = useCallback(() => {
    if (!base.current) return;
    version.current = savedVersion.current;
    adopt(base.current); setState('clean'); setError('');
  }, [adopt]);

  const dirty = state !== 'clean';
  // Warn when the tab is closed with unsaved changes; nothing is saved without the button.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  return { settings, saved, feeDraft, state, error, dirty, edit, editFee, save, discard, reset };
}

export type SettingsDraft = ReturnType<typeof useSettingsDraft>;
