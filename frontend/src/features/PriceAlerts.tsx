import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, HttpError } from '../api';
import type { PriceBadgeData } from '../api';
import { Button, Card, Chip, EmptyState, Icon, MonoLabel, Notice, PageHeading, Price, SegmentedControl, Switch } from '../components';
import { whenVisible } from '../poll';
import { relativeTime } from '../time';
import { money } from './price-format';

export type Rule = { mode: 'target' | 'low'; basis: 'base' | 'estimate'; target_cents: number | null; enabled: boolean };
type RuleView = Rule & { wish_id: string; title: string; delivery: string | null };
export type AlertEvent = { id: number; wish_id: string | null; state: string; observed_at: number; sent_at: number | null; cents: number | null; attempts: number };
type Overview = { configured: boolean; rules: RuleView[]; events: AlertEvent[] };
const deliveryNames: Record<string, string> = { pending: 'Wartet auf Zustellung', sent: 'Zugestellt', failed: 'Zustellung fehlgeschlagen', cancelled: 'Verworfen' };
const deliveryChip = (state: string) => <Chip kind={state === 'sent' ? 'best' : state === 'failed' ? 'danger' : state === 'pending' ? 'warn' : 'neutral'} icon={state === 'sent' ? 'check' : state === 'pending' ? 'clock' : undefined}>{deliveryNames[state] ?? state}</Chip>;
const shortDate = (seconds: number) => new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(seconds * 1000).replace(',', ' ·');
const basisName = (basis: Rule['basis']) => basis === 'base' ? 'Grundpreis' : 'Gesamtpreis geschätzt';

/** Cents of a rule's target, when it is a price alert. */
export const ruleTarget = (rule: Rule | null | undefined) => rule && rule.mode === 'target' ? rule.target_cents : null;
/** "Ziel erreicht": an active price alert whose target is met by the best price on the rule's basis. */
export const targetReached = (rule: Rule | null | undefined, cents: number | null | undefined) => {
  const target = ruleTarget(rule);
  return !!rule?.enabled && target !== null && cents !== null && cents !== undefined && cents <= target;
};

/** The alert rule of one wishlist item (GET/PUT/DELETE /wishlist/{id}/alert). */
export function useAlertRule(id: string, csrf: string, onError: (error: unknown) => void) {
  const [rule, setRule] = useState<Rule | null>(null);
  const [configured, setConfigured] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const path = `/wishlist/${encodeURIComponent(id)}/alert`;
  useEffect(() => {
    const controller = new AbortController();
    setReady(false); setRule(null);
    void api<{ rule: Rule | null; configured: boolean }>(path, 'GET', undefined, undefined, controller.signal).then(data => {
      if (controller.signal.aborted) return;
      setConfigured(data.configured); setRule(data.rule); setReady(true);
    }).catch(err => { if (!controller.signal.aborted) { setError(err instanceof Error ? err.message : 'Alarmregel konnte nicht geladen werden.'); onError(err); } });
    return () => controller.abort();
  }, [path, onError]);
  const save = useCallback(async (next: Rule) => { await api(path, 'PUT', next, csrf); setRule(next); }, [path, csrf]);
  const remove = useCallback(async () => { await api(path, 'DELETE', undefined, csrf); setRule(null); }, [path, csrf]);
  return { rule, configured, ready, error, save, remove };
}
export type AlertState = ReturnType<typeof useAlertRule>;

function parseEuro(text: string): number {
  const raw = text.trim().replace(',', '.');
  const [whole, fraction = ''] = raw.split('.');
  return /^\d{1,6}(\.\d{1,2})?$/.test(raw) ? Number(whole) * 100 + Number(fraction.padEnd(2, '0')) : 0;
}

export function AlertEditor({ id, alert, editionName, targetLabel, onSettings, onError }: { id: string; alert: AlertState; editionName: string; targetLabel: string; onSettings: () => void; onError: (error: unknown) => void }) {
  const { rule, ready, configured } = alert;
  const [mode, setMode] = useState<Rule['mode']>('target');
  const [basis, setBasis] = useState<Rule['basis']>('base');
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [events, setEvents] = useState<AlertEvent[] | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!ready) return;
    if (rule) {
      setMode(rule.mode); setBasis(rule.basis);
      setTarget(rule.target_cents !== null ? (rule.target_cents / 100).toFixed(2).replace('.', ',') : '');
    }
  }, [ready, rule]);
  useEffect(() => {
    const controller = new AbortController();
    void api<Overview>('/alerts', 'GET', undefined, undefined, controller.signal)
      .then(data => { if (!controller.signal.aborted) setEvents(data.events.filter(event => event.wish_id === id)); })
      .catch(() => { if (!controller.signal.aborted) setEvents([]); });
    return () => controller.abort();
  }, [id, reload]);

  async function run(action: () => Promise<void>, success: string) {
    setBusy(true); setError(''); setMessage('');
    try { await action(); setMessage(success); setReload(n => n + 1); }
    catch (err) { setError(err instanceof Error ? err.message : 'Alarmregel konnte nicht gespeichert werden.'); if (err instanceof HttpError && err.status === 401) onError(err); }
    finally { setBusy(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    const cents = parseEuro(target);
    if (mode === 'target' && (cents < 1 || cents > 10_000_000)) { setError('Gib einen Zielpreis zwischen 0,01 und 100.000,00 Euro ein.'); return; }
    await run(() => alert.save({ mode, basis, enabled: rule?.enabled ?? true, target_cents: mode === 'target' ? cents : null }), 'Alarmregel gespeichert.');
  }
  const toggle = (enabled: boolean) => rule && void run(() => alert.save({ ...rule, enabled }), enabled ? 'Alarm ist aktiv.' : 'Alarm ist pausiert.');

  return <div className="alert-layout">
    <Card className="alert-card" aria-labelledby="alert-editor-title">
      <div className="alert-card-head">
        <h3 id="alert-editor-title">Preisalarm für {editionName}</h3>
        {rule && <Switch checked={rule.enabled} onChange={toggle} disabled={busy}>Alarm aktiv</Switch>}
      </div>
      <p className="field-help">Gilt für die gewählte Edition und das Zielland {targetLabel}. Nur Angebote, die dort aktivierbar sind, lösen aus.</p>
      {alert.error && <Notice error>{alert.error}</Notice>}
      {error && <Notice error>{error}</Notice>}{message && <Notice>{message}</Notice>}
      {ready ? <form className="alert-form" onSubmit={submit}>
        <div className="field"><span className="field-label" id="alert-mode-label">Auslösen, wenn</span>
          <SegmentedControl label="Auslöser" className="wide" value={mode} onChange={setMode} options={[{ value: 'target', label: 'Zielpreis erreicht' }, { value: 'low', label: 'Neuer Tiefstpreis' }]} /></div>
        <div className="alert-row">
          {mode === 'target' && <div className="field"><label htmlFor="alert-price">Zielpreis</label><span className="euro-input"><input id="alert-price" inputMode="decimal" maxLength={10} value={target} onChange={e => setTarget(e.target.value)} required aria-describedby="alert-price-unit" /><span id="alert-price-unit" aria-label="Euro">€</span></span></div>}
          <div className="field"><span className="field-label">Preisgrundlage</span>
            <SegmentedControl label="Preisgrundlage" className="wide" value={basis} onChange={setBasis} options={[{ value: 'base', label: 'Grundpreis' }, { value: 'estimate', label: 'Gesamtpreis geschätzt' }]} /></div>
        </div>
        <div className="channel-note"><span className={`channel-dot ${configured ? 'on' : 'off'}`} aria-hidden="true" />
          <span>{configured ? 'Benachrichtigung über ntfy · eingerichtet' : 'ntfy ist noch nicht eingerichtet. Du kannst die Regel trotzdem speichern.'}</span>
          <button type="button" className="text-button" onClick={onSettings}>Kanal verwalten</button></div>
        <div className="alert-actions">
          <Button type="submit" loading={busy}>{rule ? 'Speichern' : 'Alarm anlegen'}</Button>
          {rule && <Button variant="danger" disabled={busy} onClick={() => void run(alert.remove, 'Alarmregel entfernt.')}>Alarm entfernen</Button>}
        </div>
      </form> : !alert.error && <p role="status">Alarmregel wird geladen …</p>}
    </Card>
    <Card className="alert-card" aria-labelledby="alert-events-title">
      <h3 id="alert-events-title">Auslösungen</h3>
      {events === null ? <p role="status">Wird geladen …</p> : events.length === 0 ? <p className="field-help">Dieser Alarm hat noch nicht ausgelöst.</p> :
        <ul className="event-list">{events.map(event => <li key={event.id}>
          <span><MonoLabel>{shortDate(event.sent_at ?? event.observed_at)}</MonoLabel><strong>{event.cents !== null ? money(event.cents) : 'Preis unbekannt'}</strong></span>
          {deliveryChip(event.state)}
        </li>)}</ul>}
      <p className="field-help">Höchstens eine Nachricht je Spiel und 24 Stunden.</p>
    </Card>
  </div>;
}

export default function PriceAlerts({ csrf, onError }: { csrf: string; onError: (error: unknown) => void }) {
  const [loadError, setLoadError] = useState('');
  const [data, setData] = useState<Overview | null>(null);
  const [badges, setBadges] = useState<Record<string, PriceBadgeData>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let cancel = () => {};
    async function load() {
      try {
        const current = await api<Overview>('/alerts', 'GET', undefined, undefined, controller.signal);
        if (controller.signal.aborted) return;
        setData(current);
        setLoadError('');
        if (current.configured && current.events.some(row => row.state === 'pending')) cancel = whenVisible(() => void load(), 5000);
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof HttpError && error.status === 401) onError(error);
        else setLoadError(error instanceof Error ? error.message : 'Preisalarme konnten nicht geladen werden.');
      }
    }
    void load();
    api<Record<string, PriceBadgeData>>('/wishlist/price-badges', 'GET', undefined, undefined, controller.signal).then(rows => { if (!controller.signal.aborted) setBadges(rows); }).catch(() => {});
    return () => { controller.abort(); cancel(); };
  }, [reload, onError]);
  async function testChannel() {
    setBusy(true); setMessage('');
    try { await api('/alerts/test', 'POST', undefined, csrf); setMessage('Testnachricht zur Zustellung vorgemerkt.'); setReload(n => n + 1); }
    catch (error) { onError(error); }
    finally { setBusy(false); }
  }
  const lastEvent = (wishId: string) => data?.events.find(event => event.wish_id === wishId);
  return <section className="alerts-page">
    <PageHeading title="Preisalarme" />
    {loadError && <Notice error>{loadError} <Button secondary onClick={() => setReload(n => n + 1)}>Erneut laden</Button></Notice>}
    <Card className="alert-card channel-card" aria-labelledby="channel-title">
      <div>
        <h2 id="channel-title">ntfy</h2>
        <p className="channel-state"><span className={`channel-dot ${data?.configured ? 'on' : 'off'}`} aria-hidden="true" />{data?.configured ? 'Kanal eingerichtet' : data ? 'Kanal noch nicht eingerichtet' : 'Kanalstatus wird geladen …'}</p>
      </div>
      <Button secondary disabled={!data?.configured || busy} onClick={() => void testChannel()}>Testnachricht senden</Button>
      {message && <Notice>{message}</Notice>}
    </Card>
    <h2 id="rules-title" className="alerts-heading">Alarmregeln</h2>
    {data && data.rules.length === 0 && <EmptyState icon="bell" title="Noch kein Alarm">Lege im Detail eines Wunschspiels einen Alarm an. Er meldet sich, wenn ein Preis dein Ziel erreicht.</EmptyState>}
    <ul className="rule-list" aria-labelledby="rules-title">{data?.rules.map(rule => {
      const badge = badges[rule.wish_id];
      const current = badge?.state === 'price' && badge.cents ? badge.cents : null;
      const target = ruleTarget(rule);
      const reached = rule.enabled && target !== null && current !== null && current <= target;
      const event = lastEvent(rule.wish_id);
      return <li key={rule.wish_id}><Card as="div" className="rule-card">
        <div className="rule-main">
          <a className="rule-title" href={`?item=${encodeURIComponent(rule.wish_id)}&tab=alarm`}>{rule.title}</a>
          <span className="rule-meta">{rule.enabled ? 'Aktiv' : 'Pausiert'} · {target !== null ? `Ziel ${money(target)}` : 'Neuer Tiefstpreis'} · {basisName(rule.basis)}</span>
          <span className="rule-chips">{reached && <Chip kind="target">Ziel erreicht</Chip>}{!rule.enabled && <Chip kind="neutral" icon="clock">Pausiert</Chip>}{badge?.stale && <Chip kind="stale">Veraltet</Chip>}</span>
        </div>
        <div className="rule-price">
          <span className="rule-price-label"><MonoLabel>Aktuell</MonoLabel></span>
          <Price cents={current} size="sm" tone={badge?.stale ? 'stale' : 'default'} missing={badge ? 'kein aktueller Preis' : 'wird geladen …'} />
          {target !== null && current !== null && <span className={`rule-delta ${reached ? 'reached' : ''}`}>{current <= target ? `${money(target - current)} unter Ziel` : `${money(current - target)} über Ziel`}</span>}
        </div>
        <div className="rule-delivery">
          <span className="rule-price-label"><MonoLabel>Letzte Auslösung</MonoLabel></span>
          {event ? <><span>{shortDate(event.sent_at ?? event.observed_at)} · {event.cents !== null ? money(event.cents) : ''}</span>{deliveryChip(event.state)}</> : <span className="field-help">noch keine</span>}
          {!event && rule.delivery && deliveryChip(rule.delivery)}
        </div>
      </Card></li>;
    })}</ul>
    <h2 id="deliveries-title" className="alerts-heading">Letzte Zustellungen</h2>
    {data && data.events.length === 0 && <p className="field-help">Es liegt noch kein Zustellversuch vor.</p>}
    <ul className="event-list wide" aria-labelledby="deliveries-title">{data?.events.map(event => <li key={event.id}>
      <span><strong>{event.wish_id ? data.rules.find(rule => rule.wish_id === event.wish_id)?.title ?? 'Ehemaliger Wunschlisteneintrag' : 'Testnachricht'}</strong>
        <MonoLabel title={new Date((event.sent_at ?? event.observed_at) * 1000).toLocaleString('de-DE')}>{relativeTime(event.sent_at ?? event.observed_at)}{event.attempts > 0 && ` · ${event.attempts} Versuch(e)`}</MonoLabel></span>
      {deliveryChip(event.state)}
    </li>)}</ul>
  </section>;
}
