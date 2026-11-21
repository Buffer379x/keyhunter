import { useCallback, useEffect, useState } from 'react';
import { api, CART_CHANGED } from '../api';
import type { LibraryItem, WishlistItem } from '../api';
import { Button, ConfirmDialog, EmptyState, Icon, IconButton, Notice, PageHeading, Panel, Seg } from '../components';
import { Cover, itemName, platformName } from './catalog-ui';
import CatalogSearch from './CatalogSearch';
import { libraryItems } from './library-sort';
import '../styles/library.css';

type Order = 'added' | 'name';
type View = 'tiles' | 'rows';
type Action = { kind: 'restore' | 'remove'; item: LibraryItem } | null;
const stored = (key: string, fallback: string) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
const store = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* Keep in memory. */ } };
const SORT_KEY = 'keyhunter.library.order';
const VIEW_KEY = 'keyhunter.library.view';
const bought = (seconds: number) => new Date(seconds * 1000).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
const games = (n: number) => `${n} ${n === 1 ? 'Spiel' : 'Spiele'}`;

interface Props {
  csrf: string;
  /** The add dialog of the library (top bar "Spiel hinzufügen" on this page): picks go straight in as owned. */
  addOpen: boolean;
  onAddOpen: (open: boolean) => void;
  onRestored: (item: WishlistItem) => void;
  onOpenWishlist: () => void;
  onCountChange: (count: number) => void;
  onError: (error: unknown) => void;
}

export default function Library({ csrf, addOpen, onAddOpen, onRestored, onOpenWishlist, onCountChange, onError }: Props) {
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [reload, setReload] = useState(0);
  const [action, setAction] = useState<Action>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** The cover buttons (restore, delete) only show after the lock in the page head is opened; every visit starts locked. */
  const [unlocked, setUnlocked] = useState(false);
  const [system, setSystem] = useState(() => stored('keyhunter.library.system', 'all'));
  // A–Z is the default (0.6.5); a new key, so the earlier default "Zuletzt gekauft" does not stick.
  const [sort, setSort] = useState<Order>(() => stored(SORT_KEY, 'name') === 'added' ? 'added' : 'name');
  const [view, setView] = useState<View>(() => stored(VIEW_KEY, 'tiles') === 'rows' ? 'rows' : 'tiles');
  const [message, setMessage] = useState('');
  const systems = [...new Set(items.map(item => item.platform_id))].sort((a, b) => platformName(a).localeCompare(platformName(b), 'de'));
  const activeSystem = system === 'all' || systems.some(id => String(id) === system) ? system : 'all';
  const visible = libraryItems(items, activeSystem, sort);
  const filter = (value: string) => { setSystem(value); store('keyhunter.library.system', value); };
  const order = (value: Order) => { setSort(value); store(SORT_KEY, value); };
  const show = (value: View) => { setView(value); store(VIEW_KEY, value); };
  const closeAdd = useCallback(() => onAddOpen(false), [onAddOpen]);
  function added(item: WishlistItem, created: boolean) {
    const entry = item as LibraryItem;
    // A wish moved over as bought leaves the cart (0.8.0).
    window.dispatchEvent(new Event(CART_CHANGED));
    if (created) {
      const rows = [entry, ...items.filter(row => row.id !== entry.id)];
      setItems(rows); onCountChange(rows.length);
    }
    if (activeSystem !== 'all' && activeSystem !== String(entry.platform_id)) filter('all');
    setMessage(created ? `${itemName(entry)} ist jetzt in der Bibliothek.` : `${itemName(entry)} ist bereits in der Bibliothek.`);
  }

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setLoadError('');
    api<LibraryItem[]>('/library', 'GET', undefined, undefined, controller.signal)
      .then(rows => { if (!controller.signal.aborted) { setItems(rows); onCountChange(rows.length); } })
      .catch(e => { if (!controller.signal.aborted) { setLoadError(e instanceof Error ? e.message : 'Bibliothek konnte nicht geladen werden.'); onError(e); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [onError, onCountChange, reload]);

  const ask = useCallback((kind: 'restore' | 'remove', item: LibraryItem) => { setError(''); setAction({ kind, item }); }, []);
  async function confirm() {
    if (!action || busy) return;
    setMessage('');
    const { kind, item } = action;
    setBusy(true); setError('');
    try {
      if (kind === 'restore') {
        await api(`/library/${item.id}/restore`, 'POST', { confirm: true }, csrf);
        setAction(null); onRestored(item);
      } else {
        await api(`/wishlist/${encodeURIComponent(item.id)}`, 'DELETE', undefined, csrf);
        const rows = items.filter(row => row.id !== item.id);
        setItems(rows); onCountChange(rows.length); setAction(null);
      }
    } catch (e) { setError(e instanceof Error ? e.message : kind === 'restore' ? 'Verschieben fehlgeschlagen.' : 'Entfernen fehlgeschlagen.'); onError(e); }
    finally { setBusy(false); }
  }

  const empty = !loading && !loadError && items.length === 0;
  const sub = loading ? 'Wird geladen …' : items.length === 0 ? 'Noch keine Spiele · gekaufte Spiele werden nicht mehr abgefragt'
    : visible.length === items.length ? `${games(items.length)} gekauft · werden nicht mehr abgefragt` : `${visible.length} von ${games(items.length)}`;
  return <section className="page library-page" aria-labelledby="library-title">
    <PageHeading id="library-title" title="Bibliothek" sub={sub} actions={<>
      <IconButton className="lib-add" label="Spiel zur Bibliothek hinzufügen" onClick={() => onAddOpen(true)}><Icon name="plus" /></IconButton>
      {items.length > 0 && <>
      <select className="lib-system" aria-label="Bibliothek nach System filtern" value={activeSystem} onChange={event => filter(event.target.value)}>
        <option value="all">Alle Systeme</option>
        {systems.map(id => <option key={id} value={id}>{platformName(id)}</option>)}
      </select>
      <Seg label="Bibliothek sortieren" value={sort} onChange={order}
        options={[{ value: 'name', label: 'A–Z' }, { value: 'added', label: 'Zuletzt gekauft' }]} />
      <div className="seg lib-view" role="group" aria-label="Ansicht">
        <button type="button" aria-pressed={view === 'tiles'} aria-label="Kacheln" title="Kacheln" onClick={() => show('tiles')}><Icon name="tiles" size={15} /></button>
        <button type="button" aria-pressed={view === 'rows'} aria-label="Liste" title="Liste" onClick={() => show('rows')}><Icon name="rows" size={15} /></button>
      </div>
      <IconButton className={`lib-lock${unlocked ? ' open' : ''}`} aria-pressed={unlocked} onClick={() => setUnlocked(open => !open)}
        label={unlocked ? 'Bearbeiten sperren' : 'Bearbeiten entsperren'}><Icon name={unlocked ? 'unlock' : 'lock'} /></IconButton>
      </>}
    </>} />
    {message && <Notice>{message}</Notice>}
    {loadError && <Notice error>{loadError}<Button size="sm" onClick={() => setReload(n => n + 1)}>Erneut laden</Button></Notice>}
    {loading && <>
      <p className="sr-only" role="status">Bibliothek wird geladen …</p>
      <ul className={`lib lib-skeleton${view === 'rows' ? ' rows' : ''}`} aria-hidden="true">{[0, 1, 2, 3, 4, 5].map(n => <li key={n} className="lib-item"><span className="lib-ghost cover" /><span className="lib-ghost line" /></li>)}</ul>
    </>}
    {empty && <Panel><EmptyState icon="library" title="Noch keine Spiele in der Bibliothek"
      action={<div className="lib-empty-actions"><Button variant="primary" onClick={() => onAddOpen(true)}><Icon name="plus" />Spiel hinzufügen</Button><Button onClick={onOpenWishlist}>Zur Wunschliste</Button></div>}>
      Füge gekaufte Spiele direkt hinzu, oder markiere sie auf der Wunschliste als gekauft; dann bleibt ihr Preisverlauf erhalten.</EmptyState></Panel>}
    {!loading && items.length > 0 && <ul className={`lib${view === 'rows' ? ' rows' : ''}`} aria-label="Meine Spiele">
      {visible.map(item => {
        const name = itemName(item);
        return <li key={item.id} className="lib-item">
          <div className="lib-cover">
            <Cover src={item.game?.cover_url ?? null} title={name} large />
            {unlocked && <div className="lib-tools">
              <IconButton label={`${name} zurück in die Wunschliste`} onClick={() => ask('restore', item)}><Icon name="undo" /></IconButton>
              <IconButton variant="danger" label={`${name} aus der Bibliothek entfernen`} onClick={() => ask('remove', item)}><Icon name="trash" /></IconButton>
            </div>}
          </div>
          <div className="lib-info">
            <b title={name}>{name}</b>
            {view === 'rows' && <span className="lib-sub">{platformName(item.platform_id)}{item.acquired_at > 0 && ` · gekauft am ${bought(item.acquired_at)}`}</span>}
          </div>
        </li>;
      })}
    </ul>}
    <CatalogSearch target="library" open={addOpen} csrf={csrf} items={items} onClose={closeAdd} onAdded={added} onError={onError} />
    <ConfirmDialog open={action !== null} busy={busy} onCancel={() => setAction(null)} onConfirm={() => void confirm()}
      title={action?.kind === 'remove' ? 'Aus der Bibliothek entfernen?' : 'Zurück in die Wunschliste?'}
      confirmLabel={action?.kind === 'remove' ? 'Entfernen bestätigen' : 'In Wunschliste verschieben'} danger={action?.kind === 'remove'}>
      {action?.kind === 'remove'
        ? <p>„{itemName(action.item)}“ wird dauerhaft aus der Bibliothek entfernt. Das lässt sich nicht rückgängig machen.</p>
        : <p>„{action ? itemName(action.item) : ''}“ wird aus der Bibliothek wieder in die Wunschliste verschoben. Der gespeicherte Preisverlauf bleibt erhalten.</p>}
      {error && <Notice error>{error}</Notice>}
    </ConfirmDialog>
  </section>;
}
