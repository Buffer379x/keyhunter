import { Icon } from '../components';
import type { WishlistItem } from '../api';
import { wishFlags } from './wish-pause';

const CLASS = { cart: 'in-cart', paused: 'wish-paused', review: 'wish-review' } as const;
const ICON = { cart: 'cart', paused: 'pause', review: 'alert' } as const;

/**
 * The symbols behind a wish's title (1.0.1): basket, pause, warning. The wishlist shows all three; the cart (`showCart` false)
 * leaves the basket out, since every line is in it.
 */
export function WishFlags({ item, showCart = false }: { item: WishlistItem; showCart?: boolean }) {
  return (
    <>
      {wishFlags(item, showCart).map(flag => (
        <span key={flag.kind} className={CLASS[flag.kind]} role="img" aria-label={flag.label} title={flag.title}>
          <Icon name={ICON[flag.kind]} size={14} />
        </span>
      ))}
    </>
  );
}
