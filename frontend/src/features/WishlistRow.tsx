import { shopNames } from './shop-names';
import type { ReactNode, Ref } from 'react';
import type { PriceBadgeData, WishlistItem } from '../api';
import { Icon, IconButton, Pill, Price, Reg, formatPrice } from '../components';
import { relativeTime } from '../time';
import { itemName, kindName, platformName } from './catalog-ui';
import { countryData } from './regions';
import GameCover from './GameCover';
import { badgeStateText, badgeTitle } from './PriceBadge';
import { WORLD_SHARE, sparkHeights } from './wishlist-model';
import type { RowFacts } from './wishlist-model';
import type { OpenMode, WishlistColumn } from './wishlist-columns';

/** Is this entry something the owner has to look at (unconfirmed match, or the shop mapping needs review)? */
export const needsReview = (item: WishlistItem, badge?: PriceBadgeData) => badge?.state === 'review' || item.verification !== 'catalog';

/** Short region code for the `.reg` badge: ISO codes as they are, "GL" for global, the region keys shortened. */
export function regCode(region: string | null | undefined): { code: string; name: string } | null {
  if (!region?.trim()) return null;
  const data = countryData(region);
  const code = data.code ? data.code.toUpperCase() : data.key === 'GLOBAL' ? 'GL' : data.key.startsWith('REGION_') ? data.key.slice(7) : data.key.slice(0, 3).toUpperCase();
  return { code, name: data.name };
}

/** "Standard Edition · 2021" (manual entries: "Manuell · Xbox Series X|S"). */
function subline(item: WishlistItem) {
  const game = item.game;
  if (!game) return `Manuell · ${platformName(item.platform_id)}`;
  const edition = game.edition_name ?? (game.kind === 'base_game' ? 'Standard Edition' : kindName(game));
  const year = game.first_release_date !== null ? new Date(game.first_release_date * 1000).getUTCFullYear() : null;
  return `${edition} · ${year !== null && Number.isFinite(year) ? year : platformName(item.platform_id)}`;
}

/** Observation time of the shown price (base price or estimated total). */
const observedAt = (badge: PriceBadgeData, facts: RowFacts) => facts.basis === 'estimate' ? badge.with_fees?.observed_at ?? null : badge.observed_at;

/** Text of the "Preis INT" cell (cheapest region worldwide) when nothing is known about prices yet (the status column says whether a search runs). */
function missingWorld(badge: PriceBadgeData | undefined) {
  if (badge?.state === 'no_offer') return 'In keinem Shop gefunden';
  if (badge?.state === 'unknown') return 'Noch nicht abgefragt';
  return badgeStateText(badge);
}

/**
 * The same offer on the other price basis for the title of a price: with base prices the estimated total ("Mit Gebühren
 * geschätzt", the shop fee from the settings), with totals the base price.
 */
function otherText(facts: RowFacts, other: number | null, shop: string) {
  if (facts.basis === 'estimate') return other !== null ? `Grundpreis ${formatPrice(other)}` : null;
  return other !== null ? `Mit Gebühren geschätzt: ${formatPrice(other)}` : `Mit Gebühren: unbekannt, für ${shop || 'diesen Shop'} ist keine Gebührenschätzung eingestellt`;
}

/** Status column: the main state first, then every hint of the row (stale price, unconfirmed match) so nothing is lost. */
function StatusPills({ item, badge, facts }: { item: WishlistItem; badge?: PriceBadgeData; facts: RowFacts }) {
  const pills = [];
  if (badge) {
    if (facts.reached) pills.push(<Pill key="s" tone="ok" icon="check">Ziel erreicht</Pill>);
    else if (facts.over !== null) pills.push(<Pill key="s">{formatPrice(facts.over)} über Ziel</Pill>);
    else if (badge.state === 'unknown') pills.push(badge.pending ? <Pill key="s" tone="dim" icon="refresh">Wird gesucht …</Pill> : <Pill key="s" tone="dim">Noch nicht abgefragt</Pill>);
    else if (badge.state === 'no_offer') pills.push(<Pill key="s" tone="dim">Kein Angebot</Pill>);
    else if (badge.state === 'review') pills.push(<Pill key="s" tone="warn" icon="alert">Zuordnung prüfen</Pill>);
    else if (badge.state === 'error') pills.push(<Pill key="s" tone="danger" icon="alert">Abruf fehlgeschlagen</Pill>);
    if (facts.stale) pills.push(<Pill key="stale" tone="dim" icon="clock">Veraltet{observedAt(badge, facts) ? ` · ${relativeTime(observedAt(badge, facts)!)}` : ''}</Pill>);
  }
  if (item.verification !== 'catalog' && badge?.state !== 'review') pills.push(<Pill key="review" tone="warn" icon="alert">{item.game ? 'Prüfen' : 'Ungeprüft'}</Pill>);
  return pills.length ? <div className="wl-status">{pills}</div> : null;
}

function Spark({ trend, code }: { trend: (number | null)[]; code: string }) {
  const heights = sparkHeights(trend);
  const last = heights.reduce((found, height, index) => height !== null ? index : found, -1);
  return <span className="spark" role="img" aria-label={`Preis ${code} der letzten ${trend.length} Tage`}>
    {heights.map((height, index) => <i key={index} className={index === last ? 'last' : undefined} style={{ height: `${height ?? 0}px` }} />)}
  </span>;
}

/**
 * One row of the wishlist table (`table.wl`): game, target-country price, Preis INT (cheapest region worldwide), saving,
 * alarm target, status, 14-day sparkline and the details button. Exactly one element opens the game, chosen in the settings:
 * the details button, the title or the cover (the row itself is not clickable). The cells are the visible columns in the
 * order of the settings; up to 720 px the CSS turns the row into a card with a fixed layout.
 */
export default function WishlistRow({ item, badge, facts, columns, mode, code, compare, scopeLabel, targetDisabled, openRef, onOpen }: {
  item: WishlistItem; badge?: PriceBadgeData; facts: RowFacts;
  /** Visible columns in the order of the settings. */
  columns: WishlistColumn[];
  /** What opens the game page (settings): the details button, the title or the cover; the other two are plain. */
  mode: OpenMode;
  /** Target country code ("DE"), or "" without one. */
  code: string;
  /** The badge price is the target-country price (price scope "preferred"), so a cheapest region that is not cheaper means the target country is cheapest. */
  compare: boolean;
  scopeLabel: string; targetDisabled: boolean;
  /** The element that opens the game (button, title or cover), so the list can give it the focus back after a visit. */
  openRef?: Ref<HTMLButtonElement>; onOpen: () => void;
}) {
  const title = itemName(item);
  const world = facts.world;
  const worldCheaper = world !== null && (facts.price === null || world.cents < facts.price);
  const reg = world ? regCode(world.region) : null;
  /** The target country itself is the cheapest worldwide: shown like every other region, only slightly highlighted. */
  const homeCheapest = !worldCheaper && compare && world !== null && facts.price !== null;
  // Under each price only the shop; the region of the target-country price is the column itself, the INT region shows as a flag.
  const origin = facts.source ? shopNames[facts.source] ?? facts.source : '';
  const badgeShop = badge?.source ? shopNames[badge.source] ?? badge.source : '';
  /** "Mit Gebühren" without a fee estimate for the shops that have a base price. */
  const feesUnknown = facts.basis === 'estimate' && facts.price === null && badge?.state === 'price';
  const priceTitle = !badge ? undefined : facts.basis === 'estimate'
    ? [badgeTitle({ ...badge, observed_at: observedAt(badge, facts), stale: facts.stale }, scopeLabel), facts.price !== null ? otherText(facts, facts.other, origin) : null].filter(Boolean).join(' · ')
    : [facts.price !== null ? otherText(facts, facts.other, origin) : null, badgeTitle(badge, scopeLabel)].filter(Boolean).join(' · ');
  const worldShop = world?.source ? shopNames[world.source] ?? world.source : '';
  const worldOther = world ? ` ${otherText(facts, world.other, worldShop) ?? ''}`.trimEnd() : '';
  const cover = <GameCover small src={item.game?.cover_url} title={title} />;
  const cells: Record<WishlistColumn, ReactNode> = {
    game: <td key="game" className="c-game"><div className="game-cell">
      {mode === 'cover' ? <button ref={openRef} type="button" className="cover-open" aria-label={`Details zu ${title}`} title="Details öffnen" onClick={onOpen}>{cover}</button> : cover}
      <div className="game-name"><span className="game-title">{mode === 'title' ? <button ref={openRef} type="button" className="title-open" title="Details öffnen" onClick={onOpen}><b>{title}</b></button> : <b>{title}</b>}
        {item.in_cart && <span className="in-cart" role="img" aria-label="im Warenkorb" title="Liegt im Warenkorb"><Icon name="cart" size={14} /></span>}</span><small>{subline(item)}</small></div>
    </div></td>,
    price: <td key="price" className="c-de r" title={feesUnknown ? `Gebühren unbekannt: Für ${badgeShop || 'diesen Shop'} ist keine Gebührenschätzung eingestellt (Einstellungen › Key-Shops).` : priceTitle}>
      {facts.price !== null ? <><Price cents={facts.price} tone={facts.stale ? 'stale' : 'default'} />{origin && <div className="wl-sub">{origin}</div>}</>
        : feesUnknown ? <span className="wl-note faint">Gebühren unbekannt</span> : <span className="faint">–</span>}
    </td>,
    world: <td key="world" className="c-world">
      {worldCheaper ? <><div className="world-cell" title={`Günstigste Region weltweit: ${reg?.name ?? 'Region unbekannt'}. Nicht automatisch im Zielland aktivierbar.${worldOther}`}>{reg && <Reg code={reg.code} />}<Price cents={world.cents} tone="world" /></div>
          {worldShop && <div className="wl-sub">{worldShop}</div>}</>
        : homeCheapest ? <><div className="world-cell home-best" title={`Günstigste Region weltweit: ${reg?.name ?? 'Region unbekannt'}. In ${code || 'deinem Zielland'} gibt es kein günstigeres Angebot.${worldOther}`}>
            {reg && <Reg code={reg.code} home={reg.code === code} />}<Price cents={world!.cents} tone="world" /><span className="sr-only">, im Zielland am günstigsten</span></div>
            {worldShop && <div className="wl-sub">{worldShop}</div>}</>
          : facts.price !== null ? <span className="faint">–</span>
            : <span className="wl-note faint">{feesUnknown ? 'Gebühren unbekannt' : missingWorld(badge)}</span>}
    </td>,
    save: <td key="save" className="c-save r">
      {facts.saving !== null ? <><span className={`save${facts.share! >= WORLD_SHARE - 1e-9 ? ' big' : ''}`}>−{formatPrice(facts.saving)}</span><div className="save-pct faint mono">−{Math.round(facts.share! * 100)} %</div></> : <span className="save none">–</span>}
    </td>,
    target: <td key="target" className="c-target r">{facts.target !== null ? <span className={`mono${targetDisabled ? ' faint' : ''}`} title={targetDisabled ? 'Preisalarm ausgeschaltet' : undefined}>{formatPrice(facts.target)}</span> : <span className="faint">–</span>}</td>,
    status: <td key="status" className="c-status"><StatusPills item={item} badge={badge} facts={facts} /></td>,
    trend: <td key="trend" className="c-trend">{facts.trend && <Spark trend={facts.trend} code={code || 'Zielland'} />}</td>,
    open: <td key="open" className="c-more r"><IconButton ref={openRef} className="row-open" label={`Details zu ${title}`} onClick={onOpen}><Icon name="details" /></IconButton></td>,
  };
  return <tr data-id={item.id}>{columns.map(column => cells[column])}</tr>;
}
