import { useCallback, useEffect, useState } from 'react';
import { api, sessionEnded } from '../api';
import type { AlertDelivery, PriceBadgeData, WishlistItem } from '../api';
import { Button, Cover, EmptyState, Icon, StatePill, Inset, Label, Notice, PageHeading, Panel, PanelHead, Pill, Price } from '../components';
import { alarmRows } from './alerts-model';
import { platformName } from './catalog-ui';
import type { AlarmRow } from './alerts-model';
import { whenVisible } from '../poll';
import { relativeTime } from '../time';
import { money } from './price-format';
import { channelLine } from './settings/channels';
import { navigate, openSection } from '../route';
import { notify, notifyError } from '../notify';

export type Rule = { mode: 'target' | 'low'; basis: 'base' | 'estimate'; target_cents: number | null; enabled: boolean };
type RuleView = Rule & { wish_id: string; title: string; delivery: string | null };
type AlertEvent = {
  id: number;
  wish_id: string | null;
  state: string;
  observed_at: number;
  sent_at: number | null;
  cents: number | null;
  attempts: number;
  deliveries?: AlertDelivery[];
};
type Overview = { configured: boolean; channels?: string[]; rules: RuleView[]; events: AlertEvent[] };
const deliveryNames: Record<string, string> = {
  pending: 'Wartet auf Zustellung',
  sent: 'Zugestellt',
  failed: 'Zustellung fehlgeschlagen',
  cancelled: 'Verworfen',
};
const deliveryChip = (state: string) => (
  <Pill
    tone={state === 'sent' ? 'ok' : state === 'failed' ? 'danger' : state === 'pending' ? 'warn' : 'default'}
    icon={state === 'sent' ? 'check' : state === 'pending' ? 'clock' : state === 'failed' ? 'alert' : 'minus'}
  >
    {deliveryNames[state] ?? state}
  </Pill>
);
const channelStates: Record<string, string> = { pending: 'wartet', sent: 'zugestellt', failed: 'fehlgeschlagen', cancelled: 'verworfen' };
/** "Telegram zugestellt · E-Mail fehlgeschlagen (HTTP 401 · Unauthorized)". */
const deliveryLine = (deliveries: AlertDelivery[]) => (
  <small className="muted delivery-channels">
    {deliveries.map((d, i) => (
      <span key={d.channel}>
        {i > 0 && ' · '}
        {d.name} {channelStates[d.state] ?? d.state}
        {d.state === 'failed' && d.error && ` (${d.error})`}
      </span>
    ))}
  </small>
);
/** Way to Einstellungen › Benachrichtigungen when no channel is set up. */
export const SetupLink = () => (
  <a
    className="text-button"
    href="?view=settings&section=notifications"
    onClick={event => {
      event.preventDefault();
      openSection('notifications');
    }}
  >
    Kanal einrichten
  </a>
);
const basisName = (basis: Rule['basis']) => (basis === 'base' ? 'Grundpreis' : 'Gesamtpreis geschätzt');

/** Cents of a rule's target, when it is a price alert. */
export const ruleTarget = (rule: Rule | null | undefined) => (rule && rule.mode === 'target' ? rule.target_cents : null);
/** "Ziel erreicht": an active price alert whose target is met by the best price on the rule's basis. */
export const targetReached = (rule: Rule | null | undefined, cents: number | null | undefined) => {
  const target = ruleTarget(rule);
  return !!rule?.enabled && target !== null && cents !== null && cents !== undefined && cents <= target;
};

/** The alert rule of one wishlist item (GET/PUT/DELETE /wishlist/{id}/alert). */
export function useAlertRule(id: string) {
  const [rule, setRule] = useState<Rule | null>(null);
  const [channels, setChannels] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const path = `/wishlist/${encodeURIComponent(id)}/alert`;
  useEffect(() => {
    const controller = new AbortController();
    setReady(false);
    setRule(null);
    void api<{ rule: Rule | null; channels?: string[] }>(path, 'GET', undefined, controller.signal)
      .then(data => {
        if (controller.signal.aborted) return;
        setChannels(data.channels ?? []);
        setRule(data.rule);
        setReady(true);
      })
      .catch(err => {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : 'Alarmregel konnte nicht geladen werden.');
          notifyError(err);
        }
      });
    return () => controller.abort();
  }, [path]);
  const save = useCallback(
    async (next: Rule) => {
      await api(path, 'PUT', next);
      setRule(next);
    },
    [path],
  );
  const remove = useCallback(async () => {
    await api(path, 'DELETE');
    setRule(null);
  }, [path]);
  return { rule, channels, ready, error, save, remove };
}
export type AlertState = ReturnType<typeof useAlertRule>;

/** In-app link to the alarm tab of a wishlist item. */
const alarmHref = (id: string) => `?item=${encodeURIComponent(id)}&tab=alarm`;
const openAlarm = (id: string) => navigate({ item: id, tab: 'alarm' }, { reset: true });

function AlarmStatus({ row, mode }: { row: AlarmRow; mode: Rule['mode'] }) {
  if (row.reached) return <StatePill state="reached" />;
  if (!row.enabled) return <StatePill state="paused" />;
  if (mode === 'low')
    return (
      <Pill tone="dim" icon="bell">
        Neuer Tiefstpreis
      </Pill>
    );
  if (row.current === null) return <StatePill state="missing" />;
  return <Pill>{money(row.distance ?? 0)} über Ziel</Pill>;
}

/** Preisalarme (prototype viewAlarms): every target sorted by distance, each row opens the alarm tab of the game. Channel test and delivery log below. */
export default function PriceAlerts({ targetCountry, targetLabel }: { targetCountry: string | null; targetLabel: string }) {
  const [loadError, setLoadError] = useState('');
  const [data, setData] = useState<Overview | null>(null);
  const [badges, setBadges] = useState<Record<string, PriceBadgeData>>({});
  const [items, setItems] = useState<Record<string, WishlistItem>>({});
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let cancel = () => {};
    async function load() {
      try {
        const current = await api<Overview>('/alerts', 'GET', undefined, controller.signal);
        if (controller.signal.aborted) return;
        setData(current);
        setLoadError('');
        if (current.configured && current.events.some(row => row.state === 'pending')) cancel = whenVisible(() => void load(), 5000);
      } catch (error) {
        if (controller.signal.aborted) return;
        if (!sessionEnded(error)) setLoadError(error instanceof Error ? error.message : 'Preisalarme konnten nicht geladen werden.');
      }
    }
    void load();
    api<Record<string, PriceBadgeData>>('/wishlist/price-badges', 'GET', undefined, controller.signal)
      .then(rows => {
        if (!controller.signal.aborted) setBadges(rows);
      })
      .catch(() => {});
    // Covers and editions for the game column.
    api<WishlistItem[]>('/wishlist', 'GET', undefined, controller.signal)
      .then(rows => {
        if (!controller.signal.aborted) setItems(Object.fromEntries(rows.map(row => [row.id, row])));
      })
      .catch(() => {});
    return () => {
      controller.abort();
      cancel();
    };
  }, [reload]);
  async function testChannel() {
    setBusy(true);
    try {
      await api('/alerts/test', 'POST');
      notify('Testnachricht zur Zustellung vorgemerkt.');
      setReload(n => n + 1);
    } catch (error) {
      notifyError(error);
    } finally {
      setBusy(false);
    }
  }
  const rules = data?.rules ?? [];
  const rows = alarmRows(rules, badges);
  const ruleOf = (id: string) => rules.find(rule => rule.wish_id === id);
  const country = targetCountry ?? 'Zielland';
  const names = data?.channels ?? [];
  const channel = data ? (
    <>
      <Pill tone={names.length ? 'ok' : 'dim'} icon={names.length ? 'check' : 'minus'}>
        {channelLine(names)}
      </Pill>
      {!names.length && <SetupLink />}
    </>
  ) : null;
  return (
    <section className="page alerts-page" aria-labelledby="alerts-title">
      <PageHeading
        id="alerts-title"
        title="Preisalarme"
        help={`Benachrichtigung über jeden aktiven Kanal (Einstellungen › Benachrichtigungen), sobald ein in ${targetLabel} aktivierbarer Key das Ziel erreicht. Höchstens eine Nachricht je Spiel und 24 Stunden.`}
        actions={
          <>
            {channel}
            <Button disabled={!data?.configured || busy} loading={busy} onClick={() => void testChannel()}>
              <Icon name="send" />
              Testnachricht senden
            </Button>
          </>
        }
      />
      {loadError && (
        <Notice error>
          {loadError}{' '}
          <Button size="sm" onClick={() => setReload(n => n + 1)}>
            Erneut laden
          </Button>
        </Notice>
      )}
      <Panel aria-labelledby="rules-title">
        <PanelHead>
          <Label as="h2" tone="soft" id="rules-title">
            Alle Ziele · nach Abstand
          </Label>
        </PanelHead>
        <Inset className="table-wrap">
          {!data ? (
            <p className="hint alarm-pad" role="status">
              {loadError ? 'Nicht geladen.' : 'Preisalarme werden geladen …'}
            </p>
          ) : rows.length === 0 ? (
            <EmptyState icon="bell" title="Noch kein Alarm" headingLevel={3}>
              Lege im Detail eines Wunschspiels einen Alarm an. Er meldet sich, wenn ein Preis dein Ziel erreicht.
            </EmptyState>
          ) : (
            <table className="alarm-table" aria-label="Preisalarme nach Abstand">
              <thead>
                <tr>
                  <th>Spiel</th>
                  <th className="r">Ziel</th>
                  <th className="r">Jetzt {country}</th>
                  <th className="r">Abstand</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => {
                  const rule = ruleOf(row.id);
                  const item = items[row.id];
                  // RESP-10: edition and the wish's own platform, so two wishes of one game stay apart.
                  const sub = [item?.game?.edition_name, item && platformName(item.platform_id), rule?.basis === 'estimate' && basisName(rule.basis)]
                    .filter(Boolean)
                    .join(' · ');
                  return (
                    <tr key={row.id} className="click" onClick={() => openAlarm(row.id)}>
                      <td className="c-game">
                        <div className="game-cell">
                          <Cover src={item?.game?.cover_url} title={row.title} />
                          <div>
                            <a
                              className="alarm-title"
                              href={alarmHref(row.id)}
                              onClick={event => {
                                event.preventDefault();
                                event.stopPropagation();
                                openAlarm(row.id);
                              }}
                            >
                              {row.title}
                            </a>
                            <small>{sub}</small>
                          </div>
                        </div>
                      </td>
                      <td className="r mono c-target">{row.target !== null ? money(row.target) : '–'}</td>
                      <td className="r c-now">
                        <Price cents={row.current} tone={row.stale ? 'stale' : 'default'} missing="–" />
                      </td>
                      <td className="r c-dist">
                        {row.distance !== null ? (
                          <span className={`save${row.distance <= 0 ? ' reached' : ''}`}>
                            {row.distance <= 0 ? '−' : '+'}
                            {money(Math.abs(row.distance))}
                          </span>
                        ) : (
                          <span className="save none">–</span>
                        )}
                      </td>
                      <td className="c-status">{rule && <AlarmStatus row={row} mode={rule.mode} />}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Inset>
      </Panel>
      <Panel aria-labelledby="deliveries-title">
        <PanelHead>
          <Label as="h2" tone="soft" id="deliveries-title">
            Letzte Zustellungen
          </Label>
        </PanelHead>
        <Inset className="table-wrap">
          {!data || data.events.length === 0 ? (
            <p className="hint alarm-pad">{data ? 'Es liegt noch kein Zustellversuch vor.' : 'Wird geladen …'}</p>
          ) : (
            <table className="delivery-table" aria-label="Letzte Zustellungen">
              <thead>
                <tr>
                  <th>Zeit</th>
                  <th>Spiel</th>
                  <th className="r">Preis</th>
                  <th>Zustellung</th>
                </tr>
              </thead>
              <tbody>
                {data.events.map(event => {
                  const at = event.sent_at ?? event.observed_at;
                  return (
                    <tr key={event.id}>
                      <td className="mono c-time" title={new Date(at * 1000).toLocaleString('de-DE')}>
                        {relativeTime(at)}
                        {event.attempts > 1 && <span className="muted"> · {event.attempts} Versuche</span>}
                      </td>
                      <td className="c-game">{event.wish_id ? (ruleOf(event.wish_id)?.title ?? 'Ehemaliger Wunschlisteneintrag') : 'Testnachricht'}</td>
                      <td className="r mono c-price">{event.cents !== null ? money(event.cents) : '–'}</td>
                      <td className="c-status">
                        {deliveryChip(event.state)}
                        {event.deliveries && event.deliveries.length > 0 && deliveryLine(event.deliveries)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Inset>
      </Panel>
    </section>
  );
}
