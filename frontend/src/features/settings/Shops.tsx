import { useState } from 'react';
import type { FetchShopStatus, Settings, SourceSettings } from '../../api';
import { Help, Switch, TabPanel, Tabs } from '../../components';
import { parseFeePercent } from '../../fees';
import { SettingsPanel } from './parts';
import { DAILY_JOBS_MAX, DAILY_JOBS_MIN, intervalOptions, parseDailyJobs, shopTitle } from './format';
import type { SettingsDraft } from './draft';

/** "Abrufe pro Tag (höchstens)": a valid number is saved like any text field (700 ms after the last key); anything else stays a local draft with a hint. */
function DailyJobs({
  source,
  status,
  change,
}: {
  source: SourceSettings;
  status: FetchShopStatus | undefined;
  change: (patch: Partial<SourceSettings>) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [blurred, setBlurred] = useState(false);
  const id = `${source.id}-daily-jobs`;
  const shown = draft ?? (typeof source.daily_jobs === 'number' ? String(source.daily_jobs) : '');
  const invalid = draft !== null && draft.trim() !== '' && parseDailyJobs(draft) === null;
  const fallback = typeof source.daily_jobs_default === 'number' ? source.daily_jobs_default : undefined;
  const env = status?.budget.limit_source === 'env';
  function type(text: string) {
    setDraft(text);
    setBlurred(false);
    // Empty clears the setting (null), so the default applies again.
    const value = text.trim() === '' ? null : parseDailyJobs(text);
    if ((value !== null || text.trim() === '') && value !== source.daily_jobs) change({ daily_jobs: value });
  }
  function leave() {
    setBlurred(true);
    // Empty or valid: show the saved value again. An invalid value stays so it can be corrected.
    if (draft === null || draft.trim() === '' || parseDailyJobs(draft) !== null) {
      setDraft(null);
      setBlurred(false);
    }
  }
  return (
    <div className="form-row">
      <span className="with-help">
        <label htmlFor={id}>Abrufe pro Tag (höchstens)</label>
        <Help label="Hilfe zu Abrufe pro Tag">
          Die Abrufe werden gleichmäßig über den Tag verteilt.
          {fallback !== undefined && ` Standard: ${fallback}${env ? ' (aus einer Umgebungsvariable)' : ''}; leer lassen für den Standard.`}
        </Help>
      </span>
      <input
        id={id}
        className="set-w-200"
        inputMode="numeric"
        autoComplete="off"
        value={shown}
        placeholder={fallback === undefined ? '' : String(fallback)}
        aria-invalid={invalid && blurred ? true : undefined}
        aria-describedby={invalid && blurred ? `${id}-hint` : undefined}
        disabled={!source.enabled}
        onChange={event => type(event.target.value)}
        onBlur={leave}
      />
      {invalid && blurred && (
        <span id={`${id}-hint`} className="hint bad">
          Bitte eine ganze Zahl von {DAILY_JOBS_MIN} bis {DAILY_JOBS_MAX} eingeben.
        </span>
      )}
    </div>
  );
}

/** How fees are treated (before 0.8.3 a dialog below the shops). */
function FeeHelp() {
  return (
    <Help label="Hilfe zu Gebühren">
      <span>
        Aufschlag in Prozent auf den Grundpreis. Daraus berechnete Preise werden als <b>geschätzt</b> gekennzeichnet; der tatsächliche Kaufpreis kann abweichen.
      </span>
      <span>Ein niedriger Shoppreis enthält möglicherweise noch nicht alle Kosten. Ohne Schätzung bleibt der Gesamtpreis unbekannt.</span>
      <span>Ein Schätzwert ersetzt weder die Aktivierungsprüfung noch die Angaben des Shops.</span>
    </Help>
  );
}

function ShopPanel({
  source,
  status,
  feeText,
  edit,
  editFee,
}: {
  source: SourceSettings;
  status: FetchShopStatus | undefined;
  feeText: string;
  edit: SettingsDraft['edit'];
  editFee: SettingsDraft['editFee'];
}) {
  const name = shopTitle(source.id);
  const [feeBlurred, setFeeBlurred] = useState(false);
  const change = (patch: Partial<SourceSettings>) =>
    edit(current => ({ ...current, sources: current.sources.map(s => (s.id === source.id ? { ...s, ...patch } : s)) }));
  const feeActive = source.enabled && source.fee_estimation_enabled;
  const feeInvalid = feeActive && parseFeePercent(feeText) === null;
  const intervalId = `${source.id}-interval`;
  return (
    <SettingsPanel
      as="article"
      aria-label={name}
      title={name}
      aside={
        <Switch checked={source.enabled} onChange={enabled => change({ enabled })}>
          <span className="sr-only">{name} </span>Aktiv
        </Switch>
      }
    >
      <div className="form-grid">
        <div className="form-row">
          <span className="with-help">
            <label htmlFor={intervalId}>Produktseiten abfragen alle</label>
            <Help label="Hilfe zum Intervall">
              Empfohlen: 8 Stunden pro Produktseite; neue Produkte und manuelle Abfragen kommen früher dran. Bei Fehlern oder einer Pausenbitte des Shops wartet
              KeyHunter automatisch.
            </Help>
          </span>
          <select
            id={intervalId}
            className="set-w-200"
            value={source.poll_interval_seconds}
            onChange={event => change({ poll_interval_seconds: Number(event.target.value) })}
          >
            {intervalOptions(source.poll_interval_seconds).map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <DailyJobs source={source} status={status} change={change} />
        <div className="form-row" role="group" aria-labelledby={`${source.id}-fee-title`}>
          <span className="with-help">
            <span id={`${source.id}-fee-title`}>Geschätzte Gebühren</span>
            <FeeHelp />
          </span>
          <div className="set-fee">
            <Switch checked={source.fee_estimation_enabled} disabled={!source.enabled} onChange={on => change({ fee_estimation_enabled: on })}>
              <span className="sr-only">Geschätzte Gebühren berücksichtigen, </span>
              {source.fee_estimation_enabled ? 'an' : 'aus'}
            </Switch>
            <span className="field set-fee-input">
              <input
                inputMode="decimal"
                autoComplete="off"
                aria-label="Geschätzte Gebühren (%)"
                value={feeText}
                disabled={!feeActive}
                aria-invalid={feeInvalid && feeBlurred ? true : undefined}
                aria-describedby={feeInvalid && feeBlurred ? `${source.id}-fee-help` : undefined}
                onChange={event => editFee(source.id, event.target.value)}
                onBlur={() => setFeeBlurred(true)}
              />
              <span className="muted" aria-hidden="true">
                %
              </span>
            </span>
          </div>
          {feeInvalid && feeBlurred && (
            <span id={`${source.id}-fee-help`} className="hint bad">
              Bitte eine Zahl von 0 bis 100 mit höchstens zwei Nachkommastellen eingeben.
            </span>
          )}
        </div>
      </div>
    </SettingsPanel>
  );
}

/**
 * Key-Shops: one tab per built-in shop reader (0.8.3), always listed (0.7.4). "Aktiv" switches a shop on or off; there is no
 * adding or removing, since every shop needs its own tested reader. A shop that is off is marked in its tab.
 */
export default function Shops({
  settings,
  feeDraft,
  edit,
  editFee,
  status,
}: {
  settings: Settings;
  feeDraft: Record<string, string>;
  edit: SettingsDraft['edit'];
  editFee: SettingsDraft['editFee'];
  status: FetchShopStatus[] | undefined;
}) {
  const shops = settings.sources.filter(s => s.kind === 'shop');
  // Opens on the first active shop; a shop that is off waits behind its tab.
  const [open, setOpen] = useState((shops.find(s => s.enabled) ?? shops[0])?.id ?? '');
  const current = shops.some(s => s.id === open) ? open : (shops[0]?.id ?? '');
  return (
    <>
      <Tabs
        id="shops"
        label="Key-Shops"
        className="shop-tabs"
        value={current}
        onChange={setOpen}
        items={shops.map(source => ({ id: source.id, label: source.enabled ? shopTitle(source.id) : `${shopTitle(source.id)} · aus` }))}
      />
      {shops.map(source => (
        <TabPanel key={source.id} id="shops" tab={source.id} value={current}>
          <ShopPanel source={source} status={status?.find(s => s.source === source.id)} feeText={feeDraft[source.id] ?? ''} edit={edit} editFee={editFee} />
        </TabPanel>
      ))}
    </>
  );
}
