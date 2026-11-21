import { useState } from 'react';
import type { FormEvent } from 'react';
import { api, HttpError } from '../../api';
import type { FetchShopStatus, Settings, SourceSettings } from '../../api';
import { Button, ConfirmDialog, Notice, Switch } from '../../components';
import { parseFeePercent } from '../../fees';
import { SettingsPanel } from './parts';
import { DAILY_JOBS_MAX, DAILY_JOBS_MIN, intervalOptions, parseDailyJobs, shopTitle } from './format';
import type { SettingsDraft } from './draft';

const SUPPORTED = ['eneba', 'driffle'];

/** "Abrufe pro Tag (höchstens)": a valid number is saved like any text field (700 ms after the last key); anything else stays a local draft with a hint. */
function DailyJobs({ source, status, change }: { source: SourceSettings; status: FetchShopStatus | undefined; change: (patch: Partial<SourceSettings>) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [blurred, setBlurred] = useState(false);
  const id = `${source.id}-daily-jobs`;
  const shown = draft ?? (typeof source.daily_jobs === 'number' ? String(source.daily_jobs) : '');
  const invalid = draft !== null && draft.trim() !== '' && parseDailyJobs(draft) === null;
  const fallback = typeof source.daily_jobs_default === 'number' ? source.daily_jobs_default : undefined;
  const env = status?.budget.limit_source === 'env';
  function type(text: string) {
    setDraft(text); setBlurred(false);
    // Empty clears the setting (null), so the default applies again.
    const value = text.trim() === '' ? null : parseDailyJobs(text);
    if ((value !== null || text.trim() === '') && value !== source.daily_jobs) change({ daily_jobs: value });
  }
  function leave() {
    setBlurred(true);
    // Empty or valid: show the saved value again. An invalid value stays so it can be corrected.
    if (draft === null || draft.trim() === '' || parseDailyJobs(draft) !== null) { setDraft(null); setBlurred(false); }
  }
  return <div className="form-row">
    <label htmlFor={id}>Abrufe pro Tag (höchstens)</label>
    <input id={id} className="set-w-200" inputMode="numeric" autoComplete="off" value={shown} placeholder={fallback === undefined ? '' : String(fallback)}
      aria-invalid={invalid && blurred ? true : undefined} aria-describedby={`${id}-hint`} disabled={!source.enabled}
      onChange={event => type(event.target.value)} onBlur={leave} />
    <span id={`${id}-hint`} className={`hint${invalid && blurred ? ' bad' : ''}`}>
      {invalid && blurred ? `Bitte eine ganze Zahl von ${DAILY_JOBS_MIN} bis ${DAILY_JOBS_MAX} eingeben.`
        : <>Die Abrufe werden gleichmäßig über den Tag verteilt.{fallback !== undefined && ` Standard: ${fallback}${env ? ' (aus einer Umgebungsvariable)' : ''}; leer lassen für den Standard.`}</>}
    </span>
  </div>;
}

function ShopPanel({ source, status, feeText, edit, editFee, locked, onRemove }: {
  source: SourceSettings; status: FetchShopStatus | undefined; feeText: string;
  edit: SettingsDraft['edit']; editFee: SettingsDraft['editFee'];
  /** Unsaved changes: removing the shop would reload the settings and drop them. */ locked: boolean; onRemove: () => void;
}) {
  const name = shopTitle(source.id);
  const [feeBlurred, setFeeBlurred] = useState(false);
  const change = (patch: Partial<SourceSettings>) => edit(current => ({ ...current, sources: current.sources.map(s => s.id === source.id ? { ...s, ...patch } : s) }));
  const feeActive = source.enabled && source.fee_estimation_enabled;
  const feeInvalid = feeActive && parseFeePercent(feeText) === null;
  const intervalId = `${source.id}-interval`;
  return <SettingsPanel as="article" aria-label={name} title={name}
    aside={<Switch checked={source.enabled} onChange={enabled => change({ enabled })}><span className="sr-only">{name} </span>Aktiv</Switch>}>
    <div className="form-grid">
      <div className="form-row">
        <label htmlFor={intervalId}>Produktseiten abfragen alle</label>
        <select id={intervalId} className="set-w-200" value={source.poll_interval_seconds} onChange={event => change({ poll_interval_seconds: Number(event.target.value) })}>
          {intervalOptions(source.poll_interval_seconds).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </div>
      <DailyJobs source={source} status={status} change={change} />
      <div className="form-row" role="group" aria-labelledby={`${source.id}-fee-title`}>
        <span id={`${source.id}-fee-title`}>Geschätzte Gebühren</span>
        <div className="set-fee">
          <Switch checked={source.fee_estimation_enabled} disabled={!source.enabled} onChange={on => change({ fee_estimation_enabled: on })}>
            <span className="sr-only">Geschätzte Gebühren berücksichtigen, </span>{source.fee_estimation_enabled ? 'an' : 'aus'}
          </Switch>
          <span className="field set-fee-input">
            <input inputMode="decimal" autoComplete="off" aria-label="Geschätzte Gebühren (%)" value={feeText} disabled={!feeActive}
              aria-invalid={feeInvalid && feeBlurred ? true : undefined} aria-describedby={`${source.id}-fee-help`}
              onChange={event => editFee(source.id, event.target.value)}
              onBlur={() => setFeeBlurred(true)} />
            <span className="muted" aria-hidden="true">%</span>
          </span>
        </div>
        <span id={`${source.id}-fee-help`} className={`hint${feeInvalid && feeBlurred ? ' bad' : ''}`}>
          {feeInvalid && feeBlurred ? 'Bitte eine Zahl von 0 bis 100 mit höchstens zwei Nachkommastellen eingeben.' : 'Aufschlag auf den Grundpreis; der Gesamtpreis bleibt als Schätzung gekennzeichnet.'}
        </span>
      </div>
      <p className="hint">Empfohlen: 8 Stunden pro Produktseite; neue Produkte und manuelle Abfragen kommen früher dran. Bei Fehlern oder einer Pausenbitte des Shops wartet KeyHunter automatisch.</p>
      <div><Button variant="danger" size="sm" disabled={locked} title={locked ? 'Erst speichern oder verwerfen' : undefined} onClick={onRemove}>Entfernen</Button></div>
    </div>
  </SettingsPanel>;
}

export default function Shops({ settings, feeDraft, edit, editFee, dirty, status, csrf, onShopsChanged, onHelp, onError }: {
  settings: Settings; feeDraft: Record<string, string>; edit: SettingsDraft['edit']; editFee: SettingsDraft['editFee'];
  /** Unsaved changes: adding or removing a shop reloads the settings, so it waits until they are saved or discarded. */ dirty: boolean;
  status: FetchShopStatus[] | undefined; csrf: string; onShopsChanged: (saved: Settings) => void; onHelp: () => void; onError: (error: unknown) => void;
}) {
  const [url, setUrl] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [removing, setRemoving] = useState<SourceSettings | null>(null);
  const shops = settings.sources.filter(s => s.kind === 'shop' && s.configured);
  const allActive = SUPPORTED.every(id => shops.some(s => s.id === id));

  async function change(method: 'POST' | 'DELETE', path: string, body?: unknown) {
    setWorking(true); setError(''); setMessage('');
    try {
      const saved = await api<Settings>(path, method, body, csrf);
      onShopsChanged(saved); setUrl('');
      setMessage(method === 'POST' ? 'Dienst hinzugefügt.' : 'Dienst entfernt. Vorhandene Messungen bleiben gespeichert.');
      setRemoving(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Dienst konnte nicht geändert werden.');
      if (e instanceof HttpError && e.status === 401) onError(e);
    } finally { setWorking(false); }
  }
  function register(event: FormEvent) { event.preventDefault(); void change('POST', '/settings/shops', { url }); }

  return <>
    {shops.length === 0
      ? <div className="note" role="note"><span><b>Noch kein Key-Shop eingerichtet.</b> Füge unten einen Shop hinzu, damit Preise abgerufen werden.</span></div>
      : <div className="shops">{shops.map(source => <ShopPanel key={source.id} source={source} status={status?.find(s => s.source === source.id)} feeText={feeDraft[source.id] ?? ''}
        edit={edit} editFee={editFee} locked={dirty} onRemove={() => { setError(''); setRemoving(source); }} />)}</div>}
    {(message || error) && !removing && (error ? <Notice error>{error}</Notice> : <Notice>{message}</Notice>)}
    <SettingsPanel title="Weiteren Shop hinzufügen" titleId="shop-add-title">
      <form className="form-grid" onSubmit={register}>
        <p className="hint">Jeder Shop braucht einen geprüften Reader. Verfügbar: Eneba, Driffle.</p>
        {dirty && <p className="hint" role="note">Erst die geänderten Einstellungen speichern oder verwerfen, dann lässt sich ein Shop hinzufügen oder entfernen.</p>}
        {allActive
          ? <div><Button disabled>Alle verfügbaren aktiv</Button></div>
          : <div className="set-add">
            <div className="form-row"><label htmlFor="shop-url">Shop-URL</label><input id="shop-url" type="url" placeholder="https://driffle.com" value={url} onChange={e => setUrl(e.target.value)} required maxLength={300} /></div>
            <Button type="submit" disabled={dirty} loading={working && !removing}>{working && !removing ? 'Wird geprüft …' : 'Dienst hinzufügen'}</Button>
          </div>}
        <div><button type="button" className="text-button" onClick={onHelp}>Wie werden Gebühren behandelt?</button></div>
      </form>
    </SettingsPanel>
    <ConfirmDialog open={removing !== null} title={removing ? `${shopTitle(removing.id)} entfernen?` : ''} confirmLabel="Entfernen bestätigen" danger busy={working}
      onCancel={() => setRemoving(null)} onConfirm={() => removing && void change('DELETE', `/settings/shops/${removing.id}`)}>
      <p>Von {removing ? shopTitle(removing.id) : 'diesem Shop'} werden keine Preise mehr abgerufen. Vorhandene Messungen bleiben gespeichert, und du kannst den Shop jederzeit wieder hinzufügen.</p>
      {error && <Notice error>{error}</Notice>}
    </ConfirmDialog>
  </>;
}
