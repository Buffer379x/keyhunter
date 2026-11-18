import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { CatalogGame, WishlistItem } from '../api';
import { Button, Icon, KeyMark, Notice } from '../components';
import CatalogSearch from './CatalogSearch';
import Offers, { money } from './Offers';
import { Cover, itemName, kindName, platformName, releaseYear } from './catalog-ui';

interface Props { searchSignal: number; csrf: string; targetCountry: string | null; targetLabel: string; onSettings: () => void; onCountChange: (count: number) => void; onError: (error: unknown) => void }
const routeSelection = () => new URL(window.location.href).searchParams.get('item');
export default function Wishlist({ searchSignal, csrf, targetCountry, targetLabel, onSettings, onCountChange, onError }: Props) {
  const [items, setItems] = useState<WishlistItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [message, setMessage] = useState('');
  const [filter, setFilter] = useState(() => new URL(window.location.href).searchParams.get('filter') ?? '');
  const [selectedId, setSelectedId] = useState<string | null>(routeSelection);
  const [searchOpen, setSearchOpen] = useState(false);
  const [prices, setPrices] = useState<Record<string, number | null>>({});
  const [tab, setTab] = useState('offers');
  const [editions, setEditions] = useState<CatalogGame[]>([]);
  const [editionBusy, setEditionBusy] = useState(false);
  const [editionError, setEditionError] = useState('');
  useEffect(() => { if (searchSignal) setSearchOpen(true); }, [searchSignal]);
  const [removeItem, setRemoveItem] = useState<WishlistItem | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState('');
  const listScroll = useRef(0);
  const loadGeneration = useRef(0);
  const removeDialog = useRef<HTMLDialogElement>(null);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const focusListAfterRemove = useRef(false);
  const selected = items.find(item => item.id === selectedId);
  useEffect(() => {
    setTab('offers'); setEditions([]); setEditionError('');
    if (!selected?.game) return;
    const controller = new AbortController();
    void api<CatalogGame[]>(`/catalog/games/${selected.game.igdb_id}/editions`, 'GET', undefined, undefined, controller.signal)
      .then(rows => { if (!controller.signal.aborted) setEditions(rows.filter(game => game.platforms.some(p => p.id === selected.platform_id))); })
      .catch(error => { if (!controller.signal.aborted) setEditionError(error instanceof Error ? error.message : 'Editionen konnten nicht geladen werden.'); });
    return () => controller.abort();
  }, [selected?.id, selected?.game?.igdb_id, selected?.platform_id]);
  async function chooseEdition(game: CatalogGame) {
    if (!selected || editionBusy) return;
    const existing = items.find(item => item.game?.igdb_id === game.igdb_id && item.platform_id === selected.platform_id);
    if (existing) { select(existing.id); return; }
    setEditionBusy(true); setEditionError('');
    try {
      const result = await api<{ item: WishlistItem; created: boolean }>('/wishlist', 'POST', { igdb_id: game.igdb_id, platform_id: selected.platform_id }, csrf);
      added(result.item, result.created);
    } catch (error) { setEditionError(error instanceof Error ? error.message : 'Edition konnte nicht ausgewählt werden.'); }
    finally { setEditionBusy(false); }
  }
  useEffect(() => {
    if (!items.length) return;
    const controller = new AbortController();
    async function readPrices() {
      try {
        const data = await api<Record<string, number | null>>('/wishlist/prices','GET',undefined,undefined,controller.signal);
        if (!controller.signal.aborted) setPrices(data);
      } catch { /* The detail view provides source errors. */ }
    }
    void readPrices();
    const timer=window.setInterval(() => void readPrices(),30000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [items]);
  const closeSearch = useCallback(() => setSearchOpen(false), []);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true); setListError('');
    try {
      const rows = await api<WishlistItem[]>('/wishlist');
      if (generation !== loadGeneration.current) return;
      setItems(rows); onCountChange(rows.length);
      if (!routeSelection() && !window.matchMedia('(max-width: 767px)').matches) setSelectedId(rows[0]?.id ?? null);
    } catch (e) { if (generation === loadGeneration.current) { setListError(e instanceof Error ? e.message : 'Wunschliste konnte nicht geladen werden.'); onError(e); } }
    finally { if (generation === loadGeneration.current) setLoading(false); }
  }, [onCountChange, onError]);
  useEffect(() => { void load(); return () => { ++loadGeneration.current; }; }, [load]);
  useEffect(() => {
    function restore() { setSelectedId(routeSelection()); setFilter(new URL(window.location.href).searchParams.get('filter') ?? ''); }
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);
  useEffect(() => {
    if (removeItem) removeDialog.current?.showModal();
    else {
      removeDialog.current?.close();
      if (focusListAfterRemove.current) { focusListAfterRemove.current = false; listHeading.current?.focus(); }
    }
  }, [removeItem]);

  function select(id: string | null) {
    if (id) listScroll.current = window.scrollY;
    setSelectedId(id); setMessage('');
    const url = new URL(window.location.href);
    url.searchParams.delete('view');
    if (id) url.searchParams.set('item', id); else url.searchParams.delete('item');
    if (url.href !== window.location.href) window.history.pushState(null, '', url);
    if (window.matchMedia('(max-width: 767px)').matches) requestAnimationFrame(() => window.scrollTo(0, id ? 0 : listScroll.current));
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
  const visible = items.filter(item => [itemName(item), ...(item.game?.aliases ?? [])].some(name => name.toLocaleLowerCase('de-DE').includes(text)));

  const variants = [...editions];
  if (selected?.game && !variants.some(g => g.igdb_id === selected.game?.igdb_id)) variants.unshift(selected.game);
  const heroGame = variants.find(game => game.igdb_id === selected?.game?.igdb_id) ?? selected?.game;
  variants.sort((a,b) => (a.version_parent ? 1 : 0) - (b.version_parent ? 1 : 0) || a.igdb_id - b.igdb_id);
  return <div className={`wishlist-feature ${selected ? 'has-selection' : ''}`}>
    <section className="list-panel" aria-labelledby="wishlist-title">
      <div className="wishlist-head"><div><p className="eyebrow">DEINE SAMMLUNG</p><h1 id="wishlist-title" ref={listHeading} tabIndex={-1}>Meine Wunschliste</h1></div><Button title="Spiel hinzufügen" aria-label="Spiel hinzufügen" className="add-game-button" disabled={loading || !!listError || items.length >= 100} onClick={() => setSearchOpen(true)}><Icon name="plus" size={21} /></Button></div>
      <div className="list-count"><span>Gespeicherte Spiele</span><span>{loading ? 'Wird geladen …' : `${items.length} von 100 Spielen`}</span></div>
      <label className="search-label" htmlFor="wishlist-filter">Wunschliste filtern</label><div className="list-search"><Icon name="search" size={15} /><input id="wishlist-filter" placeholder="Liste filtern …" value={filter} maxLength={200} onChange={event => filterList(event.target.value)} disabled={loading || items.length === 0} /></div>
      {listError && <Notice error>{listError}<Button secondary onClick={() => void load()}>Liste erneut laden</Button></Notice>}
      {loading ? <p className="list-loading" role="status">Wunschliste wird geladen …</p> : items.length === 0 ? <div className="list-empty"><Icon name="heart" size={32} /><p>{listError ? 'Die Liste ist derzeit nicht abrufbar.' : 'Deine Liste ist noch leer.'}</p></div> : visible.length === 0 ? <p className="list-loading">Kein Titel passt zu deinem Listenfilter.</p> : <ul className="wishlist-items" aria-label="Vorgemerkte Spiele">{visible.map(item => <li key={item.id}><button className={`wishlist-entry ${selectedId === item.id ? 'selected' : ''}`} onClick={() => select(item.id)} aria-current={selectedId === item.id ? 'true' : undefined}><Cover src={item.game?.cover_url ?? null} /><div><strong>{itemName(item)}</strong><span><Icon name="game" size={13} />{platformName(item.platform_id)}</span><span className={item.verification === 'catalog' ? 'entry-kind' : 'entry-unverified'}>{item.game ? `${item.verification === 'needs_review' ? 'Zu prüfen · ' : ''}${kindName(item.game)}` : 'Manuell · ungeprüft'}</span></div>{prices[item.id] != null && <span className="list-price">ab {money(prices[item.id]!)}</span>}</button></li>)}</ul>}
      <div className="list-footer"><span><Icon name="refresh" size={14} /> Angebote werden automatisch gesucht</span><Button secondary disabled={loading || !!listError || !items.length} onClick={exportList}><Icon name="download" size={14} />Liste exportieren</Button></div>
    </section>
    {selected ? <section className="game-detail" aria-labelledby="game-title">
      <div className="game-hero">
        {heroGame?.artwork_url && <img className="hero-artwork" src={heroGame.artwork_url} alt="" referrerPolicy="no-referrer" onError={event => { event.currentTarget.style.display = 'none'; }} />}
        <div className="hero-shade" />
        <div className="breadcrumbs"><Button secondary className="mobile-back" onClick={() => select(null)}>‹ Zur Wunschliste</Button><span className="desktop-breadcrumb">Wunschliste <Icon name="arrow" size={13} /> {itemName(selected)}</span></div>
        <div className="hero-inner"><Cover src={selected.game?.cover_url ?? null} large /><div className="game-hero-copy"><p className="game-kicker">XBOX GAME PRICE TRACKER <span /></p><h2 id="game-title">{itemName(selected)}</h2><div className="hero-chips"><span className="platform-chip"><Icon name="game" size={13} />{platformName(selected.platform_id)}</span><span className="chip">{selected.game ? kindName(selected.game) : 'Manuell · ungeprüft'}</span><span className="chip">{releaseYear(selected.game?.first_release_date ?? null)}</span></div><p className="hero-description">{heroGame?.summary ?? 'Für diesen Titel liegen noch keine Kataloginformationen vor.'}</p></div></div>
        <div className="hero-actions"><Button secondary onClick={() => { setRemoveError(''); setRemoveItem(selected); }}><Icon name="heart" />Auf der Wunschliste <span>✓</span></Button><Button secondary onClick={() => setTab('alert')}><Icon name="bell" />Preisalarm</Button></div>
      </div>
      <nav className="content-tabs" aria-label="Spieldetails">{[['offers','tag','Angebote & Preise'],['editions','layers','Editionen vergleichen'],['history','chart','Preisverlauf'],['info','info','Spielinfos']].map(([value,icon,label]) => <button key={value} className={tab === value ? 'active' : ''} aria-current={tab === value ? 'page' : undefined} onClick={() => setTab(value)}><Icon name={icon} /><span>{label}</span></button>)}</nav>
      {message && <Notice>{message}</Notice>}
      {!targetCountry && <div className="country-callout"><span>Wähle dein Zielland für den Preisvergleich.</span><Button secondary onClick={onSettings}>Zielland wählen</Button></div>}
      {selected.verification !== 'catalog' && <Notice>{selected.verification === 'needs_review' ? 'Die Katalogdaten bestätigen diese Auswahl nicht mehr. Bitte prüfe Plattform und Produkttyp.' : 'Manueller Titel · Zuordnungen werden vor dem Preisvergleich geprüft.'}</Notice>}
      <Offers key={selected.id} id={selected.id} csrf={csrf} targetLabel={targetLabel} tab={tab} onError={onError} editionPanel={<section className="dashboard-card edition-card"><div className="card-heading"><Icon name="game" /><h3>Editionen & Auswahl</h3><span>{variants.length} {variants.length === 1 ? 'Edition' : 'Editionen'}</span></div>{editionError && <p className="field-help">{editionError}</p>}<div className="edition-rows">{variants.map(game => <button className={`edition-row ${selected.game?.igdb_id === game.igdb_id ? 'selected' : ''}`} key={game.igdb_id} disabled={editionBusy} onClick={() => void chooseEdition(game)}><Cover src={game.cover_url} /><span><strong>{game.edition_name ?? (game.kind === 'base_game' ? 'Standard Edition' : game.name)}</strong><small>{game.version_parent ? 'Eigenständige Edition' : 'Hauptspiel'}</small></span>{selected.game?.igdb_id === game.igdb_id && <span className="selection-badge">Ausgewählt</span>}<Icon name="arrow" size={16} /></button>)}</div></section>} infoPanel={<section className="dashboard-card info-card"><div className="card-heading"><Icon name="info" /><h3>Spielinformationen</h3></div><p>{selected.game?.summary ?? 'Für diesen Titel liegt noch keine Beschreibung vor.'}</p>{selected.game?.kind === 'edition' && <p className="metadata-note">Die Inhalte des konkreten Händlerangebots sind auf der Produktseite beschrieben.</p>}{selected.game?.aliases.length ? <p className="metadata-note">Auch bekannt als {selected.game.aliases.join(' · ')}</p> : null}{selected.game?.slug && <a className="source-link" href={`https://www.igdb.com/games/${selected.game.slug}`} target="_blank" rel="noopener noreferrer">Spieledaten von IGDB <Icon name="external" size={14} /></a>}</section>} />
    </section> : <section className="empty-detail" aria-labelledby="empty-title"><div className="empty-orbit"><KeyMark /></div><h2 id="empty-title">{items.length ? 'Wähle ein Wunschspiel' : 'Dein nächstes Spiel wartet.'}</h2><p>{items.length ? 'Öffne einen Titel aus deiner Liste, um die Angebote zu vergleichen.' : 'Suche dein Spiel. KeyHunter findet passende Xbox-Angebote für deine Auswahl.'}</p>{selectedId && !loading && <p>Der verlinkte Eintrag ist nicht mehr in deiner Liste.</p>}<Button onClick={() => setSearchOpen(true)} disabled={loading || !!listError || items.length >= 100}>Im Katalog suchen</Button></section>}
    <CatalogSearch open={searchOpen} csrf={csrf} items={items} onClose={closeSearch} onAdded={added} onError={onError} />
    <dialog ref={removeDialog} aria-labelledby="remove-title" onCancel={event => { if (removing) event.preventDefault(); else setRemoveItem(null); }}><p className="eyebrow">WUNSCHLISTE VERWALTEN</p><h2 id="remove-title">Titel entfernen?</h2><p>„{removeItem ? itemName(removeItem) : ''}“ wird aus deiner Wunschliste entfernt.</p>{removeError && <Notice error>{removeError}</Notice>}<div className="dialog-actions"><Button secondary disabled={removing} onClick={() => setRemoveItem(null)}>Behalten</Button><Button disabled={removing} onClick={() => void remove()}>{removing ? 'Wird entfernt …' : 'Entfernen bestätigen'}</Button></div></dialog>
  </div>;
}
