import { shopNames } from './shop-names';
import type { ReactNode, Ref } from 'react';
import type { PriceBadgeData, PriceChange, WishlistItem } from '../api';
import { Cover, Icon, IconButton, Pill, Price, Reg, StatePill, formatPrice } from '../components';
import { relativeTime } from '../time';
import { itemName, kindName, platformName } from './catalog-ui';
import { countryData } from './regions';
import { WishFlags } from './WishFlags';
import { badgeTitle } from './price-badge-text';
import { WORLD_SHARE, sparkHeights } from './wishlist-model';
import type { RowFacts } from './wishlist-model';
import type { OpenMode, WishlistColumn } from './wishlist-columns';

/** Short region code for the `.reg` badge: ISO codes as they are, "GL" for global, the region keys shortened. */
export function regCode(region: string | null | undefined): { code: string; name: string } | null {
  if (!region?.trim()) return null;
  const data = countryData(region);
  const code = data.code
    ? data.code.toUpperCase()
    : data.key === 'GLOBAL'
      ? 'GL'
      : data.key.startsWith('REGION_')
        ? data.key.slice(7)
        : data.key.slice(0, 3).toUpperCase();
  return { code, name: data.name };
}

/** "38 Angebote" after the year (0.9.1); nothing for an item without a price badge. */
const offerText = (item: WishlistItem) => (item.offer_count === undefined ? '' : ` (${item.offer_count} ${item.offer_count === 1 ? 'Angebot' : 'Angebote'})`);
/**
 * "Standard Edition · Xbox One" (manual entries: "Manuell · Xbox One"). 1.0 (RESP-10): the wish's own platform instead of the
 * release year, so the same game for two systems stays apart; the year stands on the game page.
 */
function subline(item: WishlistItem) {
  const game = item.game;
  const edition = !game ? 'Manuell' : (game.edition_name ?? (game.kind === 'base_game' ? 'Standard Edition' : kindName(game)));
  return `${edition} · ${platformName(item.platform_id)}${offerText(item)}`;
}

/** Observation time of the shown price (base price or estimated total). */
const observedAt = (badge: PriceBadgeData, facts: RowFacts) => (facts.basis === 'estimate' ? (badge.with_fees?.observed_at ?? null) : badge.observed_at);

/** What the server knows about the cheapest region in the target country (RESP-14), for the title of the INT price. */
function activationText(activation: 'confirmed' | 'blocked' | 'unknown' | null, code: string) {
  const land = code || 'dem Zielland';
  return activation === 'blocked'
    ? `Laut Shop in ${land} nicht aktivierbar.`
    : activation === 'confirmed'
      ? `In ${land} aktivierbar, aber nicht im selben Markt.`
      : `Aktivierung in ${land} ungeklärt.`;
}

/**
 * The same offer on the other price basis for the title of a price: with base prices the estimated total ("Mit Gebühren
 * geschätzt", the shop fee from the settings), with totals the base price.
 */
function otherText(facts: RowFacts, other: number | null, shop: string) {
  if (facts.basis === 'estimate') return other !== null ? `Grundpreis ${formatPrice(other)}` : null;
  return other !== null
    ? `Mit Gebühren geschätzt: ${formatPrice(other)}`
    : `Mit Gebühren: unbekannt, für ${shop || 'diesen Shop'} ist keine Gebührenschätzung eingestellt`;
}

/**
 * Status column: the main state first, then every hint of the row (stale price, unconfirmed match) so nothing is lost.
 * The only place of the row that names a missing price; the price cells show "–" (DS-04).
 */
function StatusPills({ item, badge, facts }: { item: WishlistItem; badge?: PriceBadgeData; facts: RowFacts }) {
  const pills = [];
  if (badge) {
    if (facts.reached) pills.push(<StatePill key="s" state="reached" />);
    else if (facts.over !== null) pills.push(<Pill key="s">{formatPrice(facts.over)} über Ziel</Pill>);
    else if (badge.state === 'unknown')
      pills.push(
        badge.pending ? (
          <StatePill key="s" state="searching" />
        ) : (
          <StatePill key="s" state="missing">
            Noch nicht abgefragt
          </StatePill>
        ),
      );
    else if (badge.state === 'no_offer')
      pills.push(
        <StatePill key="s" state="missing">
          Kein Angebot
        </StatePill>,
      );
    else if (badge.state === 'review') pills.push(<StatePill key="s" state="review" />);
    else if (badge.state === 'error') pills.push(<StatePill key="s" state="error" />);
    if (facts.stale)
      pills.push(
        <StatePill key="stale" state="stale">
          Veraltet{observedAt(badge, facts) ? ` · ${relativeTime(observedAt(badge, facts)!)}` : ''}
        </StatePill>,
      );
  }
  if (item.verification !== 'catalog' && badge?.state !== 'review')
    pills.push(
      <StatePill key="review" state="review">
        {item.game ? 'Prüfen' : 'Ungeprüft'}
      </StatePill>,
    );
  return pills.length ? <div className="wl-status">{pills}</div> : null;
}

/** Direction of the price-change arrows, a setting (1.1.3). */
export type TrendArrows = 'price' | 'rating';
/**
 * Last price change (1.1.2), after the price of Preis DE and Preis INT (1.1.5, outside the green box): green when the price fell, red when it rose, a grey arrow right
 * when it stayed the same over the 14 days of the trend. With `arrows` "price" (the default since 1.1.3) the arrow follows the
 * price, green pointing down; with "rating" it says better or worse, green pointing up. The title names the amount, the price
 * before and when it changed.
 */
function Change({ price, change, arrows }: { price: number; change: PriceChange; arrows: TrendArrows }) {
  const before = change.previous_cents;
  const when = change.changed_at !== null ? ` (${relativeTime(change.changed_at)})` : '';
  const [tone, text] =
    change.changed_at === null || price === before
      ? ['same', 'Unverändert in den letzten 14 Tagen']
      : price < before
        ? ['better', `Günstiger geworden${when}: −${formatPrice(before - price)}, vorher ${formatPrice(before)}`]
        : ['worse', `Teurer geworden${when}: +${formatPrice(price - before)}, vorher ${formatPrice(before)}`];
  // "price": the arrow follows the price (cheaper = down); "rating": up is better (1.1.2 look).
  const direction = tone === 'same' ? 'right' : (tone === 'better') === (arrows === 'rating') ? 'up' : 'down';
  return (
    <span className={`price-change ${tone} ${direction}`} title={text} role="img" aria-label={text}>
      <Icon name="arrow" size={12} />
    </span>
  );
}

function Spark({ trend, code }: { trend: (number | null)[]; code: string }) {
  const heights = sparkHeights(trend);
  const last = heights.reduce((found, height, index) => (height !== null ? index : found), -1);
  return (
    <span className="spark" role="img" aria-label={`Preis ${code} der letzten ${trend.length} Tage`}>
      {heights.map((height, index) => (
        <i key={index} className={index === last ? 'last' : undefined} style={{ height: `${height ?? 0}px` }} />
      ))}
    </span>
  );
}

/**
 * One row of the wishlist table (`table.wl`): game, target-country price, Preis INT (cheapest region worldwide), saving,
 * alarm target, status, 14-day sparkline and the details button. Exactly one element opens the game, chosen in the settings:
 * the details button, the title or the cover. The cells are the visible columns in the order of the settings. When the list's
 * own box is narrow (wishlist.css, container query) the CSS turns the row into a card with a fixed layout: the prices carry
 * their label there (`data-label`, shown by the CSS only on the card), and the opener covers the whole card, so a tap anywhere on it opens the game (1.0).
 * The warning triangle after the title lies above it and opens the Zuordnungen tab instead (1.1, PROD-03).
 */
export default function WishlistRow({
  item,
  badge,
  facts,
  columns,
  mode,
  arrows = 'price',
  code,
  compare,
  scopeLabel,
  targetDisabled,
  openRef,
  onOpen,
  onReview,
}: {
  item: WishlistItem;
  badge?: PriceBadgeData;
  facts: RowFacts;
  /** Visible columns in the order of the settings. */
  columns: WishlistColumn[];
  /** What opens the game page (settings): the details button, the title or the cover; the other two are plain. */
  mode: OpenMode;
  /** Direction of the price-change arrows (settings, 1.1.3). */
  arrows?: TrendArrows;
  /** Target country code ("DE"), or "" without one. */
  code: string;
  /** The badge price is the target-country price (price scope "preferred"), so a cheapest region that is not cheaper means the target country is cheapest. */
  compare: boolean;
  scopeLabel: string;
  targetDisabled: boolean;
  /** The element that opens the game (button, title or cover), so the list can give it the focus back after a visit. */
  openRef?: Ref<HTMLButtonElement>;
  onOpen: () => void;
  /** The warning triangle: opens the game on the Zuordnungen tab (1.1, PROD-03). */
  onReview: () => void;
}) {
  const title = itemName(item);
  const world = facts.world;
  const worldCheaper = world !== null && (facts.price === null || world.cents < facts.price);
  const reg = world ? regCode(world.region) : null;
  /** The target country itself is the cheapest worldwide: shown like every other region, only slightly highlighted. */
  const homeCheapest = !worldCheaper && compare && world !== null && facts.price !== null;
  // Under each price only the shop; the region of the target-country price is the column itself, the INT region shows as a flag.
  const origin = facts.source ? (shopNames[facts.source] ?? facts.source) : '';
  const badgeShop = badge?.source ? (shopNames[badge.source] ?? badge.source) : '';
  /** "Mit Gebühren" without a fee estimate for the shops that have a base price. */
  const feesUnknown = facts.basis === 'estimate' && facts.price === null && badge?.state === 'price';
  const priceTitle = !badge
    ? undefined
    : facts.basis === 'estimate'
      ? [
          badgeTitle({ ...badge, observed_at: observedAt(badge, facts), stale: facts.stale }, scopeLabel),
          facts.price !== null ? otherText(facts, facts.other, origin) : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : [facts.price !== null ? otherText(facts, facts.other, origin) : null, badgeTitle(badge, scopeLabel)].filter(Boolean).join(' · ');
  const worldShop = world?.source ? (shopNames[world.source] ?? world.source) : '';
  const worldOther = world ? ` ${otherText(facts, world.other, worldShop) ?? ''}`.trimEnd() : '';
  const cover = <Cover src={item.game?.cover_url} title={title} />;
  /** No price on either side yet: the card shows only the status pill, not the same statement a second time in the price cells (1.0). */
  const noPrices = facts.price === null && world === null && !!badge && badge.state !== 'price';
  const cells: Record<WishlistColumn, ReactNode> = {
    game: (
      <td key="game" className="c-game">
        <div className="game-cell">
          {mode === 'cover' ? (
            <button ref={openRef} type="button" className="cover-open" aria-label={`Details zu ${title}`} title="Details öffnen" onClick={onOpen}>
              {cover}
            </button>
          ) : (
            cover
          )}
          <div className="game-name">
            <span className="game-title">
              {mode === 'title' ? (
                <button ref={openRef} type="button" className="title-open" title="Details öffnen" onClick={onOpen}>
                  <b>{title}</b>
                </button>
              ) : (
                <b>{title}</b>
              )}
              <WishFlags item={item} showCart onReview={onReview} />
            </span>
            <small>{subline(item)}</small>
          </div>
        </div>
      </td>
    ),
    price: (
      <td
        key="price"
        className="c-de r"
        data-label={code ? `Preis ${code}` : 'Preis'}
        title={
          feesUnknown
            ? `Gebühren unbekannt: Für ${badgeShop || 'diesen Shop'} ist keine Gebührenschätzung eingestellt (Einstellungen › Key-Shops).`
            : priceTitle
        }
      >
        {facts.price !== null ? (
          <>
            <span className="price-line">
              <Price cents={facts.price} tone={facts.stale ? 'stale' : 'default'} />
              {facts.change && <Change price={facts.price} change={facts.change} arrows={arrows} />}
            </span>
            {origin && <div className="wl-sub">{origin}</div>}
          </>
        ) : feesUnknown ? (
          <span className="wl-note muted">Gebühren unbekannt</span>
        ) : (
          <span className="faint">–</span>
        )}
      </td>
    ),
    world: (
      <td key="world" className="c-world" data-label="Preis INT">
        {worldCheaper ? (
          <>
            <div
              className="world-cell"
              title={`Günstigste Region weltweit: ${reg?.name ?? 'Region unbekannt'}. ${activationText(world.activation, code)}${worldOther}`}
            >
              {reg && <Reg code={reg.code} />}
              <Price cents={world.cents} tone="world" />
              {world.change && <Change price={world.cents} change={world.change} arrows={arrows} />}
            </div>
            {worldShop && <div className="wl-sub">{worldShop}</div>}
          </>
        ) : homeCheapest ? (
          <>
            {/* 1.1.5: the arrow stands beside the green box, not inside it. */}
            <div className="world-line">
              <div
                className="world-cell home-best"
                title={`Günstigste Region weltweit: ${reg?.name ?? 'Region unbekannt'}. In ${code || 'deinem Zielland'} gibt es kein günstigeres Angebot.${worldOther}`}
              >
                {reg && <Reg code={reg.code} home={reg.code === code} />}
                <Price cents={world!.cents} tone="world" />
                <span className="sr-only">, im Zielland am günstigsten</span>
              </div>
              {world!.change && <Change price={world!.cents} change={world!.change} arrows={arrows} />}
            </div>
            {worldShop && <div className="wl-sub">{worldShop}</div>}
          </>
        ) : feesUnknown ? (
          <span className="wl-note muted">Gebühren unbekannt</span>
        ) : (
          <span className="faint">–</span>
        )}
      </td>
    ),
    save: (
      <td key="save" className="c-save r">
        {facts.saving !== null ? (
          <>
            <span className={`save${facts.share! >= WORLD_SHARE - 1e-9 ? ' big' : ''}`}>−{formatPrice(facts.saving)}</span>
            <div className="save-pct muted mono">−{Math.round(facts.share! * 100)} %</div>
          </>
        ) : (
          <span className="save none">–</span>
        )}
      </td>
    ),
    target: (
      <td key="target" className="c-target r">
        {facts.target !== null ? (
          <span className={`mono${targetDisabled ? ' faint' : ''}`} title={targetDisabled ? 'Preisalarm ausgeschaltet' : undefined}>
            {formatPrice(facts.target)}
          </span>
        ) : (
          <span className="faint">–</span>
        )}
      </td>
    ),
    status: (
      <td key="status" className="c-status">
        <StatusPills item={item} badge={badge} facts={facts} />
      </td>
    ),
    trend: (
      <td key="trend" className="c-trend">
        {facts.trend && <Spark trend={facts.trend} code={code || 'Zielland'} />}
      </td>
    ),
    open: (
      <td key="open" className="c-more r">
        <IconButton ref={openRef} className="row-open" label={`Details zu ${title}`} onClick={onOpen}>
          <Icon name="details" />
        </IconButton>
      </td>
    ),
  };
  return (
    <tr data-id={item.id} className={noPrices ? 'no-prices' : undefined}>
      {columns.map(column => cells[column])}
    </tr>
  );
}
