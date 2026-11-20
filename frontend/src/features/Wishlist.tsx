import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AlertEvent, CatalogGame, FetchStatusResponse, PriceBadgeData, WishlistItem } from '../api';
import { api } from '../api';
import { Button, Chip, ConfirmDialog, EmptyState, Field, Icon, Inset, Kpi, Notice, Panel, PanelHead, formatPrice } from '../components';
import CatalogSearch from './CatalogSearch';
import GameDetail, { isTab } from './GameDetail';
import type { TabId } from './GameDetail';
import WishlistRow from './WishlistRow';
import { mergeBadges } from './price-badges';
import type { Rule } from './PriceAlerts';
import { isSortMode, sortWishlist } from './wishlist-sort';
import type { SortMode } from './wishlist-sort';
import { addedTicks, alarmSentToday, cheaperKpi, fetchKpi, matchesChip, reachedTrend, rowFacts, shortTitle } from './wishlist-model';
import type { ChipFilter, Row, RowFacts } from './wishlist-model';
import { itemName } from './catalog-ui';
import { whenVisible } from '../poll';
import { downloadJson, wishlistExport } from './wishlist-export';

interface Props {
  csrf: string; targetCountry: string | null; targetLabel: string; priceScope: 'preferred' | 'all';
  /** The add dialog; the top bar's "Spiel hinzufügen" opens it, so the state lives in the shell. */
  addOpen: boolean; onAddOpen: (open: boolean) => void;
  /** Title of the open game for the breadcrumb (null without a selection). */
  onTitle: (title: string | null) => void;
  onSettings: () => void; onCountChange: (count: number) => void; onError: (error: unknown) => void }

const SLOTS = 100;
const SORT_KEY = 'keyhunter.wishlist.sort';
const FETCH_REFRESH_MS = 60_000;
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
  const tab = url.searchParams.get('tab');
  if (isTab(tab)) return tab;
  return url.hash === '#alert-editor-title' ? 'alarm' : 'preis';
};
const routeSelection = () => new URL(window.location.href).searchParams.get('item');
const routeFilter = () => new URL(window.location.href).searchParams.get('filter') ?? '';
const scroller = () => document.getElementById('main-content');
type AlertRules = Record<string, Rule>;
const chipLabels: [ChipFilter, string][] = [['alle', 'Alle'], ['ziel', 'Ziel erreicht'], ['welt', 'Weltweit günstiger'], ['offen', 'Ohne Preis']];
const count = (value: number) => value.toLocaleString('de-DE');

/**
 * Wishlist page: the list (KPI tiles, filter chips, table) or, with `?item=`, the game detail as its own full-width page.
 * The list state (filter, sort, scroll position) survives a visit to a game; browser back returns to the same place.
 */
export default function Wishlist({ csrf, targetCountry, targetLabel, priceScope, addOpen, onAddOpen, onTitle, onSettings, onCountChange, onError }: Props) {
  const [items, setItems] = useState<WishlistItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [message, setMessage] = useState('');
  const [filter, setFilter] = useState(routeFilter);
  const [chip, setChip] = useState<ChipFilter>('alle');
  const [selectedId, setSelectedId] = useState<string | null>(routeSelection);
  const [preview, setPreview] = useState<WishlistItem | null>(null);
  const [sort, setSort] = useState<SortMode>(() => { try { const value = localStorage.getItem(SORT_KEY); return isSortMode(value) ? value : 'added'; } catch { return 'added'; } });
  const [badges, setBadges] = useState<Record<string, PriceBadgeData>>({});
  const [alerts, setAlerts] = useState<AlertRules>({});
  const [events, setEvents] = useState<AlertEvent[] | null>(null);
  const [fetchStatus, setFetchStatus] = useState<FetchStatusResponse | null>(null);
  const [editionItems, setEditionItems] = useState<WishlistItem[]>([]);
  const [tab, setTab] = useState<TabId>(routeTab);
  const [editionError, setEditionError] = useState('');
  const [removeItem, setRemoveItem] = useState<WishlistItem | null>(null);
  const [purchasing, setPurchasing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState('');
  const listScroll = useRef(0);
  const showingDetail = useRef(false);
  const returnFocus = useRef<string | null>(null);
  const loadGeneration = useRef(0);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const focusListAfterRemove = useRef(false);
  const rows = useRef(new Map<string, HTMLTableRowElement>());
  const selected = items.find(item => item.id === selectedId);
  const updateBadges = useCallback((entries: Record<string, PriceBadgeData>) => { setBadges(current => mergeBadges(current, entries)); }, []);
  const updateBadge = useCallback((id: string, badge: PriceBadgeData) => updateBadges({ [id]: badge }), [updateBadges]);
  const updateRule = useCallback((id: string, rule: Rule | null) => setAlerts(current => {
    if (!rule) { if (!(id in current)) return current; const { [id]: _removed, ...rest } = current; return rest; }
    const previous = current[id];
    return previous && previous.mode === rule.mode && previous.basis === rule.basis && previous.enabled === rule.enabled && previous.target_cents === rule.target_cents ? current : { ...current, [id]: rule };
  }), []);

  // Editions of the open game (prepared on the server on first open).
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
  // Alarm targets ("Ziel" column, "Ziel erreicht") and the delivery log ("Alarm gesendet"), read once; the open detail keeps the rules current.
  useEffect(() => {
    const controller = new AbortController();
    void api<{ rules: (Rule & { wish_id: string })[]; events?: AlertEvent[] }>('/alerts', 'GET', undefined, undefined, controller.signal)
      .then(data => { if (controller.signal.aborted) return; setAlerts(Object.fromEntries(data.rules.map(rule => [rule.wish_id, rule]))); setEvents(data.events ?? null); }).catch(() => {});
    return () => controller.abort();
  }, []);
  // Request budget for the "Abrufe heute" tile, refreshed like the sidebar card (at most every 60 s, never while hidden).
  useEffect(() => {
    const controller = new AbortController(); let cancel = () => {};
    const load = () => {
      api<FetchStatusResponse>('/status/fetch', 'GET', undefined, undefined, controller.signal)
        .then(next => { if (!controller.signal.aborted) setFetchStatus(next); }).catch(() => {})
        .finally(() => { if (!controller.signal.aborted) cancel = whenVisible(load, FETCH_REFRESH_MS); });
    };
    load();
    return () => { controller.abort(); cancel(); };
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
    } catch (e) { if (generation === loadGeneration.current) { setListError(e instanceof Error ? e.message : 'Wunschliste konnte nicht geladen werden.'); onError(e); } }
    finally { if (generation === loadGeneration.current) setLoading(false); }
  }, [onCountChange, onError, updateBadges]);
  useEffect(() => { void load(); return () => { ++loadGeneration.current; }; }, [load]);
  useEffect(() => {
    function restore() { setTab(routeTab()); setSelectedId(routeSelection()); setFilter(routeFilter()); }
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);
  useEffect(() => {
    if (!removeItem && focusListAfterRemove.current) { focusListAfterRemove.current = false; listHeading.current?.focus({ preventScroll: true }); }
  }, [removeItem]);

  // List and game are two pages in one scroll area: the game starts at the top, the list returns to where it was.
  const detailOpen = !!selected;
  useLayoutEffect(() => {
    showingDetail.current = detailOpen;
    const main = scroller();
    if (detailOpen) { main?.scrollTo?.(0, 0); return; }
    main?.scrollTo?.(0, listScroll.current);
    const id = returnFocus.current; returnFocus.current = null;
    if (id) rows.current.get(id)?.focus({ preventScroll: true });
  }, [detailOpen]);
  useEffect(() => {
    const main = scroller();
    if (!main) return;
    const remember = () => { if (!showingDetail.current) listScroll.current = main.scrollTop; };
    main.addEventListener('scroll', remember, { passive: true });
    return () => main.removeEventListener('scroll', remember);
  }, []);

  function open(id: string) {
    // From the list one step back leads to it; from a game opened from the list one more; from a deep link none.
    const depth = showingDetail.current ? (listDepth() ? listDepth() + 1 : 0) : 1;
    if (!showingDetail.current) listScroll.current = scroller()?.scrollTop ?? 0;
    returnFocus.current = showingDetail.current ? null : id;
    setSelectedId(id); setMessage('');
    const url = new URL(window.location.href);
    url.hash = '';
    url.searchParams.delete('view'); url.searchParams.delete('tab'); url.searchParams.set('item', id);
    if (url.href !== window.location.href) window.history.pushState(depth ? { [FROM_LIST]: depth } : null, '', url);
  }
  /** Back to the list: a game opened from the list goes back in history (filter, sort and scroll are kept); a deep link pushes the list. */
  function closeDetail() {
    setSelectedId(null);
    if (returnToList()) return;
    const url = new URL(window.location.href);
    url.hash = '';
    url.searchParams.delete('item'); url.searchParams.delete('tab');
    if (url.href !== window.location.href) window.history.pushState(null, '', url);
  }
  function changeTab(value: TabId) {
    setTab(value);
    const url = new URL(window.location.href);
    url.hash = '';
    if (value === 'preis') url.searchParams.delete('tab'); else url.searchParams.set('tab', value);
    if (selected) url.searchParams.set('item', selected.id);
    const depth = listDepth();
    if (url.href !== window.location.href) window.history.pushState(depth ? { [FROM_LIST]: depth + 1 } : null, '', url);
  }
  function filterList(value: string) {
    setFilter(value);
    const url = new URL(window.location.href);
    if (value) url.searchParams.set('filter', value); else url.searchParams.delete('filter');
    window.history.replaceState(window.history.state, '', url);
  }
  function changeSort(value: SortMode) {
    setSort(value);
    try { localStorage.setItem(SORT_KEY, value); } catch { /* Keep in memory. */ }
  }
  function added(item: WishlistItem, created: boolean) {
    ++loadGeneration.current;
    const next = [item, ...items.filter(existing => existing.id !== item.id)];
    if (item.price_badge) updateBadge(item.id, item.price_badge);
    setItems(next); onCountChange(next.length); filterList(''); setChip('alle'); open(item.id);
    setMessage(created ? `${itemName(item)} wurde vorgemerkt.` : 'Dieser Titel ist bereits auf deiner Wunschliste.');
  }
  async function remove() {
    if (!removeItem || removing) return;
    setRemoving(true); setRemoveError('');
    try {
      await api(`/wishlist/${encodeURIComponent(removeItem.id)}`, 'DELETE', undefined, csrf);
      ++loadGeneration.current;
      const next = items.filter(item => item.id !== removeItem.id); setItems(next); onCountChange(next.length);
      if (selectedId === removeItem.id) { returnFocus.current = null; closeDetail(); }
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
      const next = items.filter(item => item.id !== selected.id); setItems(next); onCountChange(next.length);
      returnFocus.current = null; closeDetail();
      setMessage(`${itemName(selected)} wurde in die Bibliothek verschoben.`);
      requestAnimationFrame(() => listHeading.current?.focus({ preventScroll: true }));
    } catch (error) { onError(error); } finally { setPurchasing(false); }
  }
  function exportList() {
    downloadJson('keyhunter-wunschliste.json', wishlistExport(items));
  }

  // Derived list data: facts per row (price, cheapest region, saving, target), chips, sorting and KPI tiles.
  const facts = useMemo(() => Object.fromEntries(items.map(item => [item.id, rowFacts(badges[item.id] ?? item.price_badge, alerts[item.id])])) as Record<string, RowFacts>, [items, badges, alerts]);
  const all: Row[] = useMemo(() => items.map(item => ({ item, facts: facts[item.id] })), [items, facts]);
  const text = filter.toLocaleLowerCase('de-DE');
  const matching = items.filter(item => matchesChip(facts[item.id], chip) && (!text || [itemName(item), ...(item.game?.aliases ?? [])].some(name => name.toLocaleLowerCase('de-DE').includes(text))));
  const visible = sortWishlist(matching, facts, sort);
  const priced = all.filter(row => row.facts.price !== null).length;
  const reachedCount = all.filter(row => row.facts.reached).length;
  const chipCounts: Record<ChipFilter, number> = { alle: items.length, ziel: reachedCount, welt: all.filter(row => matchesChip(row.facts, 'welt')).length, offen: items.length - priced };
  const reached = useMemo(() => reachedTrend(all, alerts), [all, alerts]);
  const cheaper = useMemo(() => cheaperKpi(all), [all]);
  const budget = useMemo(() => fetchKpi(fetchStatus), [fetchStatus]);
  const sentToday = alarmSentToday(events);

  const variants = editionItems.flatMap(item => item.game ? [item.game] : []);
  if (selected?.game && !variants.some(g => g.igdb_id === selected.game?.igdb_id)) variants.unshift(selected.game);
  variants.sort((a, b) => (a.version_parent ? 1 : 0) - (b.version_parent ? 1 : 0) || a.igdb_id - b.igdb_id);
  const viewed = preview ?? selected;
  const title = selected ? itemName(selected) : null;
  useEffect(() => { onTitle(title); }, [title, onTitle]);
  useEffect(() => () => onTitle(null), [onTitle]);
  const scopeLabel = priceScope === 'all' ? 'Tiefster beobachteter Grundpreis · alle Regionen' : `Tiefster aktivierbarer Grundpreis · ${targetLabel}`;
  const code = targetCountry?.toUpperCase() ?? '';
  const priceLabel = priceScope === 'all' ? 'Bester Preis' : code ? `Preis ${code}` : 'Preis';

  const dialogs = <>
    <CatalogSearch open={addOpen} csrf={csrf} items={items} onClose={closeSearch} onAdded={added} onError={onError} />
    <ConfirmDialog open={removeItem !== null} title="Titel entfernen?" confirmLabel="Entfernen bestätigen" danger cancelLabel="Behalten" busy={removing} onCancel={() => setRemoveItem(null)} onConfirm={() => void remove()}>
      <p>„{removeItem ? itemName(removeItem) : ''}“ wird aus deiner Wunschliste entfernt.</p>
      {removeError && <Notice error>{removeError}</Notice>}
    </ConfirmDialog>
  </>;

  // The game as its own page (breadcrumb "Wunschliste › Titel" through onTitle).
  if (selected && viewed) return <>
    {message && <Notice>{message}</Notice>}
    <GameDetail key={selected.id} item={selected} viewed={viewed} preview={!!preview} variants={variants} editionItems={editionItems} editionError={editionError} badges={badges}
      csrf={csrf} targetCountry={targetCountry} targetLabel={targetLabel} tab={tab} purchasing={purchasing} onTab={changeTab} onBack={closeDetail} onPurchase={() => void purchase()}
      onRemove={() => { setRemoveError(''); setRemoveItem(selected); }} onView={chooseEdition} onClearPreview={() => setPreview(null)} onBadge={updateBadge} onSettings={onSettings} onError={onError} onRule={updateRule} />
    {dialogs}
  </>;
  if (loading && selectedId) return <p className="wl-loading" role="status">Wird geladen …</p>;

  const sub = loading ? 'Wird geladen …' : `${count(items.length)} von ${SLOTS} Plätzen · ${targetCountry ? `Zielland ${targetLabel}` : 'Kein Zielland gewählt'} · Preise verglichen mit allen Regionen`;
  const ready = !loading && !listError;
  const best = cheaper.best;
  return <div className="page wishlist-page">
    <header className="page-head">
      <div><h1 id="wishlist-title" ref={listHeading} tabIndex={-1}>Wunschliste</h1><p>{sub}</p></div>
      <div className="head-actions"><Button disabled={!ready || !items.length} onClick={exportList}><Icon name="download" />Liste exportieren</Button></div>
    </header>
    {message && <Notice>{message}</Notice>}
    {!loading && selectedId && !selected && <Notice>Der verlinkte Eintrag ist nicht mehr in deiner Wunschliste.</Notice>}
    {listError && <Notice error>{listError}<Button onClick={() => void load()}>Liste erneut laden</Button></Notice>}
    {ready && items.length > 0 && <div className="kpis">
      <Kpi label="Wünsche" value={count(items.length)} unit="Spiele" ticks={addedTicks(items)}
        foot={<><span>{count(priced)} mit Preis</span><span>{count(items.length - priced)} offen</span></>} />
      <Kpi label="Ziel erreicht" value={count(reachedCount)} unit="Spiele" ticks={reached.ticks}
        foot={(!!reached.since || sentToday) && <><span className="good">{reached.since ? `+${count(reached.since)} seit gestern` : ''}</span>{sentToday && <span>Alarm gesendet</span>}</>} />
      <Kpi label="Weltweit günstiger" value={count(cheaper.count)} unit="ab 20 %" ticks={cheaper.ticks}
        foot={best && <><span>bis</span><span className="hot">−{formatPrice(best.facts.saving!)} · {shortTitle(itemName(best.item))}</span></>} />
      <Kpi label="Abrufe heute" value={budget ? count(budget.used) : '–'} unit={budget ? `/ ${count(budget.limit)}` : undefined} ticks={budget?.ticks}
        foot={budget && budget.demand !== null && <><span>Bedarf ≈ {count(budget.demand)} pro Tag</span>{budget.demand > budget.limit ? <span className="warn">zu knapp</span> : <span className="good">reicht</span>}</>} />
    </div>}
    <Panel aria-label="Spiele">
      <PanelHead>
        <div className="chips" role="group" aria-label="Filter">
          {chipLabels.map(([id, label]) => <Chip key={id} pressed={chip === id} count={ready ? chipCounts[id] : null} disabled={!ready} onClick={() => setChip(id)}>{label}</Chip>)}
        </div>
        <span className="spacer" />
        <Field icon="search" className="wl-q"><input type="search" placeholder="Liste filtern …" aria-label="Liste filtern" value={filter} maxLength={200} onChange={event => filterList(event.target.value)} disabled={!ready || items.length === 0} /></Field>
        <Field className="wl-sort"><span className="muted">Sortieren</span><select aria-label="Sortieren" value={sort} onChange={event => changeSort(event.target.value as SortMode)}>
          <option value="added">Zuletzt hinzugefügt</option><option value="price">{priceLabel}</option><option value="save">Größte Ersparnis</option><option value="target">Nächster am Ziel</option>
        </select></Field>
      </PanelHead>
      <Inset className="table-wrap">
        {loading ? <p className="empty" role="status">Wunschliste wird geladen …</p>
          : items.length === 0 ? <EmptyState icon="heart" title={listError ? 'Die Liste ist derzeit nicht abrufbar.' : 'Deine Liste ist noch leer.'}
            action={!listError && <Button variant="primary" onClick={() => onAddOpen(true)}><Icon name="search" />Im Katalog suchen</Button>}>{listError ? '' : 'Suche ein Spiel und merke es vor, dann beobachtet KeyHunter den Preis.'}</EmptyState>
            : visible.length === 0 ? <p className="empty">Kein Spiel passt zu diesem Filter.</p>
              : <table className="wl" aria-label="Vorgemerkte Spiele">
                <thead><tr><th>Spiel</th><th className="r">{priceLabel}</th><th>Günstigste Region</th><th className="r">Ersparnis</th><th className="r">Ziel</th><th>Status</th><th>14 Tage</th><th><span className="sr-only">Öffnen</span></th></tr></thead>
                <tbody>{visible.map(item => <WishlistRow key={item.id} item={item} badge={badges[item.id] ?? item.price_badge} facts={facts[item.id]} code={code} compare={priceScope !== 'all'}
                  scopeLabel={scopeLabel} targetDisabled={!!alerts[item.id] && !alerts[item.id].enabled} onOpen={() => open(item.id)}
                  rowRef={element => { if (element) rows.current.set(item.id, element); else rows.current.delete(item.id); }} />)}</tbody>
              </table>}
      </Inset>
    </Panel>
    {dialogs}
  </div>;
}
