import { useCallback, useEffect, useState } from 'react';
import type { CatalogGame, EditionsView, PriceBadgeData, WishlistItem } from '../api';
import { api, CART_CHANGED } from '../api';
import { ConfirmDialog, Notice } from '../components';
import { notify, notifyError } from '../notify';
import { whenVisible } from '../poll';
import { fromList, listDepth, navigate, useRoute } from '../route';
import type { TabId } from '../route';
import { itemName } from './catalog-ui';
import { shopNames } from './shop-names';
import { pauseText } from './wish-pause';

/** What the open game shares with the wishlist it belongs to. */
interface WishList {
  targetCountry: string | null;
  badges: Record<string, PriceBadgeData>;
  updateBadges: (entries: Record<string, PriceBadgeData>) => void;
  /** Fields of the wish changed by an action (cart, pause). */
  patch: (id: string, fields: Partial<WishlistItem>) => void;
  /** The wish left the wishlist (removed, or bought into the library): the list drops it and the game closes. */
  drop: (item: WishlistItem, reason: 'removed' | 'purchased') => void;
}

/**
 * The open game of the wishlist (`?item=`): its editions (prepared on the server on first open) and the edition
 * shown as a preview, the tab, and the actions of its page with their confirmations (remove, bought).
 */
export function useWishDetail(selected: WishlistItem | undefined, { targetCountry, badges, updateBadges, patch, drop }: WishList) {
  const { tab } = useRoute();
  const [preview, setPreview] = useState<WishlistItem | null>(null);
  const [editionItems, setEditionItems] = useState<WishlistItem[]>([]);
  const [editionError, setEditionError] = useState('');
  const [carting, setCarting] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [removeItem, setRemoveItem] = useState<WishlistItem | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState('');
  /** "Gekauft" asks first (RESP-13): it ends the alarm and the cart entry, and the way back is in the library. */
  const [confirmPurchase, setConfirmPurchase] = useState(false);
  const [purchasing, setPurchasing] = useState(false);
  const [purchaseError, setPurchaseError] = useState('');
  const updateBadge = useCallback((id: string, badge: PriceBadgeData) => updateBadges({ [id]: badge }), [updateBadges]);

  useEffect(() => {
    setPreview(null);
    setEditionItems([]);
    setEditionError('');
    if (!selected?.game) return;
    const controller = new AbortController();
    let cancel = () => {};
    async function prepare(method = 'POST') {
      try {
        const data = await api<EditionsView>(`/wishlist/${selected!.id}/editions`, method, method === 'POST' ? {} : undefined, controller.signal);
        if (controller.signal.aborted) return;
        setEditionItems(data.items);
        setEditionError(data.error ?? (data.preparing ? 'Editionen werden vorbereitet …' : ''));
        updateBadges(Object.fromEntries(data.items.flatMap(item => (item.price_badge ? [[item.id, item.price_badge]] : []))));
        if (data.preparing) cancel = whenVisible(() => void prepare('GET'), 3000);
      } catch (error) {
        if (!controller.signal.aborted) setEditionError(error instanceof Error ? error.message : 'Editionen konnten nicht geladen werden.');
      }
    }
    void prepare();
    return () => {
      controller.abort();
      cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run only when the selected game's identity changes, not on every field of `selected`
  }, [selected?.id, selected?.game?.igdb_id, selected?.platform_id, updateBadges]);

  function chooseEdition(game: CatalogGame) {
    if (!selected) return;
    if (game.igdb_id === selected.game?.igdb_id) setPreview(null);
    else {
      const prepared = editionItems.find(item => item.game?.igdb_id === game.igdb_id);
      if (prepared) setPreview(prepared);
    }
  }
  /** A tab is a history entry of its own; a game opened from the list counts it, so the way back skips it. */
  function changeTab(value: TabId) {
    const depth = listDepth();
    navigate({ tab: value === 'preis' ? null : value, item: selected?.id }, { state: fromList(depth ? depth + 1 : 0) });
  }
  async function remove() {
    if (!removeItem || removing) return;
    setRemoving(true);
    setRemoveError('');
    try {
      await api(`/wishlist/${encodeURIComponent(removeItem.id)}`, 'DELETE');
      drop(removeItem, 'removed');
      notify(`${itemName(removeItem)} wurde aus der Wunschliste entfernt.`);
      setRemoveItem(null);
    } catch (e) {
      setRemoveError(e instanceof Error ? e.message : 'Entfernen fehlgeschlagen.');
      notifyError(e);
    } finally {
      setRemoving(false);
    }
  }
  /** The cart button: in or out, once per wish (0.8.0). */
  async function toggleCart() {
    if (!selected || preview || carting) return;
    const inCart = !!selected.in_cart;
    setCarting(true);
    try {
      if (inCart) await api(`/cart/${encodeURIComponent(selected.id)}`, 'DELETE');
      else await api('/cart', 'POST', { wish_id: selected.id });
      patch(selected.id, { in_cart: !inCart });
      window.dispatchEvent(new Event(CART_CHANGED));
      notify(inCart ? `${itemName(selected)} ist nicht mehr im Warenkorb.` : `${itemName(selected)} liegt jetzt im Warenkorb.`);
    } catch (error) {
      notifyError(error);
    } finally {
      setCarting(false);
    }
  }
  /** Pause the wish's checks until a date or until resumed, or resume them (0.9.0). */
  async function pauseWish(until: number | null | false) {
    if (!selected || preview || pausing) return;
    setPausing(true);
    try {
      const next = await api<WishlistItem>(
        `/wishlist/${encodeURIComponent(selected.id)}/pause`,
        'PUT',
        until === false ? { paused: false } : { paused: true, until },
      );
      patch(selected.id, { paused: next.paused, paused_until: next.paused_until });
      notify(until === false ? `Die Abfragen für ${itemName(selected)} laufen wieder.` : `${itemName(selected)}: ${pauseText(next)}.`);
    } catch (error) {
      notifyError(error);
    } finally {
      setPausing(false);
    }
  }
  /** An offer from the Angebote tab: into the cart with its shop and scope, or the entry switched to it when already there. */
  async function cartOffer(source: string, scope: 'home' | 'world') {
    if (!selected || preview || carting) return;
    setCarting(true);
    try {
      if (selected.in_cart) await api(`/cart/${encodeURIComponent(selected.id)}`, 'PUT', { source, scope });
      else await api('/cart', 'POST', { wish_id: selected.id, source, scope });
      patch(selected.id, { in_cart: true });
      window.dispatchEvent(new Event(CART_CHANGED));
      const shop = shopNames[source] ?? source;
      notify(`${itemName(selected)} liegt im Warenkorb: ${shop}, ${scope === 'home' ? `Preis ${targetCountry?.toUpperCase() || 'Zielland'}` : 'Preis INT'}.`);
    } catch (error) {
      notifyError(error);
    } finally {
      setCarting(false);
    }
  }
  async function purchase() {
    if (!selected || preview || purchasing) return;
    setPurchasing(true);
    setPurchaseError('');
    try {
      await api(`/wishlist/${selected.id}/purchase`, 'POST', {});
      setConfirmPurchase(false);
      drop(selected, 'purchased');
      notify(`${itemName(selected)} wurde in die Bibliothek verschoben.`);
    } catch (error) {
      setPurchaseError(error instanceof Error ? error.message : 'Verschieben fehlgeschlagen.');
      notifyError(error);
    } finally {
      setPurchasing(false);
    }
  }

  const variants = editionItems.flatMap(item => (item.game ? [item.game] : []));
  if (selected?.game && !variants.some(g => g.igdb_id === selected.game?.igdb_id)) variants.unshift(selected.game);
  variants.sort((a, b) => (a.version_parent ? 1 : 0) - (b.version_parent ? 1 : 0) || a.igdb_id - b.igdb_id);
  const open = selected && {
    item: selected,
    viewed: preview ?? selected,
    preview: !!preview,
    variants,
    editionItems,
    editionError,
    badges,
    onBadge: updateBadge,
    tab,
    onTab: changeTab,
    carting,
    pausing,
    purchasing,
    onCart: () => void toggleCart(),
    onPause: (until: number | null | false) => void pauseWish(until),
    onCartOffer: (source: string, scope: 'home' | 'world') => void cartOffer(source, scope),
    onPurchase: () => {
      setPurchaseError('');
      setConfirmPurchase(true);
    },
    onRemove: () => {
      setRemoveError('');
      setRemoveItem(selected);
    },
    onView: chooseEdition,
    onClearPreview: () => setPreview(null),
  };
  const dialogs = {
    selected,
    removeItem,
    removing,
    removeError,
    onRemove: () => void remove(),
    onKeep: () => setRemoveItem(null),
    confirmPurchase,
    purchasing,
    purchaseError,
    onPurchase: () => void purchase(),
    onCancelPurchase: () => setConfirmPurchase(false),
  };
  return { open, dialogs };
}
/** The open game's page state for GameDetail. */
export type OpenWish = NonNullable<ReturnType<typeof useWishDetail>['open']>;

/** The confirmations of the game page: remove from the wishlist, and bought. */
export function WishDialogs({ dialogs }: { dialogs: ReturnType<typeof useWishDetail>['dialogs'] }) {
  const { selected, removeItem } = dialogs;
  return (
    <>
      <ConfirmDialog
        open={removeItem !== null}
        title="Titel entfernen?"
        confirmLabel="Entfernen bestätigen"
        danger
        cancelLabel="Behalten"
        busy={dialogs.removing}
        onCancel={dialogs.onKeep}
        onConfirm={dialogs.onRemove}
      >
        <p>„{removeItem ? itemName(removeItem) : ''}“ wird aus deiner Wunschliste entfernt.</p>
        {dialogs.removeError && <Notice error>{dialogs.removeError}</Notice>}
      </ConfirmDialog>
      <ConfirmDialog
        open={dialogs.confirmPurchase && !!selected}
        title="Als gekauft markieren?"
        confirmLabel="In die Bibliothek verschieben"
        cancelLabel="Abbrechen"
        busy={dialogs.purchasing}
        onCancel={dialogs.onCancelPurchase}
        onConfirm={dialogs.onPurchase}
      >
        <p>
          „{selected ? itemName(selected) : ''}“ kommt in die Bibliothek. Die Preisabfragen und der Preisalarm enden
          {selected?.in_cart ? ', der Eintrag im Warenkorb wird entfernt' : ''}. Zurück geht es über die Bibliothek.
        </p>
        {dialogs.purchaseError && <Notice error>{dialogs.purchaseError}</Notice>}
      </ConfirmDialog>
    </>
  );
}
