import type { WishlistItem } from '../api.ts';

/**
 * Shopping cart: pure sums over the offers the server sends per cart entry (each shop's best key price valid in the target
 * country, "home", and of any region, "world"). An entry counts with one offer: its own shop, or the cheapest one when it has
 * none (0.8.1), in its own scope. The button on the game page adds the cheapest variant, shop and region independent
 * (no shop, scope "world"). Fees are the shop's estimate from the settings; a shop without an estimate has unknown fees, and
 * the total with fees then holds only its key price. Nothing is invented: an entry without a price is listed apart.
 */

export type CartScope = 'home' | 'world';
export interface CartOffer {
  cents: number;
  estimate_cents: number | null;
  region: string | null;
  observed_at: number;
  stale: boolean;
}
export interface ShopOffers {
  home: CartOffer | null;
  world: CartOffer | null;
}
export interface CartEntry extends WishlistItem {
  added_at: number;
  /** The shop chosen in the cart; null: the cheapest one. */
  source: string | null;
  scope: CartScope;
  offers: Record<string, ShopOffers>;
}

export interface CartLine {
  item: CartEntry;
  /** Shop and region of the counted offer; the shop also without a price when the entry has one of its own. */
  source: string | null;
  region: string | null;
  /** Key price (base price) in cents; null when there is no price for this shop and scope. */
  base: number | null;
  /** Estimated fee in cents; null when the shop has no fee estimate (or there is no price). */
  fee: number | null;
  /** The price is only the last known one (no current offer). */
  stale: boolean;
  /** The cheapest variant of this game (any shop, any region), for the comparison; null without any offer. */
  cheapest: { source: string; base: number; fee: number | null } | null;
}

export interface ShopSum {
  source: string;
  count: number;
  keys: number;
  fees: number | null;
  total: number;
}

export interface CartSums {
  lines: CartLine[];
  shops: ShopSum[];
  keys: number;
  /** Estimated fees that are known. */
  fees: number;
  /** keys + fees (shops without an estimate count with their key price). */
  total: number;
  unknownFees: string[];
  missing: CartEntry[];
  /**
   * Extra cost of the chosen shops and scopes against the cheapest composition (every game at its cheapest variant), on the
   * key prices and on the totals with fees; null while every entry counts at its cheapest. Games without a price are left out.
   */
  extra: { keys: number; total: number } | null;
}

const fee = (offer: CartOffer) => (offer.estimate_cents !== null && offer.estimate_cents >= offer.cents ? offer.estimate_cents - offer.cents : null);
/** The shop with the lowest key price in a scope; ties keep the alphabetical first. */
function cheapestShop(offers: Record<string, ShopOffers>, scope: CartScope): string | null {
  let best: [string, number] | null = null;
  for (const [source, shop] of Object.entries(offers).sort(([a], [b]) => a.localeCompare(b))) {
    const offer = shop[scope];
    if (offer && offer.cents > 0 && (best === null || offer.cents < best[1])) best = [source, offer.cents];
  }
  return best?.[0] ?? null;
}

/** The cheapest variant of a game: any shop, any region (a target-country price counts too, it may be the last known one). */
function cheapestVariant(offers: Record<string, ShopOffers>): { source: string; offer: CartOffer } | null {
  let best: { source: string; offer: CartOffer } | null = null;
  for (const [source, shop] of Object.entries(offers).sort(([a], [b]) => a.localeCompare(b))) {
    for (const offer of [shop.world, shop.home]) {
      if (offer && offer.cents > 0 && (best === null || offer.cents < best.offer.cents)) best = { source, offer };
    }
  }
  return best;
}

/** No shop and any region: the cheapest variant, what the button on the game page adds. */
const automatic = (entry: CartEntry) => entry.source === null && entry.scope === 'world';

/** The shop an entry counts with: its own, or the cheapest one (in its scope). */
export const entryShop = (entry: CartEntry) =>
  automatic(entry) ? (cheapestVariant(entry.offers ?? {})?.source ?? null) : (entry.source ?? cheapestShop(entry.offers ?? {}, entry.scope));

export function cartLine(item: CartEntry): CartLine {
  const offers = item.offers ?? {};
  const variant = cheapestVariant(offers);
  const cheapest = variant && { source: variant.source, base: variant.offer.cents, fee: fee(variant.offer) };
  const source = entryShop(item);
  const offer = automatic(item) ? (variant?.offer ?? null) : source ? (offers[source]?.[item.scope] ?? null) : null;
  if (!offer || offer.cents <= 0) return { item, source, region: null, base: null, fee: null, stale: false, cheapest };
  return { item, source, region: offer.region, base: offer.cents, fee: fee(offer), stale: offer.stale, cheapest };
}

export function cartSums(entries: CartEntry[]): CartSums {
  const lines = entries.map(cartLine);
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
  const shopSums = [...shops.values()]
    .map(sum => ({ ...sum, total: sum.keys + (sum.fees ?? 0) }))
    .sort((a, b) => b.total - a.total || a.source.localeCompare(b.source));
  const keys = priced.reduce((total, line) => total + line.base!, 0);
  const fees = priced.reduce((total, line) => total + (line.fee ?? 0), 0);
  // Against the cheapest composition: only games that have a price in both, so a missing price is no "saving".
  const compared = priced.filter(line => line.cheapest !== null);
  const chosen = entries.some(entry => entry.source !== null || entry.scope !== 'world');
  const extraKeys = compared.reduce((total, line) => total + line.base! - line.cheapest!.base, 0);
  const extraTotal = compared.reduce((total, line) => total + line.base! + (line.fee ?? 0) - line.cheapest!.base - (line.cheapest!.fee ?? 0), 0);
  return {
    lines,
    shops: shopSums,
    keys,
    fees,
    total: keys + fees,
    unknownFees: shopSums.filter(sum => sum.fees === null).map(sum => sum.source),
    missing: lines.filter(line => line.base === null).map(line => line.item),
    extra: chosen && (extraKeys !== 0 || extraTotal !== 0) ? { keys: extraKeys, total: extraTotal } : null,
  };
}
