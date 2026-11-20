import type { PriceBadgeData, WishlistItem } from '../api';
import { Chip, StatusChip } from '../components';
import { relativeTime } from '../time';
import { itemName, kindName, platformName } from './catalog-ui';
import GameCover from './GameCover';
import PriceBadge, { WorldCompare } from './PriceBadge';

/** Is this entry something the owner has to look at (unconfirmed match, or the shop mapping needs review)? */
export const needsReview = (item: WishlistItem, badge?: PriceBadgeData) => badge?.state === 'review' || item.verification !== 'catalog';

export default function WishlistRow({ item, badge, selected, reached, scopeLabel, onSelect }: { item: WishlistItem; badge?: PriceBadgeData; selected: boolean; reached: boolean; scopeLabel: string; onSelect: () => void }) {
  const stale = !!badge && badge.state === 'price' && badge.stale;
  const kind = item.game ? (item.game.edition_name ?? (item.game.kind === 'base_game' ? 'Standard' : kindName(item.game))) : 'Manuell';
  const staleAt = badge?.observed_at;
  return <button type="button" className={`wishlist-entry ${selected ? 'selected' : ''}`} onClick={onSelect} aria-current={selected ? 'true' : undefined}>
    <GameCover small className="entry-cover" src={item.game?.cover_url} title={itemName(item)} />
    <span className="entry-main">
      <strong>{itemName(item)}</strong>
      <span className="entry-sub">{kind} · {platformName(item.platform_id)}</span>
      <span className="entry-chips">
        {reached && <StatusChip kind="target" />}
        {stale && <Chip kind="stale">Veraltet{staleAt ? ` · ${relativeTime(staleAt)}` : ''}</Chip>}
        {needsReview(item, badge) && <StatusChip kind="warn">{item.game ? 'Prüfen' : 'Ungeprüft'}</StatusChip>}
      </span>
    </span>
    <span className="entry-price"><PriceBadge className="list-price" badge={badge} scopeLabel={scopeLabel} /></span>
    <span className="entry-world"><WorldCompare badge={badge} /></span>
  </button>;
}
