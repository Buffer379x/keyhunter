import { useState } from 'react';
import { api, FETCH_STATUS_CHANGED } from '../../api';
import { Button, EmptyState, Icon, Notice, Panel, Pill } from '../../components';
import type { FetchRun, FetchShopStatus, FetchStatusResponse } from '../../api';
import { relativeTime } from '../../time';
import { paceText } from '../../FetchStatus';
import { SettingsPanel } from './parts';
import { DAILY_JOBS_MAX, budgetView, intervalLabel, clockText, dateTimeText, durationText, fetchPill, kindText, outcomeText, outcomeTone, shopState, shopTitle, untilText, workerState } from './format';

const pct = (share: number) => `${(share * 100).toFixed(1)}%`;

/** One shop: state pill, Heute / Nächster Abruf / Letzter, and the daily budget bar with the demand marker (prototype viewFetch). */
function ShopStatus({ shop, now, paused }: { shop: FetchShopStatus; now: number; /** Automatic checks paused by the owner. */ paused: boolean }) {
  const name = shopTitle(shop.source);
  const pill = paused && shop.enabled ? { tone: 'warn' as const, text: 'Pausiert' } : fetchPill(shop, now);
  const budget = budgetView(shop.budget);
  const next = shop.budget.next_at ?? shop.next_due_at;
  const state = shopState(shop, now, relativeTime);
  const worker = workerState(shop, now, relativeTime);
  // Only what is not normal gets a line of its own: a pause, an error or a worker without heartbeat.
  const problem = state.tone === 'warn' || state.tone === 'error' ? [state.text, shop.last_error ? outcomeText(shop.last_error) : ''].filter(Boolean).join(' · ')
    : worker.tone === 'error' ? `Worker ${worker.text}` : '';
  return <SettingsPanel as="article" aria-label={`Abrufstatus ${name}`} title={name} insetClassName="shop-body"
    aside={<Pill tone={pill.tone}><i className={`dot${pill.tone === 'ok' ? '' : pill.tone === 'danger' ? ' error' : pill.tone === 'dim' ? ' off' : ' warn'}`} aria-hidden="true" />{pill.text}</Pill>}>
    <div className="shop-stats">
      <div><span className="label">Heute</span><b>{budget.used}</b></div>
      <div><span className="label">Nächster Abruf</span><b title={next ? dateTimeText(next) : undefined}>{!shop.enabled || next === null || next === undefined ? '–' : untilText(next, now)}</b></div>
      <div><span className="label">Letzter</span><b title={shop.last_success_at ? dateTimeText(shop.last_success_at) : undefined}>{shop.last_success_at === null ? 'noch keiner' : relativeTime(shop.last_success_at)}</b></div>
    </div>
    {budget.limit > 0
      ? <div className="budget">
        <div className="budget-l">
          <span>{budget.used} von {budget.limit} Abrufen{budget.pace && !paused ? ` · gleichmäßig verteilt, etwa ${paceText(budget.pace)}` : ' heute'}</span>
          {budget.demand !== null && <span>Bedarf ≈ {budget.demand} pro Tag</span>}
        </div>
        <span className="bar" role="progressbar" aria-label={`${name}: ${budget.used} von ${budget.limit} Abrufen heute`} aria-valuemin={0} aria-valuemax={budget.limit} aria-valuenow={Math.min(budget.used, budget.limit)}>
          <i style={{ width: pct(budget.share) }} />
          {budget.demandShare !== null && <span className="need" style={{ left: pct(budget.demandShare) }} title={`Bedarf ≈ ${budget.demand} pro Tag`} />}
        </span>
      </div>
      : <p className="hint">{budget.used} Abrufe heute · kein Tageslimit</p>}
    {problem && <p className="hint set-problem">{problem}</p>}
  </SettingsPanel>;
}

/** Warning above the shops when the wishlist needs more fetches than a shop may make per day. */
function DemandNote({ shop, interval, onShops }: { shop: FetchShopStatus; interval?: number; onShops: () => void }) {
  const budget = budgetView(shop.budget);
  if (!shop.enabled || !budget.over || budget.needed === null) return null;
  const name = shopTitle(shop.source);
  const tooMany = budget.needed > DAILY_JOBS_MAX;
  return <div className="note warn" role="note" data-testid={`demand-note-${shop.source}`}>
    <Icon name="alert" />
    <span>
      <b>{name} braucht etwa {budget.demand} Abrufe pro Tag, erlaubt sind {budget.limit}.</b>{' '}
      {tooMany
        ? <>Das ist mehr als die höchstens möglichen {DAILY_JOBS_MAX}. Setze „Abrufe pro Tag (höchstens)“ auf {DAILY_JOBS_MAX} und verlängere das Intervall, damit alle Wünsche rechtzeitig abgefragt werden.</>
        : <>Damit alle Wünsche rechtzeitig abgefragt werden, setze „Abrufe pro Tag (höchstens)“ auf mindestens <b>{budget.needed}</b>.</>}
      {interval !== undefined && interval < RECOMMENDED_INTERVAL && <> Alternativ das Intervall von {intervalLabel(interval)} auf die empfohlenen 8 Stunden verlängern; das senkt den Bedarf auf grob {Math.max(1, Math.round(Number(budget.demand) * interval / RECOMMENDED_INTERVAL))} pro Tag.</>}
      {budget.fromEnv && ' Das Limit kommt derzeit aus einer Umgebungsvariable.'}{' '}
      <button type="button" className="text-button" onClick={onShops}>Zu den Key-Shops</button>
    </span>
  </div>;
}

function RunsTable({ runs }: { runs: FetchRun[] }) {
  if (runs.length === 0) return <p className="hint set-pad">Noch keine Abrufe aufgezeichnet.</p>;
  return <div className="table-wrap"><table aria-label="Letzte Abrufe">
    <thead><tr><th>Zeit</th><th>Shop</th><th>Art</th><th>Ziel</th><th>Ergebnis</th></tr></thead>
    <tbody>{runs.map((run, index) => {
      const tone = outcomeTone(run.outcome);
      return <tr key={`${run.started_at}-${index}`}>
        <td className="mono" title={dateTimeText(run.started_at)}>{clockText(run.started_at)}</td>
        <td>{shopTitle(run.source)}</td>
        <td>{kindText(run.kind)}</td>
        <td className="set-run-target" title={run.detail ?? undefined}>{run.detail ?? '–'}</td>
        <td><Pill tone={tone === 'ok' ? 'ok' : tone === 'warn' ? 'warn' : 'danger'} icon={tone === 'ok' ? 'check' : 'alert'}>{tone === 'ok' ? durationText(run.duration_ms) : outcomeText(run.outcome)}</Pill></td>
      </tr>;
    })}</tbody>
  </table></div>;
}

/**
 * Pause and resume of the automatic checks (0.7.0): while paused no shop is asked on its own; a refresh the owner asks for
 * in a game and the first search of a newly added game still run. Takes effect at once, no "Speichern" needed.
 */
function PauseControl({ pausedAt, csrf, now, onChanged }: { pausedAt: number | null; csrf: string; now: number; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function toggle() {
    setBusy(true); setError('');
    try {
      await api('/status/fetch/pause', 'POST', { paused: pausedAt === null }, csrf);
      onChanged(); window.dispatchEvent(new Event(FETCH_STATUS_CHANGED));
    } catch (e) { setError(e instanceof Error ? e.message : 'Konnte nicht umgeschaltet werden.'); }
    finally { setBusy(false); }
  }
  return <SettingsPanel title="Automatische Abfragen" titleId="pause-title"
    aside={<Pill tone={pausedAt === null ? 'ok' : 'warn'}><i className={`dot${pausedAt === null ? '' : ' warn'}`} aria-hidden="true" />{pausedAt === null ? 'Laufen' : 'Pausiert'}</Pill>}>
    <div className="set-row set-pad">
      <div>{pausedAt === null
        ? <p className="hint">Pausieren, wenn du gerade keine Preise brauchst. Danach fragt KeyHunter keinen Shop mehr von sich aus ab, bis du fortsetzt. „Jetzt aktualisieren“ in einem Spiel funktioniert weiter.</p>
        : <p className="hint"><b className="set-paused">Pausiert seit {dateTimeText(pausedAt)} ({relativeTime(pausedAt, now * 1000)}).</b> Preise werden nicht automatisch aktualisiert und gelten nach einem Tag als veraltet. Nach dem Fortsetzen holt KeyHunter die fälligen Abfragen gleichmäßig verteilt nach.</p>}</div>
      <Button variant={pausedAt === null ? 'default' : 'primary'} loading={busy} onClick={() => void toggle()}>
        <Icon name={pausedAt === null ? 'clock' : 'refresh'} />{pausedAt === null ? 'Abfragen pausieren' : 'Abfragen fortsetzen'}</Button>
    </div>
    {error && <Notice error>{error}</Notice>}
  </SettingsPanel>;
}

/** Recommended product interval of both shops (settings::shop_readers). */
const RECOMMENDED_INTERVAL = 28800;

export default function FetchPanel({ data, failed, loadedAt, intervals = {}, csrf, onChanged, onShops }: {
  data: FetchStatusResponse | null; failed: boolean; loadedAt: number | null; intervals?: Record<string, number>; csrf: string; onChanged: () => void; onShops: () => void;
}) {
  if (!data) return <p role="status" className="hint">{failed ? 'Der Abrufstatus konnte nicht gelesen werden.' : 'Abrufstatus wird geladen …'}</p>;
  if (data.shops.length === 0) return <Panel><EmptyState icon="activity" title="Noch kein Shop eingerichtet" headingLevel={3}>Sobald ein Key-Shop eingerichtet ist, siehst du hier Tagesbudget, nächste und letzte Abrufe.</EmptyState></Panel>;
  const now = Date.now() / 1000;
  return <>
    {failed && loadedAt !== null && <p className="hint" role="status">Aktualisierung fehlgeschlagen · Stand {new Date(loadedAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr</p>}
    <PauseControl pausedAt={data.paused_at ?? null} csrf={csrf} now={now} onChanged={onChanged} />
    {!data.paused_at && data.shops.map(shop => <DemandNote key={shop.source} shop={shop} interval={intervals[shop.source]} onShops={onShops} />)}
    <div className="shops">{data.shops.map(shop => <ShopStatus key={shop.source} shop={shop} now={now} paused={!!data.paused_at} />)}</div>
    <SettingsPanel title="Letzte Abrufe" titleId="runs-title" insetClassName="set-runs">
      <RunsTable runs={data.recent_runs} />
    </SettingsPanel>
  </>;
}
