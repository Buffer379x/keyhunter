import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, HttpError } from '../api';
import { notify } from '../notify';
import type { AlertOverview } from '../api';
import { Button, Help, Icon, Inset, Label, Notice, Panel, PanelHead, Seg, Switch } from '../components';
import { SetupLink } from './PriceAlerts';
import type { AlertState, Rule } from './PriceAlerts';
import { channelLine } from './settings/channels';
import { money } from './price-format';

const parseEuro = (text: string): number => {
  const raw = text.trim().replace(',', '.');
  const [whole, fraction = ''] = raw.split('.');
  return /^\d{1,6}(\.\d{1,2})?$/.test(raw) ? Number(whole) * 100 + Number(fraction.padEnd(2, '0')) : 0;
};
const when = (seconds: number) => {
  const date = new Date(seconds * 1000);
  return `${date.toLocaleDateString('de-DE', { day: '2-digit', month: 'short' }).replace(/\.$/, '')} · ${date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`;
};
const deliveryNames: Record<string, string> = { pending: 'wartet auf Zustellung', sent: 'zugestellt', failed: 'Zustellung fehlgeschlagen', cancelled: 'verworfen' };

/**
 * Alarm: the rule of the saved edition (GET/PUT/DELETE /wishlist/{id}/alert) and its triggers from the delivery log.
 * Only the settings of the backend model: target price or new low, price basis, active. The backend counts offers that are
 * valid in the target country only, sends through every active channel and holds back a second message for the same game
 * within 24 hours.
 */
export default function AlarmTab({ id, alert, editionName, code, hasEstimates, onError }: {
  id: string; alert: AlertState; editionName: string; code: string; hasEstimates: boolean; onError: (error: unknown) => void;
}) {
  const { rule, ready, channels } = alert;
  const [mode, setMode] = useState<Rule['mode']>('target');
  const [basis, setBasis] = useState<Rule['basis']>('base');
  const [enabled, setEnabled] = useState(true);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  /** Results and errors are popups at the bottom right (0.9.1). */
  const setError = (text: string) => notify(text, 'error');
  const [events, setEvents] = useState<AlertOverview['events'] | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!ready || !rule) return;
    setMode(rule.mode); setBasis(rule.basis); setEnabled(rule.enabled);
    setTarget(rule.target_cents !== null ? (rule.target_cents / 100).toFixed(2).replace('.', ',') : '');
  }, [ready, rule]);
  useEffect(() => {
    const controller = new AbortController();
    void api<AlertOverview>('/alerts', 'GET', undefined, undefined, controller.signal)
      .then(data => { if (!controller.signal.aborted) setEvents(data.events.filter(event => event.wish_id === id)); })
      .catch(() => { if (!controller.signal.aborted) setEvents([]); });
    return () => controller.abort();
  }, [id, reload]);

  async function run(action: () => Promise<void>, success: string) {
    setBusy(true);
    try { await action(); notify(success); setReload(n => n + 1); }
    catch (err) { setError(err instanceof Error ? err.message : 'Alarmregel konnte nicht gespeichert werden.'); if (err instanceof HttpError && err.status === 401) onError(err); }
    finally { setBusy(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    const cents = parseEuro(target);
    if (mode === 'target' && (cents < 1 || cents > 10_000_000)) { setError('Gib einen Zielpreis zwischen 0,01 und 100.000,00 Euro ein.'); return; }
    await run(() => alert.save({ mode, basis, enabled, target_cents: mode === 'target' ? cents : null }), 'Alarmregel gespeichert.');
  }
  const showBasis = hasEstimates || basis === 'estimate';

  return <div className="grid-2">
    <Panel aria-labelledby="alarm-title">
      <PanelHead><Label id="alarm-title">Preisalarm · {editionName}</Label></PanelHead>
      <Inset>
        {!ready ? (alert.error ? <Notice error>{alert.error}</Notice> : <p role="status" className="muted pad">Alarmregel wird geladen …</p>)
          : <form className="form-grid" onSubmit={submit}>
            <div className="form-row"><span>Auslösen, wenn</span><Seg label="Auslöser" value={mode} onChange={setMode} options={[{ value: 'target', label: 'Zielpreis erreicht' }, { value: 'low', label: 'Neuer Tiefstpreis' }]} /></div>
            {mode === 'target' && <label className="form-row"><span>Zielpreis</span><span className="field target-field"><input inputMode="decimal" maxLength={10} required value={target} onChange={event => setTarget(event.target.value)} aria-label="Zielpreis" /><span className="muted">€</span></span></label>}
            {showBasis && <div className="form-row"><span>Preisgrundlage</span><Seg label="Preisgrundlage" value={basis} onChange={setBasis} options={[{ value: 'base', label: 'Grundpreis' }, { value: 'estimate', label: 'Gesamtpreis geschätzt' }]} /></div>}
            <Switch checked={enabled} onChange={setEnabled}>{mode === 'target' ? `Benachrichtigen, wenn ein in ${code} aktivierbarer Key das Ziel erreicht` : `Benachrichtigen bei einem neuen Tiefstpreis eines in ${code} aktivierbaren Keys`}</Switch>
            <div className="with-help"><span className="hint">{channelLine(channels)}{!channels.length && <> · die Regel wird trotzdem gespeichert · <SetupLink /></>}</span>
              <Help label="Hilfe zum Preisalarm">Es zählen nur in {code} aktivierbare Keys; {mode === 'target' ? 'der Alarm kommt, wenn der Preis auf oder unter das Ziel fällt' : 'der Alarm kommt bei jedem neuen Tiefstpreis seit dem Speichern'}, höchstens einmal je Spiel in 24 Stunden.</Help></div>
            <div className="actions">
              <Button type="submit" variant="primary" loading={busy}>Speichern</Button>
              {rule && <Button variant="ghost" disabled={busy} onClick={() => void run(async () => { await alert.remove(); setTarget(''); setMode('target'); setBasis('base'); setEnabled(true); }, 'Alarmregel entfernt.')}>Alarm entfernen</Button>}
            </div>
          </form>}
      </Inset>
    </Panel>
    <Panel aria-labelledby="triggers-title">
      <PanelHead><Label id="triggers-title">Auslösungen</Label></PanelHead>
      <Inset><ul className="facts">
        {events === null ? <li><Icon name="clock" /><span>Wird geladen …</span></li>
          : events.length === 0 ? <li><Icon name="info" /><span>{rule ? 'Dieser Alarm hat noch nicht ausgelöst.' : 'Noch kein Alarm gespeichert.'}</span></li>
          : events.map(event => <li key={event.id} className={event.state === 'sent' ? 'ok' : event.state === 'failed' ? 'warn' : ''}>
            <Icon name="bell" /><span>Ausgelöst bei {event.cents !== null ? money(event.cents) : 'unbekanntem Preis'} · {deliveryNames[event.state] ?? event.state}</span>
            <span className="r mono muted">{when(event.sent_at ?? event.observed_at)}</span></li>)}
      </ul></Inset>
    </Panel>
  </div>;
}
