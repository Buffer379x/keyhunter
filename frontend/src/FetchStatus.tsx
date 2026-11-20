import { useEffect, useState } from 'react';
import { api } from './api';
import type { FetchShopStatus, FetchStatusResponse } from './api';
import { whenVisible } from './poll';
import { relativeTime } from './time';
import { MonoLabel } from './ui';
import { shopNames } from './features/Offers';

const REFRESH_MS = 60_000;

type Tone = 'ok' | 'warn' | 'error' | 'off';
function describe(shop: FetchShopStatus, nowSeconds: number): { tone: Tone; text: string; title: string } {
  const last = shop.last_success_at === null ? 'Noch kein erfolgreicher Abruf' : `Letzter erfolgreicher Abruf ${new Date(shop.last_success_at * 1000).toLocaleString('de-DE')}`;
  if (!shop.enabled) return { tone: 'off', text: 'aus', title: `Abruf ausgeschaltet. ${last}` };
  if (shop.paused_until !== null && shop.paused_until > nowSeconds) return { tone: 'warn', text: 'pausiert', title: `Pausiert bis ${new Date(shop.paused_until * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr. ${last}` };
  if (shop.last_error) return { tone: 'error', text: 'Fehler', title: `Letzter Abruf fehlgeschlagen. ${last}` };
  if (shop.last_success_at === null) return { tone: 'off', text: 'noch nie', title: last };
  return { tone: 'ok', text: relativeTime(shop.last_success_at), title: last };
}

/**
 * Abrufstatus mini card for the sidebar: per shop a status dot, name and the time of the last successful fetch,
 * then "X von Y Abrufen heute" with a thin bar. Loaded once, refreshed at most every 60 s and never while the tab is hidden.
 * Shows nothing until the API answered; shows nothing if no shop is configured.
 */
export default function FetchStatus() {
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
  return <section className="fetch-card" aria-labelledby="fetch-card-title">
    <MonoLabel id="fetch-card-title">Abrufstatus</MonoLabel>
    <ul>
      {data.shops.map(shop => {
        const state = describe(shop, nowSeconds);
        return <li key={shop.source} title={state.title}>
          <span className="fetch-shop"><span className={`fetch-dot ${state.tone}`} aria-hidden="true" />{shopNames[shop.source] ?? shop.source}</span>
          <MonoLabel className={`fetch-time ${state.tone}`}>{state.text}</MonoLabel>
        </li>;
      })}
    </ul>
    {limit > 0 && <div className="fetch-budget">
      <label htmlFor="fetch-budget-bar">{used} von {limit} Abrufen heute</label>
      <progress id="fetch-budget-bar" max={limit} value={Math.min(used, limit)} />
    </div>}
  </section>;
}
