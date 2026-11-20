import { Button, EmptyState, Icon, Panel, Pill } from '../../components';
import type { FetchRun, FetchShopStatus, FetchStatusResponse } from '../../api';
import { relativeTime } from '../../time';
import { Dot, Facts, ShopMark, UsageBar } from './parts';
import { dateTimeText, durationText, kindText, outcomeText, outcomeTone, shopState, shopTitle, summarize, workerState } from './format';

function Tile({ label, value, note, tone }: { label: string; value: string; note: string; tone?: 'warn' | 'error' }) {
  return <div className={`set-tile${tone ? ` ${tone}` : ''}`}>
    <span className="label">{label}</span>
    <strong>{value}</strong>
    <span className="set-tile-note">{note}</span>
  </div>;
}

function ShopFacts({ shop, now }: { shop: FetchShopStatus; now: number }) {
  const state = shopState(shop, now, relativeTime);
  const worker = workerState(shop, now, relativeTime);
  const name = shopTitle(shop.source);
  const paused = shop.paused_until !== null && shop.paused_until > now;
  const { due, requested, products, searches } = shop.backlog;
  const tone = state.tone === 'ok' ? 'ok' : state.tone === 'off' ? 'default' : state.tone === 'warn' ? 'warn' : 'danger';
  return <Panel padded as="article" className="set-shop" aria-label={`Abrufstatus ${name}`}>
    <div className="set-shop-head">
      <span className="set-shop-id"><ShopMark id={shop.source} /><span><strong>{name}</strong><span className="set-shop-state"><Dot tone={state.tone} />{state.text}</span></span></span>
      <Pill tone={tone} icon={state.tone === 'ok' ? 'check' : state.tone === 'off' ? 'minus' : state.tone === 'warn' ? 'clock' : 'alert'}>
        {state.tone === 'ok' ? 'In Ordnung' : state.tone === 'off' ? (shop.enabled ? 'Noch kein Abruf' : 'Aus') : state.tone === 'warn' ? 'Pausiert' : 'Fehler'}
      </Pill>
    </div>
    <Facts items={[
      { label: 'Worker', value: <span className="set-inline"><Dot tone={worker.tone} />{worker.text}</span> },
      { label: 'Letzter Erfolg', value: shop.last_success_at === null ? 'Noch keiner' : <time dateTime={new Date(shop.last_success_at * 1000).toISOString()} title={dateTimeText(shop.last_success_at)}>{relativeTime(shop.last_success_at)}</time> },
      { label: 'Letzter Fehler', value: shop.last_error ? <span className="set-bad">{outcomeText(shop.last_error)}</span> : 'Keiner' },
      { label: 'Pausiert bis', value: paused ? `${new Date(shop.paused_until! * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr` : 'Nicht pausiert' },
      { label: 'Abrufe heute', value: shop.budget.limit > 0 ? <UsageBar used={shop.budget.used} limit={shop.budget.limit} label={`${name}: ${shop.budget.used} von ${shop.budget.limit} Abrufen heute`} /> : 'Kein Tageslimit' },
      { label: 'Rückstau', value: due === 0 ? 'Nichts fällig' : `${due} fällig · ${requested} angefordert · ${products} Produkte · ${searches} Suchen` },
      { label: 'Ältester fälliger Abruf', value: shop.oldest_due_at === null ? 'Keiner' : <span title={dateTimeText(shop.oldest_due_at)}>{relativeTime(shop.oldest_due_at)}</span> },
      { label: 'Nächster Abruf', value: shop.next_due_at === null ? 'Nichts geplant' : <span title={dateTimeText(shop.next_due_at)}>{shop.next_due_at <= now ? 'Fällig' : `${dateTimeText(shop.next_due_at)} Uhr`}</span> },
    ]} />
  </Panel>;
}

function RunsTable({ runs }: { runs: FetchRun[] }) {
  if (runs.length === 0) return <p className="set-hint">Noch keine Abrufe aufgezeichnet.</p>;
  return <div className="set-table" role="table" aria-label="Letzte Abrufe">
    <div role="rowgroup" className="set-thead"><div role="row">
      {['Zeit', 'Shop', 'Art', 'Detail', 'Ergebnis', 'Dauer'].map(head => <span key={head} role="columnheader" className="label">{head}</span>)}
    </div></div>
    <div role="rowgroup">{runs.map((run, index) => {
      const tone = outcomeTone(run.outcome);
      return <div role="row" key={`${run.started_at}-${index}`}>
        <span role="cell" className="set-c-time label" title={dateTimeText(run.started_at)}>{relativeTime(run.started_at)}</span>
        <span role="cell" className="set-c-shop">{shopTitle(run.source)}</span>
        <span role="cell" className="set-c-kind">{kindText(run.kind)}</span>
        <span role="cell" className="set-c-detail" title={run.detail ?? undefined}>{run.detail ?? '–'}</span>
        <span role="cell" className="set-c-result"><Pill tone={tone === 'ok' ? 'ok' : tone === 'warn' ? 'warn' : 'danger'} icon={tone === 'ok' ? 'check' : 'alert'}>{outcomeText(run.outcome)}</Pill></span>
        <span role="cell" className="set-c-duration label">{durationText(run.duration_ms)}</span>
      </div>;
    })}</div>
  </div>;
}

export default function FetchPanel({ data, failed, loadedAt, reload }: { data: FetchStatusResponse | null; failed: boolean; loadedAt: number | null; reload: () => void }) {
  if (!data) return <p role="status" className="set-muted">{failed ? 'Der Abrufstatus konnte nicht gelesen werden.' : 'Abrufstatus wird geladen …'}</p>;
  if (data.shops.length === 0) return <Panel padded><EmptyState icon="refresh" title="Noch kein Shop eingerichtet" headingLevel={3}>Sobald ein Key-Shop eingerichtet ist, siehst du hier Warteschlange, Tagesbudget und letzte Abrufe.</EmptyState></Panel>;
  const now = Date.now() / 1000;
  const sum = summarize(data.shops, data.errors_24h);
  const clock = loadedAt === null ? '' : new Date(loadedAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return <>
    <div className="set-fetch-bar">
      <span className="set-muted">{failed ? 'Aktualisierung fehlgeschlagen, Stand ' : 'Stand '}{clock} Uhr · aktualisiert sich alle 30 Sekunden</span>
      <Button variant="ghost" size="sm" onClick={reload}><Icon name="refresh" size={15} />Aktualisieren</Button>
    </div>
    <div className="set-tiles">
      <Tile label="Ausstehend" value={String(sum.due)} note={sum.due === 0 ? 'Nichts fällig' : `davon ${sum.requested} angefordert`} />
      <Tile label="Abrufe heute" value={sum.limit > 0 ? `${sum.used} von ${sum.limit}` : String(sum.used)} note={sum.limit > 0 && sum.used >= sum.limit ? 'Tagesbudget aufgebraucht' : 'Tagesbudget aller aktiven Shops'} tone={sum.limit > 0 && sum.used >= sum.limit ? 'warn' : undefined} />
      <Tile label="Ältester Abruf" value={sum.oldest ? relativeTime(sum.oldest.at) : 'Keiner'} note={sum.oldest ? `Seit dann fällig · ${shopTitle(sum.oldest.source)}` : 'Nichts überfällig'} />
      <Tile label="Fehler in 24 h" value={String(sum.errors24h)} note={sum.errors24h === 0 ? 'Keine fehlgeschlagenen Abrufe' : 'Fehlgeschlagene Abrufe'} tone={sum.errors24h > 0 ? 'error' : undefined} />
    </div>
    {data.shops.map(shop => <ShopFacts key={shop.source} shop={shop} now={now} />)}
    <Panel padded className="set-card" aria-labelledby="runs-title">
      <header className="set-card-head"><div><h2 id="runs-title">Letzte Abrufe</h2></div></header>
      <RunsTable runs={data.recent_runs} />
      <p className="set-hint">Jeder Shop wird nacheinander abgefragt, mit Pause zwischen Anfragen und unter Beachtung von robots.txt.</p>
    </Panel>
  </>;
}
