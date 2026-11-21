import type { PriceBadgeData, WishlistItem } from '../api.ts';

/**
 * Shopping cart (0.8.0): pure sums over the saved price badges of the wishes in the cart. Each wish counts with one offer:
 * the cheapest key price valid in the target country ("home", the Preis DE column) or the cheapest key price of any region
 * ("world", Preis INT). Its fee is the shop's estimate from the settings; a shop without an estimate has unknown fees,
 * and the total with fees then holds only its key price. Nothing is invented: a wish without a price is listed apart.
 */

export interface CartEntry extends WishlistItem { added_at: number }
export type CartScope = 'home' | 'world';

export interface CartLine {
  item: CartEntry;
  /** Shop and region of the counted offer; null without a price. */
  source: string | null;
  region: string | null;
  /** Key price (base price) in cents; null when the wish has no current price in this scope. */
  base: number | null;
  /** Estimated fee in cents; null when the shop has no fee estimate (or there is no price). */
  fee: number | null;
  /** The price is only the last known one (no current offer). */
  stale: boolean;
}

export interface ShopSum {
  source: string;
  count: number;
  keys: number;
  /** Sum of the estimated fees; null when the shop has no fee estimate. */
  fees: number | null;
  total: number;
}

export interface CartSums {
  lines: CartLine[];
  shops: ShopSum[];
  /** Key prices of all priced wishes. */
  keys: number;
  /** Estimated fees that are known. */
  fees: number;
  /** keys + fees: the total with fees (shops without an estimate count with their key price). */
  total: number;
  /** Shops whose fees are unknown. */
  unknownFees: string[];
  /** Wishes without a price in this scope; not part of the sums. */
  missing: CartEntry[];
}

const positive = (cents: number | null | undefined) => typeof cents === 'number' && Number.isFinite(cents) && cents > 0 ? cents : null;

export function cartLine(item: CartEntry, badge: PriceBadgeData | undefined, scope: CartScope): CartLine {
  const empty: CartLine = { item, source: null, region: null, base: null, fee: null, stale: false };
  if (!badge) return empty;
  if (scope === 'world') {
    const world = badge.world;
    const base = positive(world?.base_cents ?? world?.cents);
    if (!world || base === null) return empty;
    const estimate = positive(world.estimate_cents);
    return { item, source: world.source ?? null, region: world.region, base, fee: estimate !== null && estimate >= base ? estimate - base : null, stale: false };
  }
  const base = badge.state === 'price' ? positive(badge.cents) : null;
  if (base === null) return empty;
  const estimate = positive(badge.estimate_cents);
  return { item, source: badge.source ?? null, region: badge.region ?? null, base, fee: estimate !== null && estimate >= base ? estimate - base : null, stale: badge.stale };
}

export function cartSums(entries: CartEntry[], badges: Record<string, PriceBadgeData | undefined>, scope: CartScope): CartSums {
  const lines = entries.map(item => cartLine(item, badges[item.id] ?? item.price_badge, scope));
  const priced = lines.filter(line => line.base !== null);
  const shops = new Map<string, ShopSum>();
  for (const line of priced) {
    const source = line.source ?? '';
    const sum = shops.get(source) ?? { source, count: 0, keys: 0, fees: 0, total: 0 };
    sum.count += 1;
    sum.keys += line.base!;
    sum.fees = sum.fees === null || line.fee === null ? null : sum.fees + line.fee;
    shops.set(source, sum);
  }
  const shopSums = [...shops.values()].map(sum => ({ ...sum, total: sum.keys + (sum.fees ?? 0) })).sort((a, b) => b.total - a.total || a.source.localeCompare(b.source));
  const keys = priced.reduce((total, line) => total + line.base!, 0);
  const fees = priced.reduce((total, line) => total + (line.fee ?? 0), 0);
  return {
    lines, shops: shopSums, keys, fees, total: keys + fees,
    unknownFees: shopSums.filter(sum => sum.fees === null).map(sum => sum.source),
    missing: lines.filter(line => line.base === null).map(line => line.item),
  };
}
