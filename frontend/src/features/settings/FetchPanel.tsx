import { EmptyState, Help, Icon, Inset, Label, Panel, PanelHead, Pill } from '../../components';
import type { FetchShopStatus, FetchStatusResponse, RunPage, UpcomingFetch } from '../../api';
import { relativeTime } from '../../time';
import { paceText } from '../../FetchStatus';
import { SettingsPanel } from './parts';
import { Pager, PagedTools, usePaged } from './paged';
import {
  DAILY_JOBS_MAX,
  budgetView,
  intervalLabel,
  dateTimeText,
  durationText,
  fetchPill,
  kindText,
  outcomeText,
  outcomeTone,
  shopState,
  shopTitle,
  untilText,
  workerState,
} from './format';

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
  const problem =
    state.tone === 'warn' || state.tone === 'error'
      ? [state.text, shop.last_error ? outcomeText(shop.last_error) : ''].filter(Boolean).join(' · ')
      : worker.tone === 'error'
        ? `Worker ${worker.text}`
        : '';
  return (
    <SettingsPanel
      as="article"
      aria-label={`Abrufstatus ${name}`}
      title={name}
      insetClassName="shop-body"
      aside={
        <Pill tone={pill.tone}>
          <i className={`dot${pill.tone === 'ok' ? '' : pill.tone === 'danger' ? ' error' : pill.tone === 'dim' ? ' off' : ' warn'}`} aria-hidden="true" />
          {pill.text}
        </Pill>
      }
    >
      <div className="shop-stats">
        <div>
          <span className="label">Heute</span>
          <b>{budget.used}</b>
        </div>
        <div>
          <span className="label">Nächster Abruf</span>
          <b title={next ? dateTimeText(next) : undefined}>{!shop.enabled || next === null || next === undefined ? '–' : untilText(next, now)}</b>
        </div>
        <div>
          <span className="label">Letzter</span>
          <b title={shop.last_success_at ? dateTimeText(shop.last_success_at) : undefined}>
            {shop.last_success_at === null ? 'noch keiner' : relativeTime(shop.last_success_at)}
          </b>
        </div>
      </div>
      {budget.limit > 0 ? (
        <div className="budget">
          <div className="budget-l">
            <span>
              {budget.used} von {budget.limit} Abrufen{budget.pace && !paused ? ` · gleichmäßig verteilt, etwa ${paceText(budget.pace)}` : ' heute'}
            </span>
            {budget.demand !== null && <span>Bedarf ≈ {budget.demand} pro Tag</span>}
          </div>
          <span
            className="bar"
            role="progressbar"
            aria-label={`${name}: ${budget.used} von ${budget.limit} Abrufen heute`}
            aria-valuemin={0}
            aria-valuemax={budget.limit}
            aria-valuenow={Math.min(budget.used, budget.limit)}
          >
            <i style={{ width: pct(budget.share) }} />
            {budget.demandShare !== null && <span className="need" style={{ left: pct(budget.demandShare) }} title={`Bedarf ≈ ${budget.demand} pro Tag`} />}
          </span>
        </div>
      ) : (
        <p className="hint">{budget.used} Abrufe heute · kein Tageslimit</p>
      )}
      {problem && <p className="hint set-problem">{problem}</p>}
    </SettingsPanel>
  );
}

/** Warning above the shops when the wishlist needs more fetches than a shop may make per day. */
function DemandNote({ shop, interval, onShops }: { shop: FetchShopStatus; interval?: number; onShops: () => void }) {
  const budget = budgetView(shop.budget);
  if (!shop.enabled || !budget.over || budget.needed === null) return null;
  const name = shopTitle(shop.source);
  const tooMany = budget.needed > DAILY_JOBS_MAX;
  return (
    <div className="note warn" role="note" data-testid={`demand-note-${shop.source}`}>
      <Icon name="alert" />
      <span>
        <b>
          {name} braucht etwa {budget.demand} Abrufe pro Tag, erlaubt sind {budget.limit}.
        </b>{' '}
        {tooMany ? (
          <>
            Das ist mehr als die höchstens möglichen {DAILY_JOBS_MAX}. Setze „Abrufe pro Tag (höchstens)“ auf {DAILY_JOBS_MAX} und verlängere das Intervall,
            damit alle Wünsche rechtzeitig abgefragt werden.
          </>
        ) : (
          <>
            Damit alle Wünsche rechtzeitig abgefragt werden, setze „Abrufe pro Tag (höchstens)“ auf mindestens <b>{budget.needed}</b>.
          </>
        )}
        {interval !== undefined && interval < RECOMMENDED_INTERVAL && (
          <>
            {' '}
            Alternativ das Intervall von {intervalLabel(interval)} auf die empfohlenen 8 Stunden verlängern; das senkt den Bedarf auf grob{' '}
            {Math.max(1, Math.round((Number(budget.demand) * interval) / RECOMMENDED_INTERVAL))} pro Tag.
          </>
        )}
        {budget.fromEnv && ' Das Limit kommt derzeit aus einer Umgebungsvariable.'}{' '}
        <button type="button" className="text-button" onClick={onShops}>
          Zu den Key-Shops
        </button>
      </span>
    </div>
  );
}

type ToneFilter = '' | 'ok' | 'warn' | 'error';
const tones: { value: ToneFilter; label: string }[] = [
  { value: '', label: 'Alle' },
  { value: 'ok', label: 'Erfolgreich' },
  { value: 'warn', label: 'Warnung' },
  { value: 'error', label: 'Fehler' },
];
/** Game and region of a row ("Forza Horizon 5 · Global"); discovery runs belong to no game. */
const gameText = (game: string | null, region: string | null) =>
  game ? (
    <>
      <b>{game}</b>
      {region && <span className="faint"> · {region}</span>}
    </>
  ) : (
    <span className="faint">–</span>
  );

/** Abrufe (0.8.3): every recorded fetch with the game it was for, by result and full text, page by page. */
function Runs() {
  const list = usePaged<RunPage, ToneFilter>(
    '/status/fetch/runs',
    'tone',
    'keyhunter.list.runs',
    tones.map(t => t.value),
    '',
  );
  const tone = list.filter;
  const { data } = list;
  return (
    <Panel aria-labelledby="runs-title" className="paged">
      <PanelHead className="paged-title">
        <Label as="h2" tone="soft" id="runs-title">
          Abrufe
        </Label>
        <Help label="Hilfe zu den Abrufen">
          <span>Jede Abfrage der Shops mit Spiel, Art und Ergebnis, die neueste zuerst. Die Suche findet Spiel, Shop, Ziel und Ergebnis.</span>
          <span>
            „Nicht gefunden“ und „Abruflimit erreicht“ sind Warnungen: KeyHunter versucht es später von selbst wieder. Aufgezeichnet werden die letzten 30 Tage.
          </span>
        </Help>
      </PanelHead>
      <PagedTools
        label="Abrufe"
        filter={tone}
        filters={tones}
        onFilter={list.setFilter}
        text={list.text}
        onText={list.setText}
        placeholder="Spiel, Shop, Ergebnis …"
        perPage={list.perPage}
        onPerPage={list.setPerPage}
      />
      <Inset className="table-wrap set-runs">
        {!data ? (
          <p className="hint set-pad" role="status">
            {list.failed ? 'Die Abrufe konnten nicht gelesen werden.' : 'Abrufe werden geladen …'}
          </p>
        ) : data.runs.length === 0 ? (
          <p className="hint set-pad">{tone || list.text.trim() ? 'Kein Abruf passt zu diesem Filter.' : 'Noch keine Abrufe aufgezeichnet.'}</p>
        ) : (
          <table aria-label="Letzte Abrufe">
            <thead>
              <tr>
                <th>Zeit</th>
                <th>Shop</th>
                <th>Art</th>
                <th>Spiel</th>
                <th>Ziel</th>
                <th>Ergebnis</th>
              </tr>
            </thead>
            <tbody>
              {data.runs.map(run => {
                const result = outcomeTone(run.outcome);
                return (
                  <tr key={run.id}>
                    <td className="mono" title={dateTimeText(run.started_at)}>
                      {dateTimeText(run.started_at)}
                    </td>
                    <td>{shopTitle(run.source)}</td>
                    <td>{kindText(run.kind)}</td>
                    <td className="set-run-game">{gameText(run.game, run.region)}</td>
                    <td className="set-run-target" title={run.detail ?? undefined}>
                      {run.detail ?? '–'}
                    </td>
                    <td>
                      <Pill tone={result === 'ok' ? 'ok' : result === 'warn' ? 'warn' : 'danger'} icon={result === 'ok' ? 'check' : 'alert'}>
                        {result === 'ok' ? durationText(run.duration_ms) : outcomeText(run.outcome)}
                      </Pill>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Inset>
      {data && data.total > 0 && <Pager label="Abrufe" total={data.total} page={list.page} perPage={list.perPage} onPage={list.setPage} />}
    </Panel>
  );
}

/** The next five fetches the scheduler will run (0.8.3), with the estimated start. */
function Upcoming({ items, paused, now }: { items: UpcomingFetch[]; paused: boolean; now: number }) {
  return (
    <SettingsPanel
      title="Nächste Abfragen"
      titleId="upcoming-title"
      insetClassName="set-runs"
      aside={
        <Help label="Hilfe zu den nächsten Abfragen">
          <span>
            Die fünf Abfragen, die KeyHunter als Nächstes ausführt, über alle Shops. Die Zeit ist eine Schätzung aus Fälligkeit, Tagesbudget und Pausen.
          </span>
          <span>Manuell angeforderte Abfragen und neue Wünsche kommen vor den regelmäßigen dran.</span>
        </Help>
      }
    >
      {items.length === 0 ? (
        <p className="hint set-pad">
          {paused ? 'Die automatischen Abfragen sind pausiert; es steht keine angeforderte Abfrage an.' : 'Gerade steht keine Abfrage an.'}
        </p>
      ) : (
        <div className="table-wrap">
          <table aria-label="Nächste Abfragen">
            <thead>
              <tr>
                <th>Wann</th>
                <th>Shop</th>
                <th>Art</th>
                <th>Spiel</th>
                <th>Ziel</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, index) => (
                <tr key={`${item.source}-${item.link_id ?? item.wish_id ?? 'd'}-${index}`}>
                  <td className="mono" title={dateTimeText(item.due_at)}>
                    {untilText(item.due_at, now)}
                  </td>
                  <td>{shopTitle(item.source)}</td>
                  <td>
                    {kindText(item.kind)}
                    {item.requested && (
                      <>
                        {' '}
                        <Pill tone="hot">angefordert</Pill>
                      </>
                    )}
                  </td>
                  <td className="set-run-game">{gameText(item.game, null)}</td>
                  <td className="set-run-target">
                    {item.kind === 'search' && item.search_page
                      ? `Seite ${item.search_page}`
                      : item.kind === 'discovery'
                        ? 'Neue Produkte'
                        : (item.region ?? '–')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SettingsPanel>
  );
}

/** Recommended product interval of both shops (settings::shop_readers). */
const RECOMMENDED_INTERVAL = 28800;

export default function FetchPanel({
  data,
  failed,
  loadedAt,
  intervals = {},
  onShops,
}: {
  data: FetchStatusResponse | null;
  failed: boolean;
  loadedAt: number | null;
  intervals?: Record<string, number>;
  onShops: () => void;
}) {
  if (!data)
    return (
      <p role="status" className="hint">
        {failed ? 'Der Abrufstatus konnte nicht gelesen werden.' : 'Abrufstatus wird geladen …'}
      </p>
    );
  if (data.shops.length === 0)
    return (
      <Panel>
        <EmptyState icon="activity" title="Noch kein Shop eingerichtet" headingLevel={3}>
          Sobald ein Key-Shop eingerichtet ist, siehst du hier Tagesbudget, nächste und letzte Abrufe.
        </EmptyState>
      </Panel>
    );
  const now = Date.now() / 1000;
  return (
    <>
      {failed && loadedAt !== null && (
        <p className="hint" role="status">
          Aktualisierung fehlgeschlagen · Stand {new Date(loadedAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr
        </p>
      )}
      {!data.paused_at && data.shops.map(shop => <DemandNote key={shop.source} shop={shop} interval={intervals[shop.source]} onShops={onShops} />)}
      <div className="shops">
        {data.shops.map(shop => (
          <ShopStatus key={shop.source} shop={shop} now={now} paused={!!data.paused_at} />
        ))}
      </div>
      {data.upcoming && <Upcoming items={data.upcoming} paused={!!data.paused_at || !!data.upcoming_paused} now={now} />}
      <Runs />
    </>
  );
}
