import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { WishlistItem } from '../api';
import { Button, KeyMark, Notice } from '../components';
import CatalogSearch from './CatalogSearch';
import Offers from './Offers';
import { Cover, itemName, kindName, platformName, releaseYear } from './catalog-ui';

interface Props { csrf: string; targetCountry: string | null; targetLabel: string; onSettings: () => void; onCountChange: (count: number) => void; onError: (error: unknown) => void }
const routeSelection = () => new URL(window.location.href).searchParams.get('item');
export default function Wishlist({ csrf, targetCountry, targetLabel, onSettings, onCountChange, onError }: Props) {
  const [items, setItems] = useState<WishlistItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [message, setMessage] = useState('');
  const [filter, setFilter] = useState(() => new URL(window.location.href).searchParams.get('filter') ?? '');
  const [selectedId, setSelectedId] = useState<string | null>(routeSelection);
  const [searchOpen, setSearchOpen] = useState(false);
  const [removeItem, setRemoveItem] = useState<WishlistItem | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState('');
  const listScroll = useRef(0);
  const loadGeneration = useRef(0);
  const removeDialog = useRef<HTMLDialogElement>(null);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const focusListAfterRemove = useRef(false);
  const selected = items.find(item => item.id === selectedId);
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

  return <div className={`wishlist-feature ${selected ? 'has-selection' : ''}`}>
    <div className="page-heading"><div><p className="eyebrow">DEIN NÄCHSTES SPIEL WARTET</p><h1>Meine Wunschliste<span className="accent-dot">.</span></h1><p>Alles, was du als Nächstes spielen möchtest.</p></div><div className="heading-actions"><Button secondary disabled={loading || !!listError || !items.length} onClick={exportList}>Liste exportieren</Button><span className="subtle-tag">{loading ? 'Wird geladen …' : `${items.length} von 100 Spielen`}</span><Button disabled={loading || !!listError || items.length >= 100} onClick={() => setSearchOpen(true)}>Spiel hinzufügen<span aria-hidden="true"> +</span></Button></div></div>
    {message && <Notice>{message}</Notice>}
    {listError && <Notice error>{listError}<div><Button secondary onClick={() => void load()}>Liste erneut laden</Button></div></Notice>}
    {!targetCountry && <div className="country-callout"><div><strong>Wo möchtest du deine Keys aktivieren?</strong><p>Wähle dein Zielland, damit Angebote passend eingeordnet werden.</p></div><Button secondary onClick={onSettings}>Zielland wählen</Button></div>}
    <div className="wishlist-layout">
      <section className="list-panel" aria-labelledby="wishlist-title"><div className="panel-heading"><h2 id="wishlist-title" ref={listHeading} tabIndex={-1}>Vorgemerkt</h2><span>{loading ? '…' : items.length}</span></div><label className="search-label" htmlFor="wishlist-filter">Wunschliste filtern</label><input id="wishlist-filter" placeholder="Titel in deiner Liste …" value={filter} maxLength={200} onChange={event => filterList(event.target.value)} disabled={loading || items.length === 0} />
        {loading ? <p className="list-loading" role="status">Wunschliste wird geladen …</p> : items.length === 0 ? <div className="list-empty"><span aria-hidden="true">☆</span><p>{listError ? 'Die Liste ist derzeit nicht abrufbar.' : 'Deine Liste ist noch leer.'}</p></div> : visible.length === 0 ? <p className="list-loading">Kein Titel passt zu deinem Listenfilter.</p> : <ul className="wishlist-items" aria-label="Vorgemerkte Spiele">{visible.map(item => <li key={item.id}><button className={`wishlist-entry ${selectedId === item.id ? 'selected' : ''}`} onClick={() => select(item.id)} aria-current={selectedId === item.id ? 'true' : undefined}><Cover src={item.game?.cover_url ?? null} /><div><strong>{itemName(item)}</strong><span>{platformName(item.platform_id)}</span><span className={item.verification === 'catalog' ? 'entry-kind' : 'entry-unverified'}>{item.game ? `${item.verification === 'needs_review' ? 'Zu prüfen · ' : ''}${kindName(item.game)}` : 'Manuell · ungeprüft'}</span></div></button></li>)}</ul>}
        <div className="list-footer">Deine Wunschliste bleibt nach einem Neustart erhalten.</div>
      </section>
      {selected ? <section className="game-detail" aria-labelledby="game-title"><Button secondary className="mobile-back" onClick={() => select(null)}>‹ Zur Wunschliste</Button>
        <div className="game-hero"><Cover src={selected.game?.cover_url ?? null} large /><div className="game-hero-copy"><p className="eyebrow">{selected.game ? 'DEIN WUNSCHSPIEL' : 'MANUELL VORGEMERKT'}</p><h2 id="game-title">{itemName(selected)}</h2><p className="game-meta">{platformName(selected.platform_id)} · {releaseYear(selected.game?.first_release_date ?? null)}</p><span className={`kind-badge ${selected.verification === 'catalog' ? '' : 'unverified'}`}>{selected.game ? `${selected.verification === 'needs_review' ? 'Zu prüfen · ' : ''}${kindName(selected.game)}` : 'Titel, Plattform und Edition ungeprüft'}</span><div className="game-actions"><Button secondary onClick={() => { setRemoveError(''); setRemoveItem(selected); }}>Aus Wunschliste entfernen</Button>{selected.game?.slug && <a className="source-link" href={`https://www.igdb.com/games/${selected.game.slug}`} target="_blank" rel="noopener noreferrer">Bei IGDB ansehen ↗</a>}</div></div></div>
        {selected.verification !== 'catalog' && <Notice>{selected.verification === 'needs_review' ? 'Die aktuellen Katalogdaten bestätigen die gewählte Plattform oder Produktart nicht mehr. Bitte die Zuordnung prüfen.' : 'Dieser Eintrag ist ungeprüft. Er ist kein Nachweis für ein passendes oder im Zielland aktivierbares Key-Angebot.'}</Notice>}
        <div className="game-detail-body"><section aria-labelledby="game-info-title"><h3 id="game-info-title">Spielinformationen</h3><p>{selected.game?.summary ?? 'Für diesen Titel liegt noch keine geprüfte Beschreibung vor.'}</p>{selected.game?.kind === 'edition' && <p className="metadata-note">IGDB führt diese Edition separat. Welche Inhalte ein Händlerprodukt enthält, muss am konkreten Angebot geprüft werden.</p>}{(selected.game?.aliases.length ?? 0) > 0 && <p className="metadata-note">Auch bekannt als: {selected.game?.aliases.join(' · ')}</p>}<p className="metadata-note">{selected.game ? 'Quelle: IGDB · Jahr der Erstveröffentlichung, nicht zwingend der Xbox-Version.' : 'Quelle: eigener Eintrag · Plattform vom Nutzer gewählt, nicht vom Katalog bestätigt.'}</p></section>
          <Offers key={selected.id} id={selected.id} csrf={csrf} targetLabel={targetLabel} onError={onError} />
        </div>
      </section> : <section className="empty-detail" aria-labelledby="empty-title"><div className="empty-orbit"><KeyMark /></div><p className="eyebrow">PLATZ FÜR DEINE FAVORITEN</p><h2 id="empty-title">{items.length ? 'Welches Spiel interessiert dich?' : <>Eine Liste.<br />Viele nächste Abenteuer.</>}</h2><p>{items.length ? 'Wähle links einen Titel oder suche nach deinem nächsten Wunschspiel.' : 'Suche ein Spiel, bestätige die Xbox-Version und speichere es dauerhaft in deiner Wunschliste.'}</p>{selectedId && !selected && !loading && <p>Der verlinkte Eintrag ist nicht mehr in deiner Liste.</p>}<Button onClick={() => setSearchOpen(true)} disabled={loading || !!listError || items.length >= 100}>Im Katalog suchen</Button></section>}
    </div>
    <div className="footnote"><span>Zielland: <strong>{targetLabel}</strong></span><span>Andere Angebotsländer bleiben sichtbar.</span></div>
    <CatalogSearch open={searchOpen} csrf={csrf} items={items} onClose={closeSearch} onAdded={added} onError={onError} />
    <dialog ref={removeDialog} aria-labelledby="remove-title" onCancel={event => { if (removing) event.preventDefault(); else setRemoveItem(null); }}><p className="eyebrow">WUNSCHLISTE VERWALTEN</p><h2 id="remove-title">Titel entfernen?</h2><p>„{removeItem ? itemName(removeItem) : ''}“ wird aus deiner Wunschliste entfernt.</p>{removeError && <Notice error>{removeError}</Notice>}<div className="dialog-actions"><Button secondary disabled={removing} onClick={() => setRemoveItem(null)}>Behalten</Button><Button disabled={removing} onClick={() => void remove()}>{removing ? 'Wird entfernt …' : 'Entfernen bestätigen'}</Button></div></dialog>
  </div>;
}
