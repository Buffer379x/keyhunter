import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, HttpError } from '../api';
import { Button, Notice, PageHeading } from '../components';

type Rule = { mode: 'target' | 'low'; basis: 'base' | 'estimate'; target_cents: number | null; enabled: boolean };
type RuleView = Rule & { wish_id: string; title: string; delivery: string | null };
type Event = { id: number; wish_id: string | null; state: string; observed_at: number; sent_at: number | null; cents: number | null; attempts: number };
type Overview = { configured: boolean; rules: RuleView[]; events: Event[] };
const deliveryNames: Record<string, string> = { pending: 'Wartet auf Zustellung', sent: 'Zugestellt', failed: 'Zustellung fehlgeschlagen', cancelled: 'Verworfen' };
const showMoney = (cents: number) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(cents / 100);

export function AlertEditor({ id, csrf, targetLabel, onError }: { id: string; csrf: string; targetLabel: string; onError: (error: unknown) => void }) {
  const [ready, setReady] = useState(false);
  const [exists, setExists] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [mode, setMode] = useState<Rule['mode']>('target');
  const [basis, setBasis] = useState<Rule['basis']>('base');
  const [enabled, setEnabled] = useState(true);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const path = `/wishlist/${encodeURIComponent(id)}/alert`;

  useEffect(() => {
    const controller = new AbortController();
    void api<{ rule: Rule | null; configured: boolean }>(path, 'GET', undefined, undefined, controller.signal).then(data => {
      if (controller.signal.aborted) return;
      setConfigured(data.configured);
      if (data.rule) {
        setExists(true); setMode(data.rule.mode); setBasis(data.rule.basis); setEnabled(data.rule.enabled);
        if (data.rule.target_cents !== null) setTarget((data.rule.target_cents / 100).toFixed(2).replace('.', ','));
      }
      setReady(true);
    }).catch(err => {
      if (!controller.signal.aborted) { setError(err.message); onError(err); }
    });
    return () => controller.abort();
  }, [path, onError]);

  async function save(event: FormEvent) {
    event.preventDefault();
    const raw = target.trim().replace(',', '.');
    const [whole, fraction = ''] = raw.split('.');
    const cents = /^\d{1,6}(\.\d{1,2})?$/.test(raw) ? Number(whole) * 100 + Number(fraction.padEnd(2, '0')) : 0;
    if (mode === 'target' && (cents < 1 || cents > 10_000_000)) { setError('Gib einen Zielpreis zwischen 0,01 und 100.000,00 Euro ein.'); return; }
    await write('PUT', { mode, basis, enabled, target_cents: mode === 'target' ? cents : null });
  }
  async function write(method: string, body?: Rule) {
    setBusy(true); setError(''); setMessage('');
    try {
      await api(path, method, body, csrf);
      setExists(method === 'PUT'); setMessage(method === 'PUT' ? 'Alarmregel gespeichert.' : 'Alarmregel entfernt.');
    } catch (err) { setError(err instanceof Error ? err.message : 'Alarmregel konnte nicht gespeichert werden.'); onError(err); }
    finally { setBusy(false); }
  }

  return <section className="offer-section" aria-labelledby="alert-editor-title">
    <h3 id="alert-editor-title">Preisalarm</h3>
    <p className="field-help">Gilt für die gewählte Edition und Xbox-Plattform sowie das Zielland {targetLabel}.</p>
    {ready && !configured && <p className="field-help">Der ntfy-Kanal ist noch nicht eingerichtet. Regeln können bereits gespeichert werden.</p>}
    {error && <Notice error>{error}</Notice>}{message && <Notice>{message}</Notice>}
    {ready && <form className="alert-form" onSubmit={save}>
      <div className="field"><label htmlFor="alert-mode">Auslöser</label><select id="alert-mode" value={mode} onChange={e => setMode(e.target.value as Rule['mode'])}><option value="target">Zielpreis erreicht</option><option value="low">Neuer beobachteter Tiefstpreis</option></select></div>
      <div className="field"><label htmlFor="alert-basis">Preisgrundlage</label><select id="alert-basis" value={basis} onChange={e => setBasis(e.target.value as Rule['basis'])}><option value="base">Grundpreis</option><option value="estimate">Geschätzter Gesamtpreis</option></select></div>
      {mode === 'target' && <div className="field"><label htmlFor="alert-price">Zielpreis (€)</label><input id="alert-price" inputMode="decimal" maxLength={10} value={target} onChange={e => setTarget(e.target.value)} required /></div>}
      <label className="check-label"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />Alarm aktiv</label>
      <div className="offer-actions"><Button type="submit" disabled={busy}>{exists ? 'Alarmregel speichern' : 'Alarm anlegen'}</Button>
        {exists && <Button secondary disabled={busy} onClick={() => void write('DELETE')}>Alarm entfernen</Button>}</div>
    </form>}
  </section>;
}

export default function PriceAlerts({ csrf, onError }: { csrf: string; onError: (error: unknown) => void }) {
  const [loadError, setLoadError] = useState('');
  const [data, setData] = useState<Overview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: number;
    async function load() {
      try {
        const current = await api<Overview>('/alerts', 'GET', undefined, undefined, controller.signal);
        if (controller.signal.aborted) return;
        setData(current);
        setLoadError('');
        if (current.configured && current.events.some(row => row.state === 'pending')) timer = window.setTimeout(() => void load(), 5000);
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof HttpError && error.status === 401) onError(error);
        else setLoadError(error instanceof Error ? error.message : 'Preisalarme konnten nicht geladen werden.');
      }
    }
    void load();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [reload, onError]);
  async function testChannel() {
    setBusy(true); setMessage('');
    try { await api('/alerts/test', 'POST', undefined, csrf); setMessage('Testnachricht zur Zustellung vorgemerkt.'); setReload(n => n + 1); }
    catch (error) { onError(error); }
    finally { setBusy(false); }
  }
  return <>
    <PageHeading title="Preisalarme" />
    {loadError && <Notice error>{loadError} <Button secondary onClick={() => setReload(n => n + 1)}>Erneut laden</Button></Notice>}
    <section className="offer-section" aria-labelledby="channel-title"><h2 id="channel-title">ntfy</h2>
      <p>{data?.configured ? 'Kanal eingerichtet' : data ? 'Kanal noch nicht eingerichtet' : 'Kanalstatus wird geladen …'}</p>
      <Button secondary disabled={!data?.configured || busy} onClick={() => void testChannel()}>Testnachricht senden</Button>
      {message && <Notice>{message}</Notice>}
    </section>
    <section className="offer-section" aria-labelledby="rules-title"><h2 id="rules-title">Alarmregeln</h2>
      {data && data.rules.length === 0 && <p>Du kannst eine Alarmregel im Detail eines Wunschspiels anlegen.</p>}
      <ul className="alert-list">{data?.rules.map(rule => <li key={rule.wish_id}>
        <a className="source-link" href={`?item=${encodeURIComponent(rule.wish_id)}#alert-editor-title`}>{rule.title}</a>
        <span>{rule.enabled ? 'Aktiv' : 'Pausiert'} · {rule.target_cents !== null ? showMoney(rule.target_cents) : 'Neuer Tiefstpreis'} · {rule.basis === 'base' ? 'Grundpreis' : 'Geschätzter Gesamtpreis'}</span>
        <span>{rule.delivery && deliveryNames[rule.delivery]}</span>
      </li>)}</ul>
    </section>
    <section className="offer-section" aria-labelledby="deliveries-title"><h2 id="deliveries-title">Letzte Zustellungen</h2>
      {data && data.events.length === 0 && <p>Es liegt noch kein Zustellversuch vor.</p>}
      <ul className="alert-list">{data?.events.map(event => <li key={event.id}>
        <strong>{event.wish_id ? data.rules.find(rule => rule.wish_id === event.wish_id)?.title  ?? 'Ehemaliger Wunschlisteneintrag' : 'Testnachricht'}</strong>
        <span>{new Date((event.sent_at ?? event.observed_at) * 1000).toLocaleString('de-DE')} · {deliveryNames[event.state]}{event.attempts > 0 && ` · ${event.attempts} Versuch(e)`}</span>
      </li>)}</ul>
    </section>
  </>;
}
