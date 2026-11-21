export interface SourceSettings {
  id: string;
  kind: 'shop' | 'catalog';
  enabled: boolean;
  fee_estimation_enabled: boolean;
  fee_basis_points: number;
  configured: boolean;
  poll_interval_seconds: number;
  /**
   * Most fetches per day for this shop (effective value, 20 to 2000; null for IGDB, absent before 0.6.1).
   * PUT replaces it: null clears the setting, so the default applies again.
   */
  daily_jobs?: number | null;
  /** The default of `daily_jobs` (environment variable or 500), shown as placeholder; null for IGDB. */
  daily_jobs_default?: number | null;
}
export interface Settings {
  target_country: string | null;
  currency: string;
  wishlist_price_scope: 'preferred' | 'all';
  /** Order of the wishlist table columns (keys of `WISHLIST_COLUMNS`); the server returns a complete order. */
  wishlist_columns?: string[];
  /** Hidden wishlist columns and what opens the game page ("button", "title", "cover"), 0.7.1. */
  wishlist_hidden?: string[];
  wishlist_open?: string;
  /** Order and hidden columns of the offers table on the game page (0.8.2); absent from older servers. */
  offers_columns?: string[];
  offers_hidden?: string[];
  sources: SourceSettings[];
  countries: string[];
  confirmed_activation_countries?: string[];
}
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string, public code?: string) { super(message); this.status = status; }
}
export interface CatalogGame {
  igdb_id: number;
  name: string;
  slug: string | null;
  summary: string | null;
  first_release_date: number | null;
  platforms: { id: number; name: string }[];
  aliases: string[];
  cover_url: string | null;
  artwork_url?: string | null;
  store_product_id?: string | null;
  version_parent: number | null;
  edition_name: string | null;
  kind: string;
  fetched_at: number;
}
export interface PriceBadgeData {
  cents:number|null;
  state:'price'|'unknown'|'no_offer'|'review'|'error';
  observed_at:number|null;
  checked_at:number|null;
  stale:boolean;
  pending:boolean;
  /** Cheapest current offer of any region (valid in the target country or not). */
  world?:WorldBest|null;
  /**
   * Best price valid in the target country at the end of each of the last 14 UTC days (cents, oldest → newest, today = now);
   * null for a day without a valid price. Comes with 0.6.1; optional so older servers keep working.
   */
  trend?:(number|null)[];
  /** Shop and region of the target-country price, when the server reports them . */
  source?:string|null;
  region?:string|null;
  /** Estimated total (shop fee from the settings) of the offer behind `cents`; null while that shop has no fee estimate (0.7.3). */
  estimate_cents?:number|null;
  /** The same prices compared by estimated totals; shops without a fee estimate do not count (0.7.3). */
  with_fees?:FeeView;
}
/** Cheapest current offer of any region. `cents` is the compared amount (base price, or estimated total in `with_fees`). */
export interface WorldBest {cents:number;source?:string;region:string|null;observed_at:number|null;base_cents?:number;estimate_cents?:number|null}
export interface FeeView {
  cents:number|null;
  /** Base price of the offer behind `cents`. */
  base_cents:number|null;
  observed_at:number|null;
  stale:boolean;
  source:string|null;
  region:string|null;
  world:WorldBest|null;
  trend:(number|null)[];
}
export interface WishlistItem {
  price_badge?:PriceBadgeData;
  id: string;
  game_id: string;
  platform_id: number;
  created_at: number;
  verification: 'catalog' | 'needs_review' | 'manual_unverified';
  game: CatalogGame | null;
  manual_title: string | null;
  /** In the shopping cart (0.8.0); absent from older servers. */
  in_cart?: boolean;
}
export interface LibraryItem extends WishlistItem { acquired_at:number; }
export type SourceStatuses = Record<string, { state: string; enabled: boolean; configured?: boolean; last_success_at: number | null; retry_at: number | null }>;
export async function api<T>(path: string, method = 'GET', body?: unknown, csrf?: string, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method, credentials: 'same-origin',
      signal,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new HttpError(0, 'Verbindung unterbrochen. Bitte erneut versuchen.');
  }
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new HttpError(response.status, data?.error ?? 'Die Anfrage konnte nicht abgeschlossen werden.', data?.code);
  return data as T;
}

/**
 * Daily request budget of one shop. `used` and `limit` always exist; the other fields come with the paced worker (0.6.1)
 * and are optional so the frontend keeps working against an older backend.
 */
export interface FetchBudget {
  used: number;
  limit: number;
  /** Where the limit comes from: 'setting' (Key-Shops), 'env' (environment variable) or 'default'. */
  limit_source?: string;
  /** Requests per day the current wishlist needs. */
  demand_per_day?: number;
  /** Planned spacing between two requests in seconds ("alle 3 Min."). */
  pace_seconds?: number | null;
  /** Unix seconds of the next planned request. */
  next_at?: number | null;
  /** Requests per hour of today, 24 entries (index 0 = 00:00 local server time). */
  by_hour?: number[];
}
/** GET /status/fetch: queue, budget and pauses per shop (times in Unix seconds). */
export interface FetchShopStatus {
  source: string;
  enabled: boolean;
  last_success_at: number | null;
  last_error: string | null;
  paused_until: number | null;
  budget: FetchBudget;
  backlog: { due: number; requested: number; products: number; searches: number };
  oldest_due_at: number | null;
  next_due_at: number | null;
  worker_seen_at: number | null;
}
/** One row of the job log: kind is 'product' | 'search' | 'discovery', outcome is 'ok' or an error code (network, not_found, rate_limited, access_denied, invalid_response). */
export interface FetchRun {
  source: string;
  kind: string;
  wish_id: string | null;
  link_id: number | null;
  started_at: number;
  duration_ms: number;
  outcome: string;
  detail: string | null;
}
/** `paused_at`: the owner paused the automatic checks at this time (0.7.0); null or missing while they run. */
export interface FetchStatusResponse { paused_at?: number | null; shops: FetchShopStatus[]; errors_24h: number; recent_runs: FetchRun[] }
/** Event on window after the automatic checks were paused or resumed, so every status view reloads at once. */
export const FETCH_STATUS_CHANGED = 'keyhunter:fetch-status';
/** The shopping cart changed (0.8.0): the navigation reads its count again. */
export const CART_CHANGED = 'keyhunter:cart';

/** GET /alerts: ntfy channel state and the delivery log (wish_id is null for test messages). */
export interface AlertEvent { id: number; wish_id: string | null; state: string; observed_at: number; sent_at: number | null; cents: number | null; attempts: number }
export interface AlertOverview { configured: boolean; rules: unknown[]; events: AlertEvent[] }
