import { shopNames } from './shop-names';
import type { Ref } from 'react';
import type { PriceBadgeData, WishlistItem } from '../api';
import { Icon, IconButton, Pill, Price, Reg, formatPrice } from '../components';
import { relativeTime } from '../time';
import { itemName, kindName, platformName } from './catalog-ui';
import { countryData } from './regions';
import GameCover from './GameCover';
import { badgeStateText, badgeTitle } from './PriceBadge';
import { WORLD_SHARE, sparkHeights } from './wishlist-model';
import type { RowFacts } from './wishlist-model';

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

/** Text of the "Günstigste Region" cell when nothing is known about prices yet (the status column says whether a search runs). */
function missingWorld(badge: PriceBadgeData | undefined) {
  if (badge?.state === 'no_offer') return 'In keinem Shop gefunden';
  if (badge?.state === 'unknown') return 'Noch nicht abgefragt';
  return badgeStateText(badge);
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
    if (badge.state === 'price' && badge.stale) pills.push(<Pill key="stale" tone="dim" icon="clock">Veraltet{badge.observed_at ? ` · ${relativeTime(badge.observed_at)}` : ''}</Pill>);
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
 * One row of the wishlist table (`table.wl`): game, target-country price, cheapest region, saving, alarm target, status,
 * 14-day sparkline and the details button, which opens the game (the row itself is not clickable). Up to 720 px the CSS turns it into a card.
 */
export default function WishlistRow({ item, badge, facts, code, compare, scopeLabel, targetDisabled, openRef, onOpen }: {
  item: WishlistItem; badge?: PriceBadgeData; facts: RowFacts;
  /** Target country code ("DE"), or "" without one. */
  code: string;
  /** The badge price is the target-country price (price scope "preferred"), so a cheapest region that is not cheaper means the target country is cheapest. */
  compare: boolean;
  scopeLabel: string; targetDisabled: boolean;
  /** The details button, so the list can give it the focus back after a visit to the game. */
  openRef?: Ref<HTMLButtonElement>; onOpen: () => void;
}) {
  const title = itemName(item);
  const world = facts.world;
  const worldCheaper = world !== null && (facts.price === null || world.cents < facts.price);
  const reg = world ? regCode(world.region) : null;
  /** The target country itself is the cheapest worldwide: shown like every other region, only slightly highlighted. */
  const homeCheapest = !worldCheaper && compare && world !== null && facts.price !== null;
  const origin = [badge?.source ? shopNames[badge.source] ?? badge.source : null, badge?.region ? countryData(badge.region).name : null].filter(Boolean).join(' · ');
  return <tr data-id={item.id}>
    <td className="c-game"><div className="game-cell"><GameCover small src={item.game?.cover_url} title={title} /><div className="game-name"><b>{title}</b><small>{subline(item)}</small></div></div></td>
    <td className="c-de r" title={badge ? badgeTitle(badge, scopeLabel) : undefined}>
      {facts.price !== null ? <><Price cents={facts.price} tone={badge?.stale ? 'stale' : 'default'} />{origin && <div className="wl-sub">{origin}</div>}</> : <span className="faint">–</span>}
    </td>
    <td className="c-world">
      {worldCheaper ? <div className="world-cell" title={`Günstigste Region weltweit: ${reg?.name ?? 'Region unbekannt'}. Nicht automatisch im Zielland aktivierbar.`}>{reg && <Reg code={reg.code} />}<Price cents={world.cents} tone="world" /></div>
        : homeCheapest ? <div className="world-cell home-best" title={`Günstigste Region weltweit: ${reg?.name ?? 'Region unbekannt'}. In ${code || 'deinem Zielland'} gibt es kein günstigeres Angebot.`}>
            {reg && <Reg code={reg.code} home={reg.code === code} />}<Price cents={world!.cents} tone="world" /><span className="sr-only">, im Zielland am günstigsten</span></div>
          : facts.price !== null ? <span className="faint">–</span>
            : <span className="wl-note faint">{missingWorld(badge)}</span>}
    </td>
    <td className="c-save r">
      {facts.saving !== null ? <><span className={`save${facts.share! >= WORLD_SHARE - 1e-9 ? ' big' : ''}`}>−{formatPrice(facts.saving)}</span><div className="save-pct faint mono">−{Math.round(facts.share! * 100)} %</div></> : <span className="save none">–</span>}
    </td>
    <td className="c-target r">{facts.target !== null ? <span className={`mono${targetDisabled ? ' faint' : ''}`} title={targetDisabled ? 'Preisalarm ausgeschaltet' : undefined}>{formatPrice(facts.target)}</span> : <span className="faint">–</span>}</td>
    <td className="c-status"><StatusPills item={item} badge={badge} facts={facts} /></td>
    <td className="c-trend">{facts.trend && <Spark trend={facts.trend} code={code || 'Zielland'} />}</td>
    <td className="c-more r"><IconButton ref={openRef} className="row-open" label={`Details zu ${title}`} onClick={onOpen}><Icon name="details" /></IconButton></td>
  </tr>;
}
