import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { CatalogGame, WishlistItem,PriceBadgeData } from '../api';
import { Button, CardHeading, ConfirmDialog, Icon, Notice } from '../components';
import CatalogSearch from './CatalogSearch';
import Offers from './Offers';
import PriceBadge from './PriceBadge';
import {mergeBadges} from './price-badges';
import EditionComparison from './EditionComparison';
import { sortWishlist } from './wishlist-sort';
import type { SortMode } from './wishlist-sort';
import { Cover, itemName, kindName, platformName, releaseYear } from './catalog-ui';

interface Props { csrf: string; targetCountry: string | null; targetLabel: string; priceScope: 'preferred'|'all'; onSettings: () => void; onCountChange: (count: number) => void; onError: (error: unknown) => void }
const compactLayout = '(max-width: 959px)';
const routeTab = () => window.location.hash === '#alert-editor-title' ? 'alert' : 'offers';
const routeSelection = () => new URL(window.location.href).searchParams.get('item');
export default function Wishlist({ csrf, targetCountry, targetLabel, priceScope, onSettings, onCountChange, onError }: Props) {
  const [items, setItems] = useState<WishlistItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [message, setMessage] = useState('');
  const [filter, setFilter] = useState(() => new URL(window.location.href).searchParams.get('filter') ?? '');
  const [selectedId, setSelectedId] = useState<string | null>(routeSelection);
  const [searchOpen, setSearchOpen] = useState(false);
  const [preview,setPreview]=useState<WishlistItem|null>(null);
  const [sort,setSort]=useState<SortMode>(()=>{try{const value=localStorage.getItem('keyhunter.wishlist.sort');return value==='price'||value==='name'?value:'added';}catch{return 'added';}});
  const [badges,setBadges]=useState<Record<string,PriceBadgeData>>({});
  const [editionItems,setEditionItems]=useState<WishlistItem[]>([]);
  const prices=useMemo(()=>Object.fromEntries(Object.entries(badges).map(([id,badge])=>[id,badge.cents])),[badges]);
  const [tab, setTab] = useState(routeTab);
  const [editionError, setEditionError] = useState('');
  const [removeItem, setRemoveItem] = useState<WishlistItem | null>(null);
  const [purchasing,setPurchasing]=useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState('');
  const listScroll = useRef(0);
  const loadGeneration = useRef(0);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const focusListAfterRemove = useRef(false);
  const selected = items.find(item => item.id === selectedId);
  const updateBadges=useCallback((entries:Record<string,PriceBadgeData>)=>{
    setBadges(current=>mergeBadges(current,entries));
  },[]);
  const updateBadge=useCallback((id:string,badge:PriceBadgeData)=>updateBadges({[id]:badge}),[updateBadges]);
  useEffect(() => {
    setPreview(null);
    setTab(routeTab());setEditionItems([]);setEditionError('');
    if(!selected?.game)return;
    const controller=new AbortController();let timer:number;
    async function prepare(method='POST') {
      try {
        const data=await api<{items:WishlistItem[];preparing:boolean;error:string|null}>(`/wishlist/${selected!.id}/editions`,method,method==='POST'?{}:undefined,csrf,controller.signal);
        if(controller.signal.aborted)return;
        setEditionItems(data.items);setEditionError(data.error??(data.preparing?'Editionen werden vorbereitet …':''));
        updateBadges(Object.fromEntries(data.items.flatMap(item=>item.price_badge?[[item.id,item.price_badge]]:[])));
        if(data.preparing)timer=window.setTimeout(()=>void prepare('GET'),3000);
      }catch(error){if(!controller.signal.aborted)setEditionError(error instanceof Error?error.message:'Editionen konnten nicht geladen werden.');}
    }
    void prepare();return()=>{controller.abort();clearTimeout(timer);};
  },[selected?.id,selected?.game?.igdb_id,selected?.platform_id,csrf,updateBadges]);
  function chooseEdition(game: CatalogGame) {
    if (!selected) return;
    if (game.igdb_id === selected.game?.igdb_id) {
      setPreview(null);
    } else {
      const prepared = editionItems.find(item => item.game?.igdb_id === game.igdb_id);
      if (prepared) setPreview(prepared);
    }
  }

  useEffect(() => {
    if(!items.length)return;
    const controller=new AbortController();let timer:number;
    async function readPrices(){
      let pending=false;
      try{const data=await api<Record<string,PriceBadgeData>>(`/wishlist/price-badges?anchor=${selected?.id ?? ''}`,'GET',undefined,undefined,controller.signal);
        if(!controller.signal.aborted){updateBadges(data);pending=Object.values(data).some(badge=>badge.pending);}
      }catch{/* Retain saved badges during a failed local read. */}
      if(!controller.signal.aborted)timer=window.setTimeout(()=>void readPrices(),pending?3000:30000);
    }
    void readPrices();return()=>{controller.abort();clearTimeout(timer);};
  },[items,priceScope,targetCountry,updateBadges,selected?.id]);
  const closeSearch = useCallback(() => setSearchOpen(false), []);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true); setListError('');
    try {
      const rows = await api<WishlistItem[]>('/wishlist');
      if (generation !== loadGeneration.current) return;
      updateBadges(Object.fromEntries(rows.flatMap(item=>item.price_badge?[[item.id,item.price_badge]]:[])));
      setItems(rows); onCountChange(rows.length);
      if (!routeSelection() && !window.matchMedia(compactLayout).matches) setSelectedId(rows[0]?.id ?? null);
    } catch (e) { if (generation === loadGeneration.current) { setListError(e instanceof Error ? e.message : 'Wunschliste konnte nicht geladen werden.'); onError(e); } }
    finally { if (generation === loadGeneration.current) setLoading(false); }
  }, [onCountChange, onError,updateBadges]);
  useEffect(() => { void load(); return () => { ++loadGeneration.current; }; }, [load]);
  useEffect(() => {
    function restore() { setTab(routeTab()); setSelectedId(routeSelection()); setFilter(new URL(window.location.href).searchParams.get('filter') ?? ''); }
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);
  useEffect(() => {
    if (!removeItem && focusListAfterRemove.current) {
      focusListAfterRemove.current = false;
      listHeading.current?.focus({ preventScroll: true });
    }
  }, [removeItem]);

  function select(id: string | null) {
    if (id) listScroll.current = window.scrollY;
    setSelectedId(id); setMessage('');
    const url = new URL(window.location.href);
    url.hash = '';
    url.searchParams.delete('view');
    if (id) url.searchParams.set('item', id); else url.searchParams.delete('item');
    if (url.href !== window.location.href) window.history.pushState(null, '', url);
    if (window.matchMedia(compactLayout).matches) requestAnimationFrame(() => window.scrollTo(0, id ? 0 : listScroll.current));
  }
  function changeTab(value: string) {
    setTab(value);
    const url = new URL(window.location.href);
    url.hash = value === 'alert' ? 'alert-editor-title' : '';
    if (selected) url.searchParams.set('item', selected.id);
    window.history.replaceState(null, '', url);
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
    if(item.price_badge)updateBadge(item.id,item.price_badge);
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
  async function purchase(){
    if(!selected||preview||purchasing)return;
    setPurchasing(true);setMessage('');
    try{await api(`/wishlist/${selected.id}/purchase`,'POST',{},csrf);
      ++loadGeneration.current;
      const rows=items.filter(item=>item.id!==selected.id);setItems(rows);onCountChange(rows.length);select(null);
      setMessage(`${itemName(selected)} wurde in die Bibliothek verschoben.`);
      listHeading.current?.focus();
    }catch(error){onError(error);}finally{setPurchasing(false);}
  }
  function exportList() {
    const data = { version: 1, exported_at: new Date().toISOString(), items: items.map(item => ({
      title: itemName(item), platform: platformName(item.platform_id), igdb_id: item.game?.igdb_id ?? null,
      kind: item.game?.kind ?? null, verification: item.verification,
    })) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'keyhunter-wunschliste.json';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const text = filter.toLocaleLowerCase('de-DE');
  const visible = sortWishlist(items.filter(item => [itemName(item), ...(item.game?.aliases ?? [])].some(name => name.toLocaleLowerCase('de-DE').includes(text))),prices,sort);

  const variants = editionItems.flatMap(item => item.game ? [item.game] : []);
  if (selected?.game && !variants.some(g => g.igdb_id === selected.game?.igdb_id)) variants.unshift(selected.game);
  const viewed=preview??selected;
  const heroGame = variants.find(game => game.igdb_id === viewed?.game?.igdb_id) ?? viewed?.game;
  variants.sort((a,b) => (a.version_parent ? 1 : 0) - (b.version_parent ? 1 : 0) || a.igdb_id - b.igdb_id);
  return <div className={`wishlist-feature ${selected ? 'has-selection' : ''}`}>
    <section className="list-panel" aria-labelledby="wishlist-title">
      <div className="wishlist-head"><div><h1 id="wishlist-title" ref={listHeading} tabIndex={-1}>Meine Wunschliste</h1></div><Button title="Spiel hinzufügen" aria-label="Spiel hinzufügen" className="add-game-button" disabled={loading || !!listError || items.length >= 100} onClick={() => setSearchOpen(true)}><Icon name="plus" size={21} /></Button></div>
      <div className="list-count"><span>{loading ? 'Wird geladen …' : `${items.length} von 100 Spielen`}</span></div>
      <label className="search-label" htmlFor="wishlist-filter">Wunschliste filtern</label><div className="list-search"><Icon name="search" size={15} /><input id="wishlist-filter" placeholder="Liste filtern …" value={filter} maxLength={200} onChange={event => filterList(event.target.value)} disabled={loading || items.length === 0} /></div>
      <div className="wishlist-sort"><label htmlFor="wishlist-sort">Sortieren</label><select id="wishlist-sort" aria-label="Wunschliste sortieren" value={sort} onChange={e=>{const value=e.target.value as SortMode;setSort(value);try{localStorage.setItem('keyhunter.wishlist.sort',value);}catch{/* Keep in memory. */}}}><option value="added">Hinzugefügt am · neueste zuerst</option><option value="price">Preis · günstigste zuerst</option><option value="name">Alphabetisch · A–Z</option></select></div>
      {message && <Notice>{message}</Notice>}
      {!loading && selectedId && !selected && <Notice>Der verlinkte Eintrag ist nicht mehr in deiner Wunschliste.</Notice>}
      {listError && <Notice error>{listError}<Button secondary onClick={() => void load()}>Liste erneut laden</Button></Notice>}
      {loading ? <p className="list-loading" role="status">Wunschliste wird geladen …</p> : items.length === 0 ? <div className="list-empty"><Icon name="heart" size={32} /><p>{listError ? 'Die Liste ist derzeit nicht abrufbar.' : 'Deine Liste ist noch leer.'}</p></div> : visible.length === 0 ? <p className="list-loading">Kein Titel passt zu deinem Listenfilter.</p> : <ul className="wishlist-items" aria-label="Vorgemerkte Spiele">{visible.map(item => <li key={item.id}><button className={`wishlist-entry ${selectedId === item.id ? 'selected' : ''}`} onClick={() => select(item.id)} aria-current={selectedId === item.id ? 'true' : undefined}><Cover src={item.game?.cover_url ?? null} /><div><strong>{itemName(item)}</strong><span><Icon name="game" size={13} />{platformName(item.platform_id)}</span><span className={item.verification === 'catalog' ? 'entry-kind' : 'entry-unverified'}>{item.game ? `${item.verification === 'needs_review' ? 'Zu prüfen · ' : ''}${kindName(item.game)}` : 'Manuell · ungeprüft'}</span></div><PriceBadge className="list-price" badge={badges[item.id]??item.price_badge} scopeLabel={priceScope==='all'?'Tiefster beobachteter Grundpreis · alle Regionen':`Tiefster aktivierbarer Grundpreis · ${targetLabel}`}/></button></li>)}</ul>}
      <div className="list-footer"><Button secondary disabled={loading || !!listError || !items.length} onClick={exportList}><Icon name="download" size={14} />Liste exportieren</Button></div>
    </section>
    {selected ? <section className="game-detail" aria-labelledby="game-title">
      <div className="game-hero">
        {heroGame?.artwork_url && <img className="hero-artwork" src={heroGame.artwork_url} alt="" referrerPolicy="no-referrer" onError={event => { event.currentTarget.style.display = 'none'; }} />}
        <div className="hero-shade" />
        <div className="breadcrumbs"><Button secondary className="mobile-back" onClick={() => select(null)}><span aria-hidden="true">‹</span> Zur Wunschliste</Button><span className="desktop-breadcrumb">Wunschliste <Icon name="arrow" size={13} /> {itemName(selected)}</span></div>
        <div className="hero-inner"><Cover src={viewed?.game?.cover_url ?? null} large /><div className="game-hero-copy"><h2 id="game-title">{viewed?itemName(viewed):itemName(selected)}</h2><div className="hero-chips"><span className="platform-chip"><Icon name="game" size={13} />{platformName(selected.platform_id)}</span><span className="chip">{viewed?.game ? kindName(viewed.game) : 'Manuell · ungeprüft'}</span><span className="chip">{releaseYear(viewed?.game?.first_release_date ?? null)}</span>{viewed&&<PriceBadge badge={badges[viewed.id]??viewed.price_badge}/>}</div><p className="hero-description">{heroGame?.summary ?? 'Für diesen Titel liegen noch keine Kataloginformationen vor.'}</p></div></div>
        <div className="hero-actions">{preview?<><span className="preview-label">Vorschau · gemerkt: {itemName(selected)}</span><Button secondary onClick={()=>setPreview(null)}>Zur gemerkten Edition</Button></>:<><Button secondary onClick={()=>{setRemoveError('');setRemoveItem(selected);}}><Icon name="heart"/>Auf der Wunschliste <span>✓</span></Button><Button secondary onClick={()=>changeTab('alert')}><Icon name="bell"/>Preisalarm</Button><Button secondary disabled={purchasing} onClick={()=>void purchase()}><Icon name="library"/>{purchasing?'Wird verschoben …':'Als gekauft markieren'}</Button></>}</div>
      </div>
      <nav className="section-nav content-tabs" aria-label="Spieldetails">{[['offers','tag','Angebote & Preise','Angebote'],['editions','layers','Editionen vergleichen','Editionen'],['history','chart','Preisverlauf','Verlauf'],['info','info','Spielinfos','Infos']].map(([value,icon,label,shortLabel]) => <button key={value} aria-label={label} className={tab === value ? 'active' : ''} aria-current={tab === value ? 'page' : undefined} onClick={() => changeTab(value)}><Icon name={icon} /><span className="wide-label">{label}</span><span className="compact-label">{shortLabel}</span></button>)}</nav>
      {!targetCountry && <div className="country-callout"><span>Wähle dein Zielland für den Preisvergleich.</span><Button secondary onClick={onSettings}>Zielland wählen</Button></div>}
      {selected.verification !== 'catalog' && <Notice>{selected.verification === 'needs_review' ? 'Die Katalogdaten bestätigen diese Auswahl nicht mehr. Bitte prüfe Plattform und Produkttyp.' : 'Manueller Titel · Zuordnungen werden vor dem Preisvergleich geprüft.'}</Notice>}
      <Offers key={`${selected.id}:${viewed?.id}`} id={viewed?.id??selected.id} csrf={csrf} targetLabel={targetLabel} tab={tab} onError={onError} onBadge={updateBadge} editionPanel={<section className="dashboard-card edition-card edition-selector"><CardHeading icon="game" title="Edition ansehen"><span>{variants.length} {variants.length === 1 ? 'Edition' : 'Editionen'}</span></CardHeading>{editionError && <p className="field-help">{editionError}</p>}<div className="edition-rows">{variants.map(game => {const track=game.igdb_id===selected.game?.igdb_id?selected:editionItems.find(item=>item.game?.igdb_id===game.igdb_id);return <button className={`edition-row ${viewed?.game?.igdb_id === game.igdb_id ? 'selected' : ''}`} key={game.igdb_id} aria-label={`${game.edition_name??game.name} ansehen`} onClick={() => chooseEdition(game)}><Cover src={game.cover_url} /><span><strong>{game.edition_name ?? (game.kind === 'base_game' ? 'Standard Edition' : game.name)}</strong><small>{game.version_parent ? 'Eigenständige Edition' : 'Hauptspiel'}</small></span>{selected.game?.igdb_id===game.igdb_id&&<span className="selection-badge">Gemerkt</span>}{preview&&viewed?.game?.igdb_id===game.igdb_id&&<span className="selection-badge preview">Vorschau</span>}<PriceBadge badge={track?(badges[track.id]??track.price_badge):undefined}/><Icon name="arrow" size={16} /></button>;})}</div></section>} comparisonPanel={selected.game?<EditionComparison gameId={selected.game.igdb_id} platformId={selected.platform_id} games={variants} savedId={selected.game.igdb_id}/>:<Notice>Für diesen manuellen Titel liegen keine bestätigten Editionen vor.</Notice>} infoPanel={<section className="dashboard-card info-card"><CardHeading icon="info" title="Spielinformationen" /><p>{viewed?.game?.summary ?? 'Für diesen Titel liegt noch keine Beschreibung vor.'}</p>{selected.game?.kind === 'edition' && <p className="metadata-note">Die Inhalte des konkreten Händlerangebots sind auf der Produktseite beschrieben.</p>}{selected.game?.aliases.length ? <p className="metadata-note">Auch bekannt als {selected.game.aliases.join(' · ')}</p> : null}{selected.game?.slug && <a className="source-link" href={`https://www.igdb.com/games/${selected.game.slug}`} target="_blank" rel="noopener noreferrer">Spieledaten von IGDB <Icon name="external" size={14} /></a>}</section>} />
    </section> : <section className="empty-detail" aria-labelledby="empty-title">
      <Icon name="heart" size={30} />
      <h2 id="empty-title">{items.length ? 'Spiel auswählen' : 'Wunschliste leer'}</h2>
      {!items.length && <Button onClick={() => setSearchOpen(true)} disabled={loading || !!listError}>Im Katalog suchen</Button>}
    </section>}
    <CatalogSearch open={searchOpen} csrf={csrf} items={items} onClose={closeSearch} onAdded={added} onError={onError} />
    <ConfirmDialog
      open={removeItem !== null}
      title="Titel entfernen?"
      confirmLabel="Entfernen bestätigen"
      cancelLabel="Behalten"
      busy={removing}
      onCancel={() => setRemoveItem(null)}
      onConfirm={() => void remove()}
    >
      <p>„{removeItem ? itemName(removeItem) : ''}“ wird aus deiner Wunschliste entfernt.</p>
      {removeError && <Notice error>{removeError}</Notice>}
    </ConfirmDialog>
  </div>;
}
