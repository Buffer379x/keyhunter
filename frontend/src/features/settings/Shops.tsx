import { useState } from 'react';
import type { FormEvent } from 'react';
import { api, HttpError } from '../../api';
import type { FetchShopStatus, Settings, SourceSettings } from '../../api';
import { Button, ConfirmDialog, Notice, Panel, Switch } from '../../components';
import { parseFeePercent } from '../../fees';
import { relativeTime } from '../../time';
import { Dot, RowCard, ShopMark, UsageBar } from './parts';
import { intervalOptions, shopState, shopTitle } from './format';
import type { Autosave } from './autosave';

const SUPPORTED = ['eneba', 'driffle'];

function ShopCard({ source, status, feeText, edit, editFee, settle, onRemove }: {
  source: SourceSettings; status: FetchShopStatus | undefined; feeText: string;
  edit: Autosave['edit']; editFee: Autosave['editFee']; settle: Autosave['settle']; onRemove: () => void;
}) {
  const name = shopTitle(source.id);
  const [feeBlurred, setFeeBlurred] = useState(false);
  const change = (patch: Partial<SourceSettings>) => edit(current => ({ ...current, sources: current.sources.map(s => s.id === source.id ? { ...s, ...patch } : s) }));
  const state = status ? shopState({ ...status, enabled: source.enabled }, Date.now() / 1000, relativeTime) : { tone: source.enabled ? 'ok' as const : 'off' as const, text: source.enabled ? 'Aktiv' : 'Deaktiviert' };
  const feeActive = source.enabled && source.fee_estimation_enabled;
  const feeInvalid = feeActive && parseFeePercent(feeText) === null;
  const intervals = intervalOptions(source.poll_interval_seconds);
  return <Panel padded as="article" className="set-card set-shop" aria-label={name}>
    <div className="set-shop-head">
      <span className="set-shop-id"><ShopMark id={source.id} /><span><strong>{name}</strong>
        <span className="set-shop-state"><Dot tone={state.tone} />{state.text}</span></span></span>
      <Switch checked={source.enabled} onChange={enabled => change({ enabled })}>
        <span className="sr-only">{name} </span>{source.enabled ? 'Aktiv' : 'Aus'}
      </Switch>
    </div>
    <div className="set-shop-fields">
      <div className="form-row">
        <label htmlFor={`${source.id}-interval`}>Abfrageintervall</label>
        <select id={`${source.id}-interval`} value={source.poll_interval_seconds} onChange={event => change({ poll_interval_seconds: Number(event.target.value) })}>
          {intervals.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </div>
      <div className="form-row" role="group" aria-labelledby={`${source.id}-fee-title`}>
        <span id={`${source.id}-fee-title`} className="set-label">Gebühren schätzen</span>
        <div className="set-fee">
          <Switch checked={source.fee_estimation_enabled} disabled={!source.enabled} onChange={on => change({ fee_estimation_enabled: on })}>
            <span className="sr-only">Geschätzte Gebühren berücksichtigen, </span>{source.fee_estimation_enabled ? 'an' : 'aus'}
          </Switch>
          <span className="set-fee-input">
            <input inputMode="decimal" autoComplete="off" aria-label="Geschätzte Gebühren (%)" value={feeText} disabled={!feeActive}
              aria-invalid={feeInvalid && feeBlurred ? true : undefined} aria-describedby={`${source.id}-fee-help`}
              onChange={event => editFee(source.id, event.target.value)}
              onBlur={() => { setFeeBlurred(true); void settle(); }} />
            <span aria-hidden="true">%</span>
          </span>
        </div>
      </div>
      <div className="form-row" role="group" aria-labelledby={`${source.id}-usage-title`}>
        <span id={`${source.id}-usage-title`} className="set-label">Abrufe heute</span>
        {status && status.budget.limit > 0
          ? <UsageBar used={status.budget.used} limit={status.budget.limit} label={`${name}: ${status.budget.used} von ${status.budget.limit} Abrufen heute`} />
          : <span className="set-usage-text set-muted">{status ? 'Kein Tageslimit' : 'Wird gelesen …'}</span>}
      </div>
    </div>
    <p id={`${source.id}-fee-help`} className={`set-hint${feeInvalid && feeBlurred ? ' bad' : ''}`}>
      {feeInvalid && feeBlurred ? 'Bitte eine Zahl von 0 bis 100 mit höchstens zwei Nachkommastellen eingeben.' : 'Optionaler Aufschlag auf den Grundpreis. Der Gesamtpreis bleibt als Schätzung gekennzeichnet. Empfohlen sind 8 Stunden pro Produktseite; neue Produkte und manuelle Abfragen können früher geprüft werden.'}
    </p>
    <div className="set-shop-foot">
      <Button variant="danger" size="sm" onClick={onRemove}>Entfernen</Button>
    </div>
  </Panel>;
}

export default function Shops({ settings, feeDraft, edit, editFee, settle, status, csrf, onShopsChanged, onHelp, onError }: {
  settings: Settings; feeDraft: Record<string, string>; edit: Autosave['edit']; editFee: Autosave['editFee']; settle: Autosave['settle'];
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
      await settle(); // Unsent edits go first, so the answer below does not overwrite them.
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
    {shops.length === 0 && <RowCard title="Noch kein Key-Shop eingerichtet" sub="Füge unten einen Shop hinzu, damit Preise abgerufen werden." />}
    {shops.map(source => <ShopCard key={source.id} source={source} status={status?.find(s => s.source === source.id)} feeText={feeDraft[source.id] ?? ''}
      edit={edit} editFee={editFee} settle={settle} onRemove={() => { setError(''); setRemoving(source); }} />)}
    {(message || error) && !removing && (error ? <Notice error>{error}</Notice> : <Notice>{message}</Notice>)}
    <Panel padded as="form" className="set-row-card set-add" onSubmit={register}>
      <div><h2>Weiteren Shop hinzufügen</h2><p>Jeder Shop braucht einen geprüften Reader. Verfügbar: Eneba, Driffle.</p></div>
      {allActive
        ? <Button disabled>Alle verfügbaren aktiv</Button>
        : <div className="set-add-fields">
          <div className="form-row"><label htmlFor="shop-url">Shop-URL</label><input id="shop-url" type="url" placeholder="https://driffle.com" value={url} onChange={e => setUrl(e.target.value)} required maxLength={300} /></div>
          <Button type="submit" loading={working && !removing}>{working && !removing ? 'Wird geprüft …' : 'Dienst hinzufügen'}</Button>
        </div>}
    </Panel>
    <div><button type="button" className="text-button" onClick={onHelp}>Wie werden Gebühren behandelt?</button></div>
    <ConfirmDialog open={removing !== null} title={removing ? `${shopTitle(removing.id)} entfernen?` : ''} confirmLabel="Entfernen bestätigen" danger busy={working}
      onCancel={() => setRemoving(null)} onConfirm={() => removing && void change('DELETE', `/settings/shops/${removing.id}`)}>
      <p>Von {removing ? shopTitle(removing.id) : 'diesem Shop'} werden keine Preise mehr abgerufen. Vorhandene Messungen bleiben gespeichert, und du kannst den Shop jederzeit wieder hinzufügen.</p>
      {error && <Notice error>{error}</Notice>}
    </ConfirmDialog>
  </>;
}
