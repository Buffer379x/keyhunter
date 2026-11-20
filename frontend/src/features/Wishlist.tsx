import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { CatalogGame, PriceBadgeData, WishlistItem } from '../api';
import { Button, ConfirmDialog, EmptyState, Icon, Label, Notice } from '../components';
import CatalogSearch from './CatalogSearch';
import GameDetail, { isTab } from './GameDetail';
import type { TabId } from './GameDetail';
import WishlistRow, { needsReview } from './WishlistRow';
import { mergeBadges } from './price-badges';
import { ruleTarget } from './PriceAlerts';
import type { Rule } from './PriceAlerts';
import { sortWishlist } from './wishlist-sort';
import type { SortMode } from './wishlist-sort';
import { itemName, platformName } from './catalog-ui';
import { whenVisible } from '../poll';
import { downloadJson, wishlistExport } from './wishlist-export';

interface Props {
  csrf: string; targetCountry: string | null; targetLabel: string; priceScope: 'preferred' | 'all';
  /** The add dialog; the top bar's "Spiel hinzufügen" opens it, so the state lives in the shell. */
  addOpen: boolean; onAddOpen: (open: boolean) => void;
  /** Title of the open game for the breadcrumb (null without a selection). */
  onTitle: (title: string | null) => void;
  onSettings: () => void; onCountChange: (count: number) => void; onError: (error: unknown) => void }
// List and detail are separate views below 1024 px.
const compactLayout = '(max-width: 1023px)';
const routeTab = (): TabId => {
  const url = new URL(window.location.href);
  const tab = url.searchParams.get('tab');
  if (isTab(tab)) return tab;
  return url.hash === '#alert-editor-title' ? 'alarm' : 'preis';
};
const routeSelection = () => new URL(window.location.href).searchParams.get('item');
type AlertRules = Record<string, Rule>;

export default function Wishlist({ csrf, targetCountry, targetLabel, priceScope, addOpen, onAddOpen, onTitle, onSettings, onCountChange, onError }: Props) {
  const [items, setItems] = useState<WishlistItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [message, setMessage] = useState('');
  const [filter, setFilter] = useState(() => new URL(window.location.href).searchParams.get('filter') ?? '');
  const [onlyReview, setOnlyReview] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(routeSelection);
  const [preview, setPreview] = useState<WishlistItem | null>(null);
  const [sort, setSort] = useState<SortMode>(() => { try { const value = localStorage.getItem('keyhunter.wishlist.sort'); return value === 'price' || value === 'name' ? value : 'added'; } catch { return 'added'; } });
  const [badges, setBadges] = useState<Record<string, PriceBadgeData>>({});
  const [alerts, setAlerts] = useState<AlertRules>({});
  const [editionItems, setEditionItems] = useState<WishlistItem[]>([]);
  const prices = useMemo(() => Object.fromEntries(Object.entries(badges).map(([id, badge]) => [id, badge.cents])), [badges]);
  const [tab, setTab] = useState<TabId>(routeTab);
  const [editionError, setEditionError] = useState('');
  const [removeItem, setRemoveItem] = useState<WishlistItem | null>(null);
  const [purchasing, setPurchasing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState('');
  const listScroll = useRef(0);
  const loadGeneration = useRef(0);
  const root = useRef<HTMLDivElement>(null);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const focusListAfterRemove = useRef(false);
  const selected = items.find(item => item.id === selectedId);
  const updateBadges = useCallback((entries: Record<string, PriceBadgeData>) => { setBadges(current => mergeBadges(current, entries)); }, []);
  const updateBadge = useCallback((id: string, badge: PriceBadgeData) => updateBadges({ [id]: badge }), [updateBadges]);
  const updateRule = useCallback((id: string, rule: Rule | null) => setAlerts(current => {
    if (!rule) { if (!(id in current)) return current; const { [id]: _removed, ...rest } = current; return rest; }
    const previous = current[id];
    return previous && previous.mode === rule.mode && previous.basis === rule.basis && previous.enabled === rule.enabled && previous.target_cents === rule.target_cents ? current : { ...current, [id]: rule };
  }), []);

  useEffect(() => {
    setPreview(null);
    setTab(routeTab()); setEditionItems([]); setEditionError('');
    if (!selected?.game) return;
    const controller = new AbortController(); let cancel = () => {};
    async function prepare(method = 'POST') {
      try {
        const data = await api<{ items: WishlistItem[]; preparing: boolean; error: string | null }>(`/wishlist/${selected!.id}/editions`, method, method === 'POST' ? {} : undefined, csrf, controller.signal);
        if (controller.signal.aborted) return;
        setEditionItems(data.items); setEditionError(data.error ?? (data.preparing ? 'Editionen werden vorbereitet …' : ''));
        updateBadges(Object.fromEntries(data.items.flatMap(item => item.price_badge ? [[item.id, item.price_badge]] : [])));
        if (data.preparing) cancel = whenVisible(() => void prepare('GET'), 3000);
      } catch (error) { if (!controller.signal.aborted) setEditionError(error instanceof Error ? error.message : 'Editionen konnten nicht geladen werden.'); }
    }
    void prepare(); return () => { controller.abort(); cancel(); };
  }, [selected?.id, selected?.game?.igdb_id, selected?.platform_id, csrf, updateBadges]);
  function chooseEdition(game: CatalogGame) {
    if (!selected) return;
    if (game.igdb_id === selected.game?.igdb_id) setPreview(null);
    else { const prepared = editionItems.find(item => item.game?.igdb_id === game.igdb_id); if (prepared) setPreview(prepared); }
  }

  useEffect(() => {
    if (!items.length) return;
    const controller = new AbortController(); let cancel = () => {};
    async function readPrices() {
      let pending = false;
      try {
        const data = await api<Record<string, PriceBadgeData>>(`/wishlist/price-badges?anchor=${selected?.id ?? ''}`, 'GET', undefined, undefined, controller.signal);
        if (!controller.signal.aborted) { updateBadges(data); pending = Object.values(data).some(badge => badge.pending); }
      } catch { /* Retain saved badges during a failed local read. */ }
      if (!controller.signal.aborted) cancel = whenVisible(() => void readPrices(), pending ? 3000 : 30000);
    }
    void readPrices(); return () => { controller.abort(); cancel(); };
  }, [items, priceScope, targetCountry, updateBadges, selected?.id]);
  // Alarm targets for the "Ziel erreicht" status, read once; the open detail keeps them current.
  useEffect(() => {
    const controller = new AbortController();
    void api<{ rules: (Rule & { wish_id: string })[] }>('/alerts', 'GET', undefined, undefined, controller.signal)
      .then(data => { if (!controller.signal.aborted) setAlerts(Object.fromEntries(data.rules.map(rule => [rule.wish_id, rule]))); }).catch(() => {});
    return () => controller.abort();
  }, []);
  const closeSearch = useCallback(() => onAddOpen(false), [onAddOpen]);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true); setListError('');
    try {
      const rows = await api<WishlistItem[]>('/wishlist');
      if (generation !== loadGeneration.current) return;
      updateBadges(Object.fromEntries(rows.flatMap(item => item.price_badge ? [[item.id, item.price_badge]] : [])));
      setItems(rows); onCountChange(rows.length);
      if (!routeSelection() && !window.matchMedia(compactLayout).matches) setSelectedId(rows[0]?.id ?? null);
    } catch (e) { if (generation === loadGeneration.current) { setListError(e instanceof Error ? e.message : 'Wunschliste konnte nicht geladen werden.'); onError(e); } }
    finally { if (generation === loadGeneration.current) setLoading(false); }
  }, [onCountChange, onError, updateBadges]);
  useEffect(() => { void load(); return () => { ++loadGeneration.current; }; }, [load]);
  useEffect(() => {
    function restore() { setTab(routeTab()); setSelectedId(routeSelection()); setFilter(new URL(window.location.href).searchParams.get('filter') ?? ''); }
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);
  useEffect(() => {
    if (!removeItem && focusListAfterRemove.current) { focusListAfterRemove.current = false; listHeading.current?.focus({ preventScroll: true }); }
  }, [removeItem]);

  function scrollTop(to: number) { document.getElementById('main-content')?.scrollTo?.(0, to); if (root.current) root.current.scrollTop = to; }
  function select(id: string | null) {
    if (id) listScroll.current = Math.max(document.getElementById('main-content')?.scrollTop ?? 0, root.current?.scrollTop ?? 0);
    setSelectedId(id); setMessage('');
    const url = new URL(window.location.href);
    url.hash = '';
    url.searchParams.delete('view'); url.searchParams.delete('tab');
    if (id) url.searchParams.set('item', id); else url.searchParams.delete('item');
    if (url.href !== window.location.href) window.history.pushState(null, '', url);
    if (window.matchMedia(compactLayout).matches) requestAnimationFrame(() => scrollTop(id ? 0 : listScroll.current));
  }
  function changeTab(value: TabId) {
    setTab(value);
    const url = new URL(window.location.href);
    url.hash = '';
    if (value === 'preis') url.searchParams.delete('tab'); else url.searchParams.set('tab', value);
    if (selected) url.searchParams.set('item', selected.id);
    if (url.href !== window.location.href) window.history.pushState(null, '', url);
  }
  function filterList(value: string) {
    setFilter(value);
    const url = new URL(window.location.href);
    if (value) url.searchParams.set('filter', value); else url.searchParams.delete('filter');
    window.history.replaceState(null, '', url);
  }
  function added(item: WishlistItem, created: boolean) {
    ++loadGeneration.current;
    const rows = [item, ...items.filter(existing => existing.id !== item.id)];
    if (item.price_badge) updateBadge(item.id, item.price_badge);
    setItems(rows); onCountChange(rows.length); filterList(''); select(item.id);
    setMessage(created ? `${itemName(item)} wurde vorgemerkt.` : 'Dieser Titel ist bereits auf deiner Wunschliste.');
  }
  async function remove() {
    if (!removeItem || removing) return;
    setRemoving(true); setRemoveError('');
    try {
      await api(`/wishlist/${encodeURIComponent(removeItem.id)}`, 'DELETE', undefined, csrf);
      ++loadGeneration.current;
      const rows = items.filter(item => item.id !== removeItem.id); setItems(rows); onCountChange(rows.length);
      if (selectedId === removeItem.id) select(null);
      focusListAfterRemove.current = true;
      setMessage(`${itemName(removeItem)} wurde aus der Wunschliste entfernt.`); setRemoveItem(null);
    } catch (e) { setRemoveError(e instanceof Error ? e.message : 'Entfernen fehlgeschlagen.'); onError(e); }
    finally { setRemoving(false); }
  }
  async function purchase() {
    if (!selected || preview || purchasing) return;
    setPurchasing(true); setMessage('');
    try {
      await api(`/wishlist/${selected.id}/purchase`, 'POST', {}, csrf);
      ++loadGeneration.current;
      const rows = items.filter(item => item.id !== selected.id); setItems(rows); onCountChange(rows.length); select(null);
      setMessage(`${itemName(selected)} wurde in die Bibliothek verschoben.`);
      listHeading.current?.focus();
    } catch (error) { onError(error); } finally { setPurchasing(false); }
  }
  function exportList() {
    downloadJson('keyhunter-wunschliste.json', wishlistExport(items));
  }
  const text = filter.toLocaleLowerCase('de-DE');
  const matching = items.filter(item => [itemName(item), ...(item.game?.aliases ?? [])].some(name => name.toLocaleLowerCase('de-DE').includes(text)));
  const reviewCount = items.filter(item => needsReview(item, badges[item.id] ?? item.price_badge)).length;
  const visible = sortWishlist(onlyReview && reviewCount > 0 ? matching.filter(item => needsReview(item, badges[item.id] ?? item.price_badge)) : matching, prices, sort);
  const reachedCount = items.filter(item => reached(item)).length;
  function reached(item: WishlistItem) {
    const rule = alerts[item.id]; const badge = badges[item.id] ?? item.price_badge;
    const target = ruleTarget(rule);
    // The badge price is a base price, so only rules on the base price can be compared with it.
    return !!rule?.enabled && rule.basis === 'base' && target !== null && !!badge && badge.state === 'price' && badge.cents !== null && badge.cents <= target;
  }

  const variants = editionItems.flatMap(item => item.game ? [item.game] : []);
  if (selected?.game && !variants.some(g => g.igdb_id === selected.game?.igdb_id)) variants.unshift(selected.game);
  variants.sort((a, b) => (a.version_parent ? 1 : 0) - (b.version_parent ? 1 : 0) || a.igdb_id - b.igdb_id);
  const viewed = preview ?? selected;
  const title = selected ? itemName(selected) : null;
  useEffect(() => { onTitle(title); }, [title, onTitle]);
  useEffect(() => () => onTitle(null), [onTitle]);
  const scopeLabel = priceScope === 'all' ? 'Tiefster beobachteter Grundpreis · alle Regionen' : `Tiefster aktivierbarer Grundpreis · ${targetLabel}`;
  const code = targetCountry?.toUpperCase();
  return <div ref={root} className={`wishlist-feature ${selected ? 'has-selection' : ''}`}>
    <section className="list-panel" aria-labelledby="wishlist-title">
      <div className="wishlist-head">
        <div><h1 id="wishlist-title" ref={listHeading} tabIndex={-1}>Wunschliste</h1>
          <Label className="list-count"><span>{loading ? 'Wird geladen …' : `${items.length} von 100 Spielen`}</span>{code && <span> · Zielland {code}</span>}{reachedCount > 0 && <span> · {reachedCount} Ziel erreicht</span>}</Label></div>
      </div>
      <div className="list-tools">
        <div className="filter-chips" role="group" aria-label="Liste eingrenzen">
          <button type="button" className="filter-chip" aria-pressed={!onlyReview} onClick={() => setOnlyReview(false)}>Alle <span>{items.length}</span></button>
          {reviewCount > 0 && <button type="button" className="filter-chip" aria-pressed={onlyReview} onClick={() => setOnlyReview(true)}>Prüfen <span>{reviewCount}</span></button>}
        </div>
        <div className="wishlist-sort"><label htmlFor="wishlist-sort">Sortieren</label><select id="wishlist-sort" aria-label="Wunschliste sortieren" value={sort} onChange={e => { const value = e.target.value as SortMode; setSort(value); try { localStorage.setItem('keyhunter.wishlist.sort', value); } catch { /* Keep in memory. */ } }}><option value="added">Zuletzt hinzugefügt</option><option value="price">Günstigster Preis</option><option value="name">Name A–Z</option></select></div>
      </div>
      <label className="search-label" htmlFor="wishlist-filter">Wunschliste filtern</label>
      <div className="list-search"><Icon name="search" size={15} /><input id="wishlist-filter" placeholder="Liste filtern …" value={filter} maxLength={200} onChange={event => filterList(event.target.value)} disabled={loading || items.length === 0} /></div>
      {message && <Notice>{message}</Notice>}
      {!loading && selectedId && !selected && <Notice>Der verlinkte Eintrag ist nicht mehr in deiner Wunschliste.</Notice>}
      {listError && <Notice error>{listError}<Button onClick={() => void load()}>Liste erneut laden</Button></Notice>}
      {loading ? <p className="list-loading" role="status">Wunschliste wird geladen …</p> : items.length === 0 ? <div className="list-empty"><EmptyState icon="heart" title={listError ? 'Die Liste ist derzeit nicht abrufbar.' : 'Deine Liste ist noch leer.'}>{listError ? '' : 'Suche ein Spiel und merke es vor, dann beobachtet KeyHunter den Preis.'}</EmptyState></div> : visible.length === 0 ? <p className="list-loading">Kein Titel passt zu deinem Listenfilter.</p> :
        <ul className="wishlist-items" aria-label="Vorgemerkte Spiele">{visible.map(item => <li key={item.id}><WishlistRow item={item} badge={badges[item.id] ?? item.price_badge} selected={selectedId === item.id} reached={reached(item)} scopeLabel={scopeLabel} onSelect={() => select(item.id)} /></li>)}</ul>}
      <div className="list-footer"><Button variant="ghost" size="sm" disabled={loading || !!listError || !items.length} onClick={exportList}><Icon name="download" size={14} />Liste exportieren</Button></div>
    </section>
    {selected && viewed ? <GameDetail key={selected.id} item={selected} viewed={viewed} preview={!!preview} variants={variants} editionItems={editionItems} editionError={editionError} badges={badges}
      csrf={csrf} targetCountry={targetCountry} targetLabel={targetLabel} tab={tab} purchasing={purchasing} onTab={changeTab} onBack={() => select(null)} onPurchase={() => void purchase()}
      onRemove={() => { setRemoveError(''); setRemoveItem(selected); }} onView={chooseEdition} onClearPreview={() => setPreview(null)} onBadge={updateBadge} onSettings={onSettings} onError={onError} onRule={updateRule} />
      : <section className="empty-detail" aria-label="Spieldetails">
        <EmptyState icon="heart" title={items.length ? 'Spiel auswählen' : 'Wunschliste leer'} action={!items.length && <Button variant="primary" onClick={() => onAddOpen(true)} disabled={loading || !!listError}>Im Katalog suchen</Button>}>{items.length ? 'Wähle links ein Spiel, um Preise, Verlauf und Alarm zu sehen.' : ''}</EmptyState>
      </section>}
    <CatalogSearch open={addOpen} csrf={csrf} items={items} onClose={closeSearch} onAdded={added} onError={onError} />
    <ConfirmDialog open={removeItem !== null} title="Titel entfernen?" confirmLabel="Entfernen bestätigen" danger cancelLabel="Behalten" busy={removing} onCancel={() => setRemoveItem(null)} onConfirm={() => void remove()}>
      <p>„{removeItem ? itemName(removeItem) : ''}“ wird aus deiner Wunschliste entfernt.</p>
      {removeError && <Notice error>{removeError}</Notice>}
    </ConfirmDialog>
  </div>;
}
