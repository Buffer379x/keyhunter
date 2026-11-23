import { Icon } from '../components';
import type { WishlistItem } from '../api';
import { itemName } from './catalog-ui';
import { reviewAction, wishFlags } from './wish-pause';

const CLASS = { cart: 'in-cart', paused: 'wish-paused', review: 'wish-review' } as const;
const ICON = { cart: 'cart', paused: 'pause', review: 'alert' } as const;

/**
 * The symbols behind a wish's title (1.0.1): basket, pause, warning. The wishlist shows all three; the cart (`showCart` false)
 * leaves the basket out, since every line is in it. The warning is a button (1.1, PROD-03): it opens the game on the
 * Zuordnungen tab (`onReview`). With a coarse pointer it is 44 px to hit, drawn over the card's opener (wishlist.css).
 */
export function WishFlags({ item, showCart = false, onReview }: { item: WishlistItem; showCart?: boolean; onReview: () => void }) {
  return (
    <>
      {wishFlags(item, showCart).map(flag =>
        flag.kind === 'review' ? (
          <button key={flag.kind} type="button" className={CLASS.review} aria-label={reviewAction(item, itemName(item))} title={flag.title} onClick={onReview}>
            <Icon name={ICON.review} size={14} />
          </button>
        ) : (
          <span key={flag.kind} className={CLASS[flag.kind]} role="img" aria-label={flag.label} title={flag.title}>
            <Icon name={ICON[flag.kind]} size={14} />
          </span>
        ),
      )}
    </>
  );
}
