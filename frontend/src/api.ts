export interface SourceSettings {
  id: string;
  kind: 'shop' | 'catalog';
  enabled: boolean;
  fee_estimation_enabled: boolean;
  fee_basis_points: number;
  configured: boolean;
  poll_interval_seconds: number;
}
export interface Settings {
  target_country: string | null;
  currency: string;
  wishlist_price_scope: 'preferred' | 'all';
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

/** GET /status/fetch: queue, budget and pauses per shop (times in Unix seconds). */
export interface FetchShopStatus {
  source: string;
  enabled: boolean;
  last_success_at: number | null;
  last_error: string | null;
  paused_until: number | null;
  budget: { used: number; limit: number };
  backlog: { due: number; requested: number; products: number; searches: number };
  oldest_due_at: number | null;
  next_due_at: number | null;
  worker_seen_at: number | null;
}
export interface FetchStatusResponse { shops: FetchShopStatus[]; errors_24h: number; recent_runs: unknown[] }
