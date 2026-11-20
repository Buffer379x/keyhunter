import { useEffect, useState } from 'react';
import { api } from './api';
import type { FetchShopStatus, FetchStatusResponse } from './api';
import { whenVisible } from './poll';
import { relativeTime } from './time';
import { shopNames } from './features/Offers';

const REFRESH_MS = 60_000;

type Tone = 'ok' | 'warn' | 'error' | 'off';
/** "alle 3 Min." from the planned spacing; under a minute in seconds, from an hour in hours. */
export function paceText(seconds: number): string {
  if (seconds < 60) return `alle ${Math.max(1, Math.round(seconds))} s`;
  if (seconds < 3600) return `alle ${Math.round(seconds / 60)} Min.`;
  return `alle ${(seconds / 3600).toLocaleString('de-DE', { maximumFractionDigits: 1 })} Std.`;
}
function describe(shop: FetchShopStatus, nowSeconds: number): { tone: Tone; text: string; title: string } {
  const last = shop.last_success_at === null ? 'Noch kein erfolgreicher Abruf' : `Letzter erfolgreicher Abruf ${new Date(shop.last_success_at * 1000).toLocaleString('de-DE')}`;
  if (!shop.enabled) return { tone: 'off', text: 'aus', title: `Abruf ausgeschaltet. ${last}` };
  if (shop.paused_until !== null && shop.paused_until > nowSeconds) return { tone: 'warn', text: 'pausiert', title: `Pausiert bis ${new Date(shop.paused_until * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr. ${last}` };
  if (shop.last_error) return { tone: 'error', text: 'Fehler', title: `Letzter Abruf fehlgeschlagen. ${last}` };
  const pace = shop.budget.pace_seconds;
  if (pace) return { tone: 'ok', text: paceText(pace), title: `Abrufe gleichmäßig verteilt, ${paceText(pace)}. ${last}` };
  if (shop.last_success_at === null) return { tone: 'off', text: 'noch nie', title: last };
  return { tone: 'ok', text: relativeTime(shop.last_success_at), title: last };
}

/**
 * Abrufstatus mini card in the sidebar footer (`.fetch-mini`): per shop a status dot, the name and the pace ("alle 3 Min.",
 * from budget.pace_seconds) or the current state, then a bar and "X von Y Abrufen heute" summed over the active shops.
 * The whole card is a button that opens Einstellungen › Abrufstatus.
 * Loaded once, refreshed at most every 60 s and never while the tab is hidden. Shows nothing until the API answered or without shops.
 */
export default function FetchStatus({ onOpen }: { onOpen: () => void }) {
  const [data, setData] = useState<FetchStatusResponse | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let cancel = () => {};
    const load = () => {
      api<FetchStatusResponse>('/status/fetch', 'GET', undefined, undefined, controller.signal)
        .then(next => { if (!controller.signal.aborted) setData(next); })
        .catch(() => {})
        .finally(() => { if (!controller.signal.aborted) cancel = whenVisible(load, REFRESH_MS); });
    };
    load();
    return () => { controller.abort(); cancel(); };
  }, []);
  if (!data || data.shops.length === 0) return null;
  const nowSeconds = Date.now() / 1000;
  const active = data.shops.filter(shop => shop.enabled);
  const used = active.reduce((sum, shop) => sum + shop.budget.used, 0);
  const limit = active.reduce((sum, shop) => sum + shop.budget.limit, 0);
  return <button type="button" className="fetch-mini" onClick={onOpen}>
    <span className="label">Abrufstatus</span>
    {data.shops.map(shop => {
      const state = describe(shop, nowSeconds);
      return <span key={shop.source} className="fetch-row" title={state.title}>
        <i className={`dot${state.tone === 'ok' ? '' : ` ${state.tone}`}`} aria-hidden="true" />{shopNames[shop.source] ?? shop.source}<span className="mono">{state.text}</span>
      </span>;
    })}
    {limit > 0 && <>
      <span className="bar" aria-hidden="true"><i style={{ width: `${Math.min(100, used / limit * 100)}%` }} /></span>
      <span className="fetch-budget">{used} von {limit} Abrufen heute</span>
    </>}
  </button>;
}
