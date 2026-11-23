import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AlertEvent, CatalogGame, EditionsView, PriceBadgeData, WishlistItem } from '../api';
import { api, CART_CHANGED } from '../api';
import { useFetchStatus } from '../fetch-status';
import { Button, ConfirmDialog, EmptyState, Field, Help, Icon, Inset, Kpi, Notice, Panel, PanelHead, Seg, formatPrice } from '../components';
import CatalogSearch from './CatalogSearch';
import FirstSteps from './FirstSteps';
import { openSection } from './settings/sections';
import GameDetail, { parseTab } from './GameDetail';
import type { TabId } from './GameDetail';
import WishlistRow from './WishlistRow';
import { mergeBadges } from './price-badges';
import type { Rule } from './PriceAlerts';
import { nextSort, parseSort, serializeSort, sortWishlist } from './wishlist-sort';
import type { SortKey, WishlistSort } from './wishlist-sort';
import { addedTicks, alarmSentToday, cheaperKpi, fetchKpi, filterShops, matchesChip, matchesText, reachedTrend, rowFacts, shortTitle } from './wishlist-model';
import { shopNames } from './shop-names';
import { pauseText } from './wish-pause';
import { PageSize, Pager, pageCount, useListView } from './list-view';
import type { ChipFilter, PriceBasis, Row, RowFacts } from './wishlist-model';
import { itemName } from './catalog-ui';
import { badgePollDelay, whenVisible } from '../poll';
import { columnOrder, openMode, visibleColumns } from './wishlist-columns';
import type { WishlistColumn } from './wishlist-columns';
import { notify } from '../notify';

interface Props {
  csrf: string;
  targetCountry: string | null;
  targetLabel: string;
  /** Column order, hidden columns and what opens the game page, from the settings (missing = defaults). */
  columns?: string[];
  hidden?: string[];
  opener?: string;
  /** Order and hidden columns of the offers table on the game page (0.8.2). */
  offersColumns?: string[];
  offersHidden?: string[];
  /** The add dialog; the top bar's "Spiel hinzufügen" opens it, so the state lives in the shell. */
  addOpen: boolean;
  onAddOpen: (open: boolean) => void;
  /** For the first steps (PROD-02): the IGDB state and whether a key shop is on; undefined while unknown. */
  indexState?: string;
  shopsActive?: boolean;
  /** Title of the open game for the breadcrumb (null without a selection). */
  onTitle: (title: string | null) => void;
  onSettings: () => void;
  onCountChange: (count: number) => void;
  onError: (error: unknown) => void;
}

/**
 * Sortable column header: the first click sorts in the column's natural direction, the second reverses it, the third returns to
 * "newest first". `aria-sort` tells screen readers the state; on the cards (narrow list) the headers become a row of sort buttons above them.
 */
function SortHeader({
  id,
  sort,
  onSort,
  right = false,
  className = '',
  children,
}: {
  id: SortKey;
  sort: WishlistSort;
  onSort: (key: SortKey) => void;
  right?: boolean;
  className?: string;
  children: string;
}) {
  const active = sort.key === id;
  return (
    <th className={`${className}${right ? ' r' : ''}`.trim() || undefined} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        className={`th-sort${active ? ' on' : ''}`}
        onClick={() => onSort(id)}
        title={active ? (sort.dir === 'asc' ? 'Aufsteigend sortiert' : 'Absteigend sortiert') : `Nach ${children} sortieren`}
      >
        {children}
        <Icon name={active && sort.dir === 'desc' ? 'down' : 'up'} />
      </button>
    </th>
  );
}
const SORT_KEY = 'keyhunter.wishlist.sort';
const BASIS_KEY = 'keyhunter.wishlist.basis';
const PAUSED_KEY = 'keyhunter.wishlist.has-paused';
/** Key-shops the list filter knows by name (IGDB is a catalog, not a shop). */
const SHOP_NAMES = Object.fromEntries(Object.entries(shopNames).filter(([id]) => id !== 'igdb'));
/**
 * History state of a game opened from the list: the number of history entries since the list (opening the game plus
 * every tab change). "Zur Wunschliste" goes back that many steps, so the list entry with its scroll position is reused.
 */
const FROM_LIST = 'keyhunter.wishlist';
const listDepth = () => Number((window.history.state as Record<string, unknown> | null)?.[FROM_LIST]) || 0;
/** Return from a game opened from the list by going back in history (the breadcrumb uses it too). False for a deep link. */
export function returnToList(): boolean {
  const depth = listDepth();
  if (depth) window.history.go(-depth);
  return depth > 0;
}
const routeTab = (): TabId => {
  const url = new URL(window.location.href);
  const tab = parseTab(url.searchParams.get('tab'));
  if (tab) return tab;
  return url.hash === '#alert-editor-title' ? 'alarm' : 'preis';
};
const routeSelection = () => new URL(window.location.href).searchParams.get('item');
const routeFilter = () => new URL(window.location.href).searchParams.get('filter') ?? '';
const scroller = () => document.getElementById('main-content');
type AlertRules = Record<string, Rule>;
const CHIPS: ChipFilter[] = ['alle', 'ziel', 'welt', 'offen', 'pause'];
const chipLabels: [ChipFilter, string][] = [
  ['alle', 'Alle'],
  ['ziel', 'Ziel erreicht'],
  ['welt', 'Weltweit günstiger'],
  ['offen', 'Ohne Preis'],
  ['pause', 'Pausiert'],
];
const count = (value: number) => value.toLocaleString('de-DE');
/** A tile without a footer value keeps an empty footer row, so all four tiles stay the same height. */
const emptyFoot = <span aria-hidden="true">{'\u00a0'}</span>;

/**
 * Wishlist page: the list (KPI tiles, filter chips, table) or, with `?item=`, the game detail as its own full-width page.
 * The list state (filter, sort, scroll position) survives a visit to a game; browser back returns to the same place.
 */
export default function Wishlist({
  csrf,
  targetCountry,
  targetLabel,
  columns,
  hidden,
  opener,
  offersColumns,
  offersHidden,
  addOpen,
  onAddOpen,
  indexState,
  shopsActive,
  onTitle,
  onSettings,
  onCountChange,
  onError,
}: Props) {
  const [items, setItems] = useState<WishlistItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  /** Messages after an action are popups at the bottom right (0.9.1). */
  // The view (chip, search, page size, page) is kept when the owner leaves the list and comes back (0.9.1).
  const view = useListView<ChipFilter>('keyhunter.list.wishlist', CHIPS, 'alle');
  const chip = view.filter;
  const setChip = view.setFilter;
  const [filter, setFilter] = useState(() => routeFilter() || view.text);
  const [selectedId, setSelectedId] = useState<string | null>(routeSelection);
  const [preview, setPreview] = useState<WishlistItem | null>(null);
  // Prices without or with the estimated shop fees (0.7.3); a view choice of this browser, like the sort.
  const [basis, setBasis] = useState<PriceBasis>(() => {
    try {
      return localStorage.getItem(BASIS_KEY) === 'estimate' ? 'estimate' : 'base';
    } catch {
      return 'base';
    }
  });
  // The chip "Pausiert" exists only with paused wishes. Whether the last list had any is kept, so the chip row has the
  // same size while the list loads and the table does not move when the chips fill in.
  const [hadPaused] = useState(() => {
    try {
      return localStorage.getItem(PAUSED_KEY) === '1';
    } catch {
      return false;
    }
  });
  const chooseBasis = (value: PriceBasis) => {
    setBasis(value);
    try {
      localStorage.setItem(BASIS_KEY, value);
    } catch {
      /* Keep in memory. */
    }
  };
  const [sort, setSort] = useState<WishlistSort>(() => {
    try {
      return parseSort(localStorage.getItem(SORT_KEY));
    } catch {
      return parseSort(null);
    }
  });
  const [badges, setBadges] = useState<Record<string, PriceBadgeData>>({});
  const [alerts, setAlerts] = useState<AlertRules>({});
  const [events, setEvents] = useState<AlertEvent[] | null>(null);
  /** An active notification channel exists (GET /alerts); null until read. */
  const [channel, setChannel] = useState<boolean | null>(null);
  // Request budget for the "Abrufe heute" tile, from the app's one fetch-status poller (shared with the sidebar card).
  const { data: fetchStatus } = useFetchStatus();
  const [editionItems, setEditionItems] = useState<WishlistItem[]>([]);
  const [tab, setTab] = useState<TabId>(routeTab);
  const [editionError, setEditionError] = useState('');
  const [removeItem, setRemoveItem] = useState<WishlistItem | null>(null);
  const [purchasing, setPurchasing] = useState(false);
  /** "Gekauft" asks first (RESP-13): it ends the alarm and the cart entry, and the way back is in the library. */
  const [confirmPurchase, setConfirmPurchase] = useState(false);
  const [purchaseError, setPurchaseError] = useState('');
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState('');
  const listScroll = useRef(0);
  const showingDetail = useRef(false);
  const returnFocus = useRef<string | null>(null);
  const loadGeneration = useRef(0);
  /** The rows of the last `/wishlist` read with the target country they were priced for; their badges are current. */
  const listRead = useRef<{ items: WishlistItem[]; target: string | null } | null>(null);
  const targetRef = useRef(targetCountry);
  targetRef.current = targetCountry;
  const listHeading = useRef<HTMLHeadingElement>(null);
  const focusListAfterRemove = useRef(false);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const selected = items.find(item => item.id === selectedId);
  const updateBadges = useCallback((entries: Record<string, PriceBadgeData>) => {
    setBadges(current => mergeBadges(current, entries));
  }, []);
  const updateBadge = useCallback((id: string, badge: PriceBadgeData) => updateBadges({ [id]: badge }), [updateBadges]);
  const updateRule = useCallback(
    (id: string, rule: Rule | null) =>
      setAlerts(current => {
        if (!rule) {
          if (!(id in current)) return current;
          const { [id]: _removed, ...rest } = current;
          return rest;
        }
        const previous = current[id];
        return previous &&
          previous.mode === rule.mode &&
          previous.basis === rule.basis &&
          previous.enabled === rule.enabled &&
          previous.target_cents === rule.target_cents
          ? current
          : { ...current, [id]: rule };
      }),
    [],
  );

  // Editions of the open game (prepared on the server on first open).
  useEffect(() => {
    setPreview(null);
    setTab(routeTab());
    setEditionItems([]);
    setEditionError('');
    if (!selected?.game) return;
    const controller = new AbortController();
    let cancel = () => {};
    async function prepare(method = 'POST') {
      try {
        const data = await api<EditionsView>(`/wishlist/${selected!.id}/editions`, method, method === 'POST' ? {} : undefined, csrf, controller.signal);
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
  }, [selected?.id, selected?.game?.igdb_id, selected?.platform_id, csrf, updateBadges]);
  function chooseEdition(game: CatalogGame) {
    if (!selected) return;
    if (game.igdb_id === selected.game?.igdb_id) setPreview(null);
    else {
      const prepared = editionItems.find(item => item.game?.igdb_id === game.igdb_id);
      if (prepared) setPreview(prepared);
    }
  }

  useEffect(() => {
    if (!items.length) return;
    const controller = new AbortController();
    let cancel = () => {};
    // The list just read carries the badges of this target country (PERF-06): the first poll waits a full interval.
    const fresh = listRead.current;
    listRead.current = null;
    const skipFirst = fresh?.items === items && fresh.target === targetCountry;
    async function readPrices() {
      let delay = badgePollDelay([]);
      try {
        const data = await api<Record<string, PriceBadgeData>>(
          `/wishlist/price-badges?anchor=${selected?.id ?? ''}`,
          'GET',
          undefined,
          undefined,
          controller.signal,
        );
        if (!controller.signal.aborted) {
          updateBadges(data);
          delay = badgePollDelay(Object.values(data));
        }
      } catch {
        /* Retain saved badges during a failed local read. */
      }
      if (!controller.signal.aborted) cancel = whenVisible(() => void readPrices(), delay);
    }
    if (skipFirst) cancel = whenVisible(() => void readPrices(), badgePollDelay(items.map(item => item.price_badge)));
    else void readPrices();
    return () => {
      controller.abort();
      cancel();
    };
  }, [items, targetCountry, updateBadges, selected?.id]);
  // Alarm targets ("Ziel" column, "Ziel erreicht") and the delivery log ("Alarm gesendet"), read once; the open detail keeps the rules current.
  useEffect(() => {
    const controller = new AbortController();
    void api<{ rules: (Rule & { wish_id: string })[]; events?: AlertEvent[]; configured?: boolean }>('/alerts', 'GET', undefined, undefined, controller.signal)
      .then(data => {
        if (controller.signal.aborted) return;
        setAlerts(Object.fromEntries(data.rules.map(rule => [rule.wish_id, rule])));
        setEvents(data.events ?? null);
        setChannel(data.configured ?? null);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);
  const closeSearch = useCallback(() => onAddOpen(false), [onAddOpen]);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    setListError('');
    try {
      const rows = await api<WishlistItem[]>('/wishlist');
      if (generation !== loadGeneration.current) return;
      updateBadges(Object.fromEntries(rows.flatMap(item => (item.price_badge ? [[item.id, item.price_badge]] : []))));
      listRead.current = { items: rows, target: targetRef.current };
      setItems(rows);
      onCountChange(rows.length);
    } catch (e) {
      if (generation === loadGeneration.current) {
        setListError(e instanceof Error ? e.message : 'Wunschliste konnte nicht geladen werden.');
        onError(e);
      }
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [onCountChange, onError, updateBadges]);
  useEffect(() => {
    void load();
    const generation = loadGeneration;
    return () => {
      ++generation.current;
    };
  }, [load]);
  useEffect(() => {
    function restore() {
      setTab(routeTab());
      setSelectedId(routeSelection());
      setFilter(routeFilter());
    }
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);
  useEffect(() => {
    if (!removeItem && focusListAfterRemove.current) {
      focusListAfterRemove.current = false;
      listHeading.current?.focus({ preventScroll: true });
    }
  }, [removeItem]);

  // List and game are two pages in one scroll area: the game starts at the top, the list returns to where it was.
  const detailOpen = !!selected;
  useLayoutEffect(() => {
    showingDetail.current = detailOpen;
    const main = scroller();
    if (detailOpen) {
      main?.scrollTo?.(0, 0);
      return;
    }
    main?.scrollTo?.(0, listScroll.current);
    const id = returnFocus.current;
    returnFocus.current = null;
    if (id) rows.current.get(id)?.focus({ preventScroll: true });
  }, [detailOpen]);
  useEffect(() => {
    const main = scroller();
    if (!main) return;
    const remember = () => {
      if (!showingDetail.current) listScroll.current = main.scrollTop;
    };
    main.addEventListener('scroll', remember, { passive: true });
    return () => main.removeEventListener('scroll', remember);
  }, []);

  /** Opens a game from the list, on its first tab or on `tab` (the warning triangle opens Zuordnungen, PROD-03). */
  function open(id: string, tab?: TabId) {
    // From the list one step back leads to it; from a game opened from the list one more; from a deep link none.
    const depth = showingDetail.current ? (listDepth() ? listDepth() + 1 : 0) : 1;
    if (!showingDetail.current) listScroll.current = scroller()?.scrollTop ?? 0;
    returnFocus.current = showingDetail.current ? null : id;
    setSelectedId(id);
    const url = new URL(window.location.href);
    url.hash = '';
    url.searchParams.delete('view');
    url.searchParams.set('item', id);
    if (tab && tab !== 'preis') url.searchParams.set('tab', tab);
    else url.searchParams.delete('tab');
    if (url.href !== window.location.href) window.history.pushState(depth ? { [FROM_LIST]: depth } : null, '', url);
  }
  /** Back to the list: a game opened from the list goes back in history (filter, sort and scroll are kept); a deep link pushes the list. */
  function closeDetail() {
    setSelectedId(null);
    if (returnToList()) return;
    const url = new URL(window.location.href);
    url.hash = '';
    url.searchParams.delete('item');
    url.searchParams.delete('tab');
    if (url.href !== window.location.href) window.history.pushState(null, '', url);
  }
  function changeTab(value: TabId) {
    setTab(value);
    const url = new URL(window.location.href);
    url.hash = '';
    if (value === 'preis') url.searchParams.delete('tab');
    else url.searchParams.set('tab', value);
    if (selected) url.searchParams.set('item', selected.id);
    const depth = listDepth();
    if (url.href !== window.location.href) window.history.pushState(depth ? { [FROM_LIST]: depth + 1 } : null, '', url);
  }
  function filterList(value: string) {
    setFilter(value);
    view.setText(value);
    view.setPage(1);
    const url = new URL(window.location.href);
    if (value) url.searchParams.set('filter', value);
    else url.searchParams.delete('filter');
    window.history.replaceState(window.history.state, '', url);
  }
  function sortBy(key: SortKey) {
    const value = nextSort(sort, key);
    setSort(value);
    try {
      localStorage.setItem(SORT_KEY, serializeSort(value));
    } catch {
      /* Keep in memory. */
    }
  }
  function added(item: WishlistItem, created: boolean) {
    ++loadGeneration.current;
    const next = [item, ...items.filter(existing => existing.id !== item.id)];
    if (item.price_badge) updateBadge(item.id, item.price_badge);
    setItems(next);
    onCountChange(next.length);
    filterList('');
    setChip('alle');
    open(item.id);
    notify(created ? `${itemName(item)} wurde vorgemerkt.` : 'Dieser Titel ist bereits auf deiner Wunschliste.');
  }
  async function remove() {
    if (!removeItem || removing) return;
    setRemoving(true);
    setRemoveError('');
    try {
      await api(`/wishlist/${encodeURIComponent(removeItem.id)}`, 'DELETE', undefined, csrf);
      ++loadGeneration.current;
      const next = items.filter(item => item.id !== removeItem.id);
      setItems(next);
      onCountChange(next.length);
      if (removeItem.in_cart) window.dispatchEvent(new Event(CART_CHANGED));
      if (selectedId === removeItem.id) {
        returnFocus.current = null;
        closeDetail();
      }
      focusListAfterRemove.current = true;
      notify(`${itemName(removeItem)} wurde aus der Wunschliste entfernt.`);
      setRemoveItem(null);
    } catch (e) {
      setRemoveError(e instanceof Error ? e.message : 'Entfernen fehlgeschlagen.');
      onError(e);
    } finally {
      setRemoving(false);
    }
  }
  const [carting, setCarting] = useState(false);
  /** The detail page's cart button: in or out, once per wish (0.8.0). */
  async function toggleCart() {
    if (!selected || preview || carting) return;
    const inCart = !!selected.in_cart;
    setCarting(true);
    try {
      if (inCart) await api(`/cart/${encodeURIComponent(selected.id)}`, 'DELETE', undefined, csrf);
      else await api('/cart', 'POST', { wish_id: selected.id }, csrf);
      setItems(current => current.map(item => (item.id === selected.id ? { ...item, in_cart: !inCart } : item)));
      window.dispatchEvent(new Event(CART_CHANGED));
      notify(inCart ? `${itemName(selected)} ist nicht mehr im Warenkorb.` : `${itemName(selected)} liegt jetzt im Warenkorb.`);
    } catch (error) {
      onError(error);
    } finally {
      setCarting(false);
    }
  }
  const [pausing, setPausing] = useState(false);
  /** Pause the selected wish's checks until a date or until resumed, or resume them (0.9.0). */
  async function pauseWish(until: number | null | false) {
    if (!selected || preview || pausing) return;
    setPausing(true);
    try {
      const next = await api<WishlistItem>(
        `/wishlist/${encodeURIComponent(selected.id)}/pause`,
        'PUT',
        until === false ? { paused: false } : { paused: true, until },
        csrf,
      );
      setItems(current => current.map(item => (item.id === selected.id ? { ...item, paused: next.paused, paused_until: next.paused_until } : item)));
      notify(until === false ? `Die Abfragen für ${itemName(selected)} laufen wieder.` : `${itemName(selected)}: ${pauseText(next)}.`);
    } catch (error) {
      onError(error);
    } finally {
      setPausing(false);
    }
  }
  /** An offer from the Angebote tab: into the cart with its shop and scope, or the entry switched to it when already there. */
  async function cartOffer(source: string, scope: 'home' | 'world') {
    if (!selected || preview || carting) return;
    setCarting(true);
    try {
      if (selected.in_cart) await api(`/cart/${encodeURIComponent(selected.id)}`, 'PUT', { source, scope }, csrf);
      else await api('/cart', 'POST', { wish_id: selected.id, source, scope }, csrf);
      setItems(current => current.map(item => (item.id === selected.id ? { ...item, in_cart: true } : item)));
      window.dispatchEvent(new Event(CART_CHANGED));
      const shop = shopNames[source] ?? source;
      notify(`${itemName(selected)} liegt im Warenkorb: ${shop}, ${scope === 'home' ? `Preis ${targetCountry?.toUpperCase() || 'Zielland'}` : 'Preis INT'}.`);
    } catch (error) {
      onError(error);
    } finally {
      setCarting(false);
    }
  }
  async function purchase() {
    if (!selected || preview || purchasing) return;
    setPurchasing(true);
    setPurchaseError('');
    try {
      await api(`/wishlist/${selected.id}/purchase`, 'POST', {}, csrf);
      ++loadGeneration.current;
      const next = items.filter(item => item.id !== selected.id);
      setItems(next);
      onCountChange(next.length);
      // Bought: the server took it out of the cart as well.
      if (selected.in_cart) window.dispatchEvent(new Event(CART_CHANGED));
      returnFocus.current = null;
      setConfirmPurchase(false);
      closeDetail();
      notify(`${itemName(selected)} wurde in die Bibliothek verschoben.`);
      requestAnimationFrame(() => listHeading.current?.focus({ preventScroll: true }));
    } catch (error) {
      setPurchaseError(error instanceof Error ? error.message : 'Verschieben fehlgeschlagen.');
      onError(error);
    } finally {
      setPurchasing(false);
    }
  }

  // Derived list data: facts per row (price, cheapest region, saving, target), chips, sorting and KPI tiles.
  const facts = useMemo(
    () => Object.fromEntries(items.map(item => [item.id, rowFacts(badges[item.id] ?? item.price_badge, alerts[item.id], basis)])) as Record<string, RowFacts>,
    [items, badges, alerts, basis],
  );
  const all: Row[] = useMemo(() => items.map(item => ({ item, facts: facts[item.id] })), [items, facts]);
  // The filter matches titles, and shop names: "Eneba" keeps the games where Eneba has the cheapest price (0.7.4).
  const shops = filterShops(filter, SHOP_NAMES);
  const matching = items.filter(
    item =>
      (chip === 'pause' ? !!item.paused : matchesChip(facts[item.id], chip)) &&
      matchesText([itemName(item), ...(item.game?.aliases ?? [])], facts[item.id], filter, shops),
  );
  const visible = sortWishlist(matching, facts, sort);
  // Page by page (0.9.1), like the log; a list that shrank shows its last page.
  const page = Math.min(view.page, pageCount(visible.length, view.perPage));
  const shown = visible.slice((page - 1) * view.perPage, page * view.perPage);
  const priced = all.filter(row => row.facts.price !== null).length;
  const reachedCount = all.filter(row => row.facts.reached).length;
  const chipCounts: Record<ChipFilter, number> = {
    alle: items.length,
    ziel: reachedCount,
    welt: all.filter(row => matchesChip(row.facts, 'welt')).length,
    offen: items.length - priced,
    pause: items.filter(item => item.paused).length,
  };
  const hasPaused = chipCounts.pause > 0;
  useEffect(() => {
    if (loading || listError) return;
    try {
      localStorage.setItem(PAUSED_KEY, hasPaused ? '1' : '0');
    } catch {
      /* Kept for this visit. */
    }
  }, [loading, listError, hasPaused]);
  const reached = useMemo(() => reachedTrend(all, alerts), [all, alerts]);
  const cheaper = useMemo(() => cheaperKpi(all), [all]);
  const budget = useMemo(() => fetchKpi(fetchStatus), [fetchStatus]);
  const sentToday = alarmSentToday(events);

  const variants = editionItems.flatMap(item => (item.game ? [item.game] : []));
  if (selected?.game && !variants.some(g => g.igdb_id === selected.game?.igdb_id)) variants.unshift(selected.game);
  variants.sort((a, b) => (a.version_parent ? 1 : 0) - (b.version_parent ? 1 : 0) || a.igdb_id - b.igdb_id);
  const viewed = preview ?? selected;
  const title = selected ? itemName(selected) : null;
  useEffect(() => {
    onTitle(title);
  }, [title, onTitle]);
  useEffect(() => () => onTitle(null), [onTitle]);
  const scopeLabel =
    basis === 'estimate'
      ? `Tiefster aktivierbarer Gesamtpreis mit geschätzten Gebühren · ${targetLabel}`
      : `Tiefster aktivierbarer Grundpreis · ${targetLabel}`;
  const code = targetCountry?.toUpperCase() ?? '';
  const priceLabel = code ? `Preis ${code}` : 'Preis';
  const mode = openMode(opener);
  const order = visibleColumns(columnOrder(columns), hidden, mode);
  const headers: Record<WishlistColumn, ReactNode> = {
    game: (
      <SortHeader key="game" id="title" className="c-game" sort={sort} onSort={sortBy}>
        Spiel
      </SortHeader>
    ),
    price: (
      <SortHeader key="price" id="price" className="c-de" sort={sort} onSort={sortBy} right>
        {priceLabel}
      </SortHeader>
    ),
    world: (
      <SortHeader key="world" id="world" className="c-world" sort={sort} onSort={sortBy}>
        Preis INT
      </SortHeader>
    ),
    save: (
      <SortHeader key="save" id="save" className="c-save" sort={sort} onSort={sortBy} right>
        Ersparnis
      </SortHeader>
    ),
    target: (
      <SortHeader key="target" id="target" className="c-target" sort={sort} onSort={sortBy} right>
        Ziel
      </SortHeader>
    ),
    status: (
      <SortHeader key="status" id="status" className="c-status" sort={sort} onSort={sortBy}>
        Status
      </SortHeader>
    ),
    trend: (
      <th key="trend" className="no-sort c-trend">
        14 Tage
      </th>
    ),
    open: (
      <th key="open" className="no-sort c-more">
        <span className="sr-only">Öffnen</span>
      </th>
    ),
  };

  const dialogs = (
    <>
      <CatalogSearch open={addOpen} csrf={csrf} items={items} onClose={closeSearch} onAdded={added} onError={onError} />
      <ConfirmDialog
        open={removeItem !== null}
        title="Titel entfernen?"
        confirmLabel="Entfernen bestätigen"
        danger
        cancelLabel="Behalten"
        busy={removing}
        onCancel={() => setRemoveItem(null)}
        onConfirm={() => void remove()}
      >
        <p>„{removeItem ? itemName(removeItem) : ''}“ wird aus deiner Wunschliste entfernt.</p>
        {removeError && <Notice error>{removeError}</Notice>}
      </ConfirmDialog>
      <ConfirmDialog
        open={confirmPurchase && !!selected}
        title="Als gekauft markieren?"
        confirmLabel="In die Bibliothek verschieben"
        cancelLabel="Abbrechen"
        busy={purchasing}
        onCancel={() => setConfirmPurchase(false)}
        onConfirm={() => void purchase()}
      >
        <p>
          „{selected ? itemName(selected) : ''}“ kommt in die Bibliothek. Die Preisabfragen und der Preisalarm enden
          {selected?.in_cart ? ', der Eintrag im Warenkorb wird entfernt' : ''}. Zurück geht es über die Bibliothek.
        </p>
        {purchaseError && <Notice error>{purchaseError}</Notice>}
      </ConfirmDialog>
    </>
  );

  // The game as its own page (breadcrumb "Wunschliste › Titel" through onTitle).
  if (selected && viewed)
    return (
      <>
        <GameDetail
          key={selected.id}
          item={selected}
          viewed={viewed}
          preview={!!preview}
          variants={variants}
          editionItems={editionItems}
          editionError={editionError}
          badges={badges}
          csrf={csrf}
          targetCountry={targetCountry}
          targetLabel={targetLabel}
          tab={tab}
          purchasing={purchasing}
          carting={carting}
          onCart={() => void toggleCart()}
          pausing={pausing}
          onPause={until => void pauseWish(until)}
          onCartOffer={(source, scope) => void cartOffer(source, scope)}
          offersColumns={offersColumns}
          offersHidden={offersHidden}
          onTab={changeTab}
          onPurchase={() => {
            setPurchaseError('');
            setConfirmPurchase(true);
          }}
          onRemove={() => {
            setRemoveError('');
            setRemoveItem(selected);
          }}
          onView={chooseEdition}
          onClearPreview={() => setPreview(null)}
          onBadge={updateBadge}
          onSettings={onSettings}
          onError={onError}
          onRule={updateRule}
        />
        {dialogs}
      </>
    );
  if (loading && selectedId)
    return (
      <p className="wl-loading" role="status">
        Wird geladen …
      </p>
    );

  const sub = loading
    ? 'Wird geladen …'
    : `${count(items.length)} ${items.length === 1 ? 'Spiel' : 'Spiele'} · ${targetCountry ? `Zielland ${targetLabel}` : 'Kein Zielland gewählt'}`;
  const ready = !loading && !listError;
  const best = cheaper.best;
  return (
    <div className="page wishlist-page">
      <header className="page-head">
        <div>
          <div className="page-title">
            <h1 id="wishlist-title" ref={listHeading} tabIndex={-1}>
              Wunschliste
            </h1>
            <Help label="Hilfe zur Wunschliste">
              <span>
                „Preis {targetCountry || 'Zielland'}“ ist der beste Preis eines im Zielland aktivierbaren Keys, „Preis INT“ die günstigste Region weltweit.
                Verglichen werden alle Regionen, abgefragt werden alle gleich.
              </span>
              <span>Das Suchfeld filtert nach Titel; ein Shop-Name zeigt die Spiele, bei denen dieser Shop am günstigsten ist.</span>
            </Help>
          </div>
          <p>{sub}</p>
        </div>
      </header>
      {!loading && selectedId && !selected && <Notice>Der verlinkte Eintrag ist nicht mehr in deiner Wunschliste.</Notice>}
      {listError && (
        <Notice error>
          {listError}
          <Button onClick={() => void load()}>Liste erneut laden</Button>
        </Notice>
      )}
      {/* PERF-05: while the list loads the tiles stand as placeholders, so the list below does not jump when they fill. */}
      {loading && !listError && (
        <div className="kpis" aria-hidden="true">
          {['Wünsche', 'Ziel erreicht', 'Weltweit günstiger', 'Abrufe heute'].map(label => (
            <Kpi key={label} label={label} value="–" unit={'\u00a0'} foot={emptyFoot} />
          ))}
        </div>
      )}
      {ready && items.length > 0 && (
        <div className="kpis">
          <Kpi
            label="Wünsche"
            value={count(items.length)}
            unit={items.length === 1 ? 'Spiel' : 'Spiele'}
            ticks={addedTicks(items)}
            foot={
              <>
                <span>{count(priced)} mit Preis</span>
                <span>{count(items.length - priced)} offen</span>
              </>
            }
          />
          <Kpi
            label="Ziel erreicht"
            value={count(reachedCount)}
            unit={reachedCount === 1 ? 'Spiel' : 'Spiele'}
            ticks={reached.ticks}
            foot={
              !reached.since && !sentToday ? (
                emptyFoot
              ) : (
                <>
                  <span className="good">{reached.since ? `+${count(reached.since)} seit gestern` : ''}</span>
                  {sentToday && <span>Alarm gesendet</span>}
                </>
              )
            }
          />
          <Kpi
            label="Weltweit günstiger"
            value={count(cheaper.count)}
            unit="ab 20 %"
            ticks={cheaper.ticks}
            foot={
              !best ? (
                emptyFoot
              ) : (
                <>
                  <span>bis</span>
                  <span className="hot">
                    −{formatPrice(best.facts.saving!)} · {shortTitle(itemName(best.item))}
                  </span>
                </>
              )
            }
          />
          <Kpi
            label="Abrufe heute"
            className={budget?.short.length && !budget.paused ? 'short' : undefined}
            value={budget ? count(budget.used) : '–'}
            unit={budget ? `/ ${count(budget.limit)}` : undefined}
            ticks={budget?.ticks}
            foot={
              budget?.paused ? (
                <>
                  <span>Automatische Abfragen</span>
                  <span className="warn">pausiert</span>
                </>
              ) : !budget ? (
                emptyFoot
              ) : (
                <>
                  <span>Bedarf ≈ {count(budget.demand)} pro Tag</span>
                  {budget.short.length ? (
                    // PROD-14: a shop needs more checks a day than it may make; its limit is set under Key-Shops.
                    <button
                      type="button"
                      className="text-button warn"
                      title="Mehr Abrufe nötig, als das Tageslimit erlaubt: Preise bleiben länger alt. Das Limit stellst du unter Einstellungen › Key-Shops ein."
                      onClick={() => openSection('shops')}
                    >
                      zu knapp: {budget.short.map(id => shopNames[id] ?? id).join(', ')}
                    </button>
                  ) : (
                    <span className="good">reicht</span>
                  )}
                </>
              )
            }
          />
        </div>
      )}
      <Panel aria-label="Spiele">
        <PanelHead>
          <Seg
            label="Filter"
            wrap
            value={chip}
            onChange={setChip}
            options={chipLabels
              .filter(([id]) => id !== 'pause' || (ready ? chipCounts.pause > 0 : hadPaused) || chip === 'pause')
              .map(([id, label]) => ({ value: id, label, count: ready ? chipCounts[id] : null, disabled: !ready }))}
          />
          <span className="spacer" />
          <Seg
            className="wl-basis"
            label="Preise"
            value={basis}
            onChange={chooseBasis}
            options={[
              { value: 'base', label: 'Ohne Gebühren' },
              { value: 'estimate', label: 'Mit Gebühren' },
            ]}
          />
          <Field icon="search" className="wl-q">
            <input
              type="search"
              placeholder="Spiel oder Shop filtern …"
              aria-label="Liste filtern"
              value={filter}
              maxLength={200}
              onChange={event => filterList(event.target.value)}
              disabled={!ready || items.length === 0}
            />
          </Field>
          <PageSize value={view.perPage} onChange={view.setPerPage} />
        </PanelHead>
        <Inset className="table-wrap wl-wrap">
          {loading ? (
            <p className="empty" role="status">
              Wunschliste wird geladen …
            </p>
          ) : items.length === 0 ? (
            <EmptyState
              icon="heart"
              title={listError ? 'Die Liste ist derzeit nicht abrufbar.' : 'Deine Liste ist noch leer.'}
              action={
                !listError && (
                  <Button variant="primary" onClick={() => onAddOpen(true)}>
                    <Icon name="search" />
                    Im Katalog suchen
                  </Button>
                )
              }
            >
              {listError ? '' : 'Suche ein Spiel und merke es vor, dann beobachtet KeyHunter den Preis.'}
            </EmptyState>
          ) : visible.length === 0 ? (
            <p className="empty">Kein Spiel passt zu diesem Filter.</p>
          ) : (
            <>
              {shops.length > 0 && (
                <p className="wl-shop-note" role="status">
                  {shops.map(id => SHOP_NAMES[id]).join(', ')}: Spiele, bei denen {shops.length === 1 ? 'dieser Shop' : 'einer dieser Shops'} den günstigsten
                  Preis {code || 'im Zielland'} oder INT hat.
                </p>
              )}
              <table className="wl" aria-label="Vorgemerkte Spiele">
                <thead>
                  <tr>{order.map(column => headers[column])}</tr>
                </thead>
                <tbody>
                  {shown.map(item => (
                    <WishlistRow
                      key={item.id}
                      item={item}
                      badge={badges[item.id] ?? item.price_badge}
                      facts={facts[item.id]}
                      columns={order}
                      mode={mode}
                      code={code}
                      compare
                      scopeLabel={scopeLabel}
                      targetDisabled={!!alerts[item.id] && !alerts[item.id].enabled}
                      onOpen={() => open(item.id)}
                      onReview={() => open(item.id, 'zuordnungen')}
                      openRef={element => {
                        if (element) rows.current.set(item.id, element);
                        else rows.current.delete(item.id);
                      }}
                    />
                  ))}
                </tbody>
              </table>
            </>
          )}
        </Inset>
        {ready && visible.length > 0 && <Pager label="Wunschliste" total={visible.length} page={page} perPage={view.perPage} onPage={view.setPage} />}
      </Panel>
      {ready && (
        <FirstSteps
          state={{
            country: targetCountry ? targetLabel : null,
            index: indexState,
            shops: shopsActive,
            games: items.length,
            channel: channel ?? undefined,
          }}
          onAdd={() => onAddOpen(true)}
        />
      )}
      {dialogs}
    </div>
  );
}
