import type { FetchBudget, FetchRun, FetchShopStatus } from '../../api.ts';

/** Seconds without a worker heartbeat after which the backend itself calls a worker stalled (jobs.rs STALL_AFTER). */
export const WORKER_STALLED_AFTER = 300;

export const shopTitle = (id: string) => ({ eneba: 'Eneba', driffle: 'Driffle', igdb: 'IGDB' } as Record<string, string>)[id] ?? id;

const HOUR = 3600;
const presetHours = [0.25, 0.5, 1, 2, 3, 4, 6, 8, 12, 24, 48, 72, 168];
const hoursText = (hours: number) => `${hours.toLocaleString('de-DE', { maximumFractionDigits: 2 })}`;
/** "2 Stunden", "30 Minuten", "1 Stunde". */
export function intervalLabel(seconds: number): string {
  const hours = seconds / HOUR;
  return hours < 1 ? `${Math.round(hours * 60)} Minuten` : hours === 1 ? '1 Stunde' : `${hoursText(hours)} Stunden`;
}
/** Options of "Produktseiten abfragen alle": "8 Stunden"; the current value is always one of them, also when it is not a preset. */
export function intervalOptions(currentSeconds: number): { value: number; label: string }[] {
  const seconds = [...new Set([...presetHours.map(h => Math.round(h * HOUR)), currentSeconds])].sort((a, b) => a - b);
  return seconds.map(value => ({ value, label: intervalLabel(value) }));
}

/** Bounds of "Abrufe pro Tag (höchstens)" (backend: daily_jobs 20..=2000). */
export const DAILY_JOBS_MIN = 20;
export const DAILY_JOBS_MAX = 2000;
/** A whole number from 20 to 2000 ("1.200" and "1200" both work), otherwise null. */
export function parseDailyJobs(text: string): number | null {
  const raw = text.trim().replace(/[.\s]/g, '');
  if (!/^\d{1,5}$/.test(raw)) return null;
  const value = Number(raw);
  return value >= DAILY_JOBS_MIN && value <= DAILY_JOBS_MAX ? value : null;
}

export type Tone = 'ok' | 'warn' | 'error' | 'off';
const clock = (seconds: number) => new Date(seconds * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
/** "20:35 Uhr" within the next 20 hours, otherwise with the date ("21.11., 20:35 Uhr"). */
const pauseEnd = (seconds: number, nowSeconds: number) => seconds - nowSeconds < 20 * 3600 ? `${clock(seconds)} Uhr` : `${dateTimeText(seconds)} Uhr`;
export const dateTimeText = (seconds: number) => new Date(seconds * 1000).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/** Short German name of an error code in `last_error` and `outcome`. */
export const outcomeNames: Record<string, string> = {
  ok: 'Erfolgreich', network: 'Netzwerkfehler', not_found: 'Nicht gefunden', rate_limited: 'Abruflimit erreicht', access_denied: 'Zugriff verweigert', invalid_response: 'Antwort nicht lesbar',
};
export const outcomeText = (code: string) => outcomeNames[code] ?? code;
export function outcomeTone(code: string): 'ok' | 'warn' | 'error' {
  return code === 'ok' ? 'ok' : code === 'rate_limited' || code === 'not_found' ? 'warn' : 'error';
}
export const kindNames: Record<string, string> = { product: 'Preis', search: 'Suche', discovery: 'Discovery' };
export const kindText = (kind: string) => kindNames[kind] ?? kind;
export function durationText(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 })} s`;
}

/** Status line of a shop: tone for the dot, text for the reader. Never colour alone. */
/** `ago(seconds)` turns a timestamp into "vor 2 Std." (src/time.ts relativeTime). */
export function shopState(shop: Pick<FetchShopStatus, 'enabled' | 'paused_until' | 'last_error' | 'last_success_at'>, nowSeconds: number, ago: (seconds: number) => string): { tone: Tone; text: string } {
  if (!shop.enabled) return { tone: 'off', text: 'Deaktiviert' };
  if (shop.paused_until !== null && shop.paused_until > nowSeconds) return { tone: 'warn', text: `Pausiert bis ${pauseEnd(shop.paused_until, nowSeconds)}` };
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

/** "11:02" (local time of a Unix timestamp). */
export const clockText = clock;

/** "in 2 Min." for a time in the future, "jetzt" when it is due. */
export function untilText(seconds: number, nowSeconds: number): string {
  const diff = Math.round(seconds - nowSeconds);
  if (diff < 60) return 'jetzt';
  if (diff < 3600) return `in ${Math.round(diff / 60)} Min.`;
  if (diff < 86400) return `in ${Math.round(diff / 3600)} Std.`;
  return `in ${Math.round(diff / 86400)} T`;
}

/** Pill in the head of a shop panel on Abrufstatus. */
export function fetchPill(shop: Pick<FetchShopStatus, 'enabled' | 'paused_until' | 'last_error' | 'worker_seen_at'>, nowSeconds: number): { tone: 'ok' | 'warn' | 'danger' | 'dim'; text: string } {
  if (!shop.enabled) return { tone: 'dim', text: 'Aus' };
  if (shop.paused_until !== null && shop.paused_until > nowSeconds) return { tone: 'warn', text: 'Pausiert' };
  if (shop.worker_seen_at !== null && shop.worker_seen_at > 0 && nowSeconds - shop.worker_seen_at > WORKER_STALLED_AFTER) return { tone: 'danger', text: 'Reagiert nicht' };
  if (shop.last_error) return { tone: 'danger', text: 'Fehler' };
  return { tone: 'ok', text: 'Läuft' };
}

/**
 * Daily budget of one shop as drawn on Abrufstatus: share of the bar, position of the demand marker (both 0..1),
 * and `over` with the value the setting needs when the demand is higher than the limit. Fields the backend does not send stay null.
 */
export function budgetView(budget: FetchBudget) {
  const { used, limit } = budget;
  const demand = typeof budget.demand_per_day === 'number' && Number.isFinite(budget.demand_per_day) ? Math.ceil(budget.demand_per_day) : null;
  const pace = typeof budget.pace_seconds === 'number' && budget.pace_seconds > 0 ? budget.pace_seconds : null;
  return {
    used, limit,
    share: budgetShare(used, limit),
    demand,
    demandShare: demand === null || limit <= 0 ? null : Math.min(1, demand / limit),
    pace,
    over: demand !== null && limit > 0 && demand > limit,
    needed: demand === null ? null : Math.max(DAILY_JOBS_MIN, demand),
    fromEnv: budget.limit_source === 'env',
  };
}

export type { FetchRun };
