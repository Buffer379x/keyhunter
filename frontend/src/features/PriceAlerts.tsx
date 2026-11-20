import { useCallback, useEffect, useState } from 'react';
import { api, HttpError } from '../api';
import type { PriceBadgeData, WishlistItem } from '../api';
import { Button, EmptyState, Icon, Inset, Label, Notice, PageHeading, Panel, PanelHead, Pill, Price } from '../components';
import { alarmRows } from './alerts-model';
import type { AlarmRow } from './alerts-model';
import { Cover } from './catalog-ui';
import { whenVisible } from '../poll';
import { relativeTime } from '../time';
import { money } from './price-format';

export type Rule = { mode: 'target' | 'low'; basis: 'base' | 'estimate'; target_cents: number | null; enabled: boolean };
type RuleView = Rule & { wish_id: string; title: string; delivery: string | null };
export type AlertEvent = { id: number; wish_id: string | null; state: string; observed_at: number; sent_at: number | null; cents: number | null; attempts: number };
type Overview = { configured: boolean; rules: RuleView[]; events: AlertEvent[] };
const deliveryNames: Record<string, string> = { pending: 'Wartet auf Zustellung', sent: 'Zugestellt', failed: 'Zustellung fehlgeschlagen', cancelled: 'Verworfen' };
const deliveryChip = (state: string) => <Pill tone={state === 'sent' ? 'ok' : state === 'failed' ? 'danger' : state === 'pending' ? 'warn' : 'default'} icon={state === 'sent' ? 'check' : state === 'pending' ? 'clock' : state === 'failed' ? 'alert' : 'minus'}>{deliveryNames[state] ?? state}</Pill>;
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

/** In-app link to the alarm tab of a wishlist item: the wishlist reads ?item and ?tab, App follows the URL through popstate. */
const alarmHref = (id: string) => `?item=${encodeURIComponent(id)}&tab=alarm`;
function openAlarm(id: string) {
  const url = new URL(window.location.href);
  url.search = alarmHref(id); url.hash = '';
  window.history.pushState(null, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function AlarmStatus({ row, mode }: { row: AlarmRow; mode: Rule['mode'] }) {
  if (row.reached) return <Pill tone="ok" icon="check">Ziel erreicht</Pill>;
  if (!row.enabled) return <Pill tone="dim" icon="clock">Pausiert</Pill>;
  if (mode === 'low') return <Pill tone="dim" icon="bell">Neuer Tiefstpreis</Pill>;
  if (row.current === null) return <Pill tone="dim">Kein Preis</Pill>;
  return <Pill>{money(row.distance ?? 0)} über Ziel</Pill>;
}

/** Preisalarme (prototype viewAlarms): every target sorted by distance, each row opens the alarm tab of the game. Channel test and delivery log below. */
export default function PriceAlerts({ csrf, targetCountry, targetLabel, onError }: { csrf: string; targetCountry: string | null; targetLabel: string; onError: (error: unknown) => void }) {
  const [loadError, setLoadError] = useState('');
  const [data, setData] = useState<Overview | null>(null);
  const [badges, setBadges] = useState<Record<string, PriceBadgeData>>({});
  const [items, setItems] = useState<Record<string, WishlistItem>>({});
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
    // Covers and editions for the game column.
    api<WishlistItem[]>('/wishlist', 'GET', undefined, undefined, controller.signal).then(rows => { if (!controller.signal.aborted) setItems(Object.fromEntries(rows.map(row => [row.id, row]))); }).catch(() => {});
    return () => { controller.abort(); cancel(); };
  }, [reload, onError]);
  async function testChannel() {
    setBusy(true); setMessage('');
    try { await api('/alerts/test', 'POST', undefined, csrf); setMessage('Testnachricht zur Zustellung vorgemerkt.'); setReload(n => n + 1); }
    catch (error) { onError(error); }
    finally { setBusy(false); }
  }
  const rules = data?.rules ?? [];
  const rows = alarmRows(rules, badges);
  const ruleOf = (id: string) => rules.find(rule => rule.wish_id === id);
  const country = targetCountry ?? 'Zielland';
  const channel = data ? <Pill tone={data.configured ? 'ok' : 'dim'} icon={data.configured ? 'check' : 'minus'}>{data.configured ? 'ntfy eingerichtet' : 'ntfy nicht eingerichtet'}</Pill> : null;
  return <section className="page alerts-page" aria-labelledby="alerts-title">
    <PageHeading id="alerts-title" title="Preisalarme" sub={`Benachrichtigung über ntfy, sobald ein in ${targetLabel} aktivierbarer Key das Ziel erreicht`}
      actions={<>{channel}<Button disabled={!data?.configured || busy} loading={busy} onClick={() => void testChannel()}><Icon name="send" />Testnachricht senden</Button></>} />
    {loadError && <Notice error>{loadError} <Button size="sm" onClick={() => setReload(n => n + 1)}>Erneut laden</Button></Notice>}
    {message && <Notice>{message}</Notice>}
    <Panel aria-labelledby="rules-title">
      <PanelHead><Label as="h2" tone="soft" id="rules-title">Alle Ziele · nach Abstand</Label></PanelHead>
      <Inset className="table-wrap">
        {!data ? <p className="hint alarm-pad" role="status">{loadError ? 'Nicht geladen.' : 'Preisalarme werden geladen …'}</p>
          : rows.length === 0 ? <EmptyState icon="bell" title="Noch kein Alarm" headingLevel={3}>Lege im Detail eines Wunschspiels einen Alarm an. Er meldet sich, wenn ein Preis dein Ziel erreicht.</EmptyState>
            : <table className="alarm-table" aria-label="Preisalarme nach Abstand">
              <thead><tr><th>Spiel</th><th className="r">Ziel</th><th className="r">Jetzt {country}</th><th className="r">Abstand</th><th>Status</th></tr></thead>
              <tbody>{rows.map(row => {
                const rule = ruleOf(row.id);
                const item = items[row.id];
                const sub = [item?.game?.edition_name, rule?.basis === 'estimate' && basisName(rule.basis)].filter(Boolean).join(' · ');
                return <tr key={row.id} className="click" onClick={() => openAlarm(row.id)}>
                  <td className="c-game"><div className="game-cell"><Cover src={item?.game?.cover_url ?? null} title={row.title} />
                    <div><a className="alarm-title" href={alarmHref(row.id)} onClick={event => { event.preventDefault(); event.stopPropagation(); openAlarm(row.id); }}>{row.title}</a><small>{sub}</small></div></div></td>
                  <td className="r mono c-target">{row.target !== null ? money(row.target) : '–'}</td>
                  <td className="r c-now"><Price cents={row.current} tone={row.stale ? 'stale' : 'default'} missing="–" /></td>
                  <td className="r c-dist">{row.distance !== null ? <span className={`save${row.distance <= 0 ? ' reached' : ''}`}>{row.distance <= 0 ? '−' : '+'}{money(Math.abs(row.distance))}</span> : <span className="save none">–</span>}</td>
                  <td className="c-status">{rule && <AlarmStatus row={row} mode={rule.mode} />}</td>
                </tr>;
              })}</tbody>
            </table>}
      </Inset>
    </Panel>
    <Panel aria-labelledby="deliveries-title">
      <PanelHead><Label as="h2" tone="soft" id="deliveries-title">Letzte Zustellungen</Label></PanelHead>
      <Inset className="table-wrap">
        {!data || data.events.length === 0 ? <p className="hint alarm-pad">{data ? 'Es liegt noch kein Zustellversuch vor.' : 'Wird geladen …'}</p>
          : <table className="delivery-table" aria-label="Letzte Zustellungen">
            <thead><tr><th>Zeit</th><th>Spiel</th><th className="r">Preis</th><th>Zustellung</th></tr></thead>
            <tbody>{data.events.map(event => {
              const at = event.sent_at ?? event.observed_at;
              return <tr key={event.id}>
                <td className="mono c-time" title={new Date(at * 1000).toLocaleString('de-DE')}>{relativeTime(at)}{event.attempts > 1 && <span className="faint"> · {event.attempts} Versuche</span>}</td>
                <td className="c-game">{event.wish_id ? ruleOf(event.wish_id)?.title ?? 'Ehemaliger Wunschlisteneintrag' : 'Testnachricht'}</td>
                <td className="r mono c-price">{event.cents !== null ? money(event.cents) : '–'}</td>
                <td className="c-status">{deliveryChip(event.state)}</td>
              </tr>;
            })}</tbody>
          </table>}
      </Inset>
    </Panel>
  </section>;
}
