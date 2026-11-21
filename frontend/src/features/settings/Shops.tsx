import { useState } from 'react';
import type { FetchShopStatus, Settings, SourceSettings } from '../../api';
import { Switch } from '../../components';
import { parseFeePercent } from '../../fees';
import { SettingsPanel } from './parts';
import { DAILY_JOBS_MAX, DAILY_JOBS_MIN, intervalOptions, parseDailyJobs, shopTitle } from './format';
import type { SettingsDraft } from './draft';

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

function ShopPanel({ source, status, feeText, edit, editFee }: {
  source: SourceSettings; status: FetchShopStatus | undefined; feeText: string;
  edit: SettingsDraft['edit']; editFee: SettingsDraft['editFee'];
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
    </div>
  </SettingsPanel>;
}

/**
 * Key-Shops: one panel per built-in shop reader, always listed (0.7.4). "Aktiv" switches a shop on or off; there is no
 * adding or removing, since every shop needs its own tested reader.
 */
export default function Shops({ settings, feeDraft, edit, editFee, status, onHelp }: {
  settings: Settings; feeDraft: Record<string, string>; edit: SettingsDraft['edit']; editFee: SettingsDraft['editFee'];
  status: FetchShopStatus[] | undefined; onHelp: () => void;
}) {
  const shops = settings.sources.filter(s => s.kind === 'shop');
  return <>
    <div className="shops">{shops.map(source => <ShopPanel key={source.id} source={source} status={status?.find(s => s.source === source.id)} feeText={feeDraft[source.id] ?? ''}
      edit={edit} editFee={editFee} />)}</div>
    <p className="hint shops-help"><button type="button" className="text-button" onClick={onHelp}>Wie werden Gebühren behandelt?</button></p>
  </>;
}
