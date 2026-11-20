import type { FetchRun, FetchShopStatus } from '../../api.ts';

/** Seconds without a worker heartbeat after which the backend itself calls a worker stalled (jobs.rs STALL_AFTER). */
export const WORKER_STALLED_AFTER = 300;

export const shopTitle = (id: string) => ({ eneba: 'Eneba', driffle: 'Driffle', igdb: 'IGDB' } as Record<string, string>)[id] ?? id;

const HOUR = 3600;
const presetHours = [0.25, 0.5, 1, 2, 3, 4, 6, 8, 12, 24, 48, 72, 168];
const hoursText = (hours: number) => `${hours.toLocaleString('de-DE', { maximumFractionDigits: 2 })}`;
/** "Alle 8 Stunden"; the current value is always one of the options, also when it is not a preset. */
export function intervalOptions(currentSeconds: number): { value: number; label: string }[] {
  const seconds = [...new Set([...presetHours.map(h => Math.round(h * HOUR)), currentSeconds])].sort((a, b) => a - b);
  return seconds.map(value => {
    const hours = value / HOUR;
    return { value, label: hours < 1 ? `Alle ${Math.round(hours * 60)} Minuten` : hours === 1 ? 'Jede Stunde' : `Alle ${hoursText(hours)} Stunden` };
  });
}

export type Tone = 'ok' | 'warn' | 'error' | 'off';
const clock = (seconds: number) => new Date(seconds * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
export const dateTimeText = (seconds: number) => new Date(seconds * 1000).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/** Short German name of an error code in `last_error` and `outcome`. */
export const outcomeNames: Record<string, string> = {
  ok: 'Erfolgreich', network: 'Netzwerkfehler', not_found: 'Nicht gefunden', rate_limited: 'Abruflimit erreicht', access_denied: 'Zugriff verweigert', invalid_response: 'Antwort nicht lesbar',
};
export const outcomeText = (code: string) => outcomeNames[code] ?? code;
export function outcomeTone(code: string): 'ok' | 'warn' | 'error' {
  return code === 'ok' ? 'ok' : code === 'rate_limited' || code === 'not_found' ? 'warn' : 'error';
}
export const kindNames: Record<string, string> = { product: 'Produkt', search: 'Suche', discovery: 'Discovery' };
export const kindText = (kind: string) => kindNames[kind] ?? kind;
export function durationText(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 })} s`;
}

/** Status line of a shop: tone for the dot, text for the reader. Never colour alone. */
/** `ago(seconds)` turns a timestamp into "vor 2 Std." (src/time.ts relativeTime). */
export function shopState(shop: Pick<FetchShopStatus, 'enabled' | 'paused_until' | 'last_error' | 'last_success_at'>, nowSeconds: number, ago: (seconds: number) => string): { tone: Tone; text: string } {
  if (!shop.enabled) return { tone: 'off', text: 'Deaktiviert' };
  if (shop.paused_until !== null && shop.paused_until > nowSeconds) return { tone: 'warn', text: `Pausiert bis ${clock(shop.paused_until)} Uhr` };
  if (shop.last_error) return { tone: 'error', text: `Letzter Abruf fehlgeschlagen${shop.last_success_at === null ? '' : ` · zuletzt erfolgreich ${ago(shop.last_success_at)}`}` };
  if (shop.last_success_at === null) return { tone: 'off', text: 'Aktiv · noch kein Abruf' };
  return { tone: 'ok', text: `Aktiv · letzter Abruf ${ago(shop.last_success_at)}` };
}

/** Worker state from the heartbeat. A disabled shop has no worker to judge. */
export function workerState(shop: Pick<FetchShopStatus, 'enabled' | 'worker_seen_at'>, nowSeconds: number, ago: (seconds: number) => string): { tone: Tone; text: string } {
  if (!shop.enabled) return { tone: 'off', text: 'Abruf ausgeschaltet' };
  if (shop.worker_seen_at === null || shop.worker_seen_at <= 0) return { tone: 'off', text: 'Noch kein Lebenszeichen' };
  const age = nowSeconds - shop.worker_seen_at;
  return age > WORKER_STALLED_AFTER
    ? { tone: 'error', text: `Reagiert nicht · zuletzt ${ago(shop.worker_seen_at)}` }
    : { tone: 'ok', text: 'Läuft' };
}

export function budgetShare(used: number, limit: number): number {
  return limit > 0 ? Math.min(1, Math.max(0, used / limit)) : 0;
}

/** Numbers for the four tiles on top of the Abrufstatus section. Only enabled shops count towards queue and budget. */
export function summarize(shops: FetchShopStatus[], errors24h: number) {
  const active = shops.filter(shop => shop.enabled);
  const oldest = active.flatMap(shop => shop.oldest_due_at === null ? [] : [{ at: shop.oldest_due_at, source: shop.source }]).sort((a, b) => a.at - b.at)[0] ?? null;
  return {
    due: active.reduce((sum, shop) => sum + shop.backlog.due, 0),
    requested: active.reduce((sum, shop) => sum + shop.backlog.requested, 0),
    used: active.reduce((sum, shop) => sum + shop.budget.used, 0),
    limit: active.reduce((sum, shop) => sum + shop.budget.limit, 0),
    oldest,
    errors24h,
  };
}

export const deliveryNames: Record<string, string> = { sent: 'zugestellt', pending: 'wird zugestellt', failed: 'fehlgeschlagen', cancelled: 'abgebrochen' };
/** The newest test message in the ntfy delivery log (test messages have no wish). */
export function lastTest<T extends { wish_id: string | null; id: number }>(events: T[]): T | null {
  return events.filter(event => event.wish_id === null).sort((a, b) => b.id - a.id)[0] ?? null;
}

export type { FetchRun };
