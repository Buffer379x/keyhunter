import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { LibraryItem, WishlistItem } from '../api';
import { Button, ConfirmDialog, EmptyState, Icon, IconButton, Notice, Seg } from '../components';
import { Cover, itemName, platformName } from './catalog-ui';
import { libraryItems } from './library-sort';
import '../styles/library.css';

type Order = 'added' | 'name';
type Action = { kind: 'restore' | 'remove'; item: LibraryItem } | null;
const stored = (key: string, fallback: string) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
const store = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* Keep in memory. */ } };
const boughtOn = (seconds: number) => new Date(seconds * 1000).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
const games = (n: number) => `${n} ${n === 1 ? 'Spiel' : 'Spiele'}`;

interface Props {
  csrf: string;
  onRestored: (item: WishlistItem) => void;
  onOpenWishlist: () => void;
  onCountChange: (count: number) => void;
  onError: (error: unknown) => void;
}

export default function Library({ csrf, onRestored, onOpenWishlist, onCountChange, onError }: Props) {
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [reload, setReload] = useState(0);
  const [action, setAction] = useState<Action>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [system, setSystem] = useState(() => stored('keyhunter.library.system', 'all'));
  const [sort, setSort] = useState<Order>(() => stored('keyhunter.library.sort', 'added') === 'name' ? 'name' : 'added');
  const systems = [...new Set(items.map(item => item.platform_id))].sort((a, b) => platformName(a).localeCompare(platformName(b), 'de'));
  const activeSystem = system === 'all' || systems.some(id => String(id) === system) ? system : 'all';
  const visible = libraryItems(items, activeSystem, sort);
  const filter = (value: string) => { setSystem(value); store('keyhunter.library.system', value); };
  const order = (value: Order) => { setSort(value); store('keyhunter.library.sort', value); };

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
  return <section className="library-page" aria-labelledby="library-title">
    <header className="lib-head">
      <div>
        <h1 id="library-title">Meine Bibliothek</h1>
        <p>{loading ? 'Wird geladen …' : items.length === 0 ? 'Noch keine Spiele' : visible.length === items.length ? `${games(items.length)} als gekauft markiert` : `${visible.length} von ${games(items.length)}`}</p>
      </div>
      {items.length > 0 && <div className="lib-controls">
        <div className="form-row">
          <label htmlFor="library-system">System</label>
          <select id="library-system" aria-label="Bibliothek nach System filtern" value={activeSystem} onChange={event => filter(event.target.value)}>
            <option value="all">Alle Systeme</option>
            {systems.map(id => <option key={id} value={id}>{platformName(id)}</option>)}
          </select>
        </div>
        <div className="form-row">
          <span className="lib-label" id="library-sort-label">Sortieren</span>
          <Seg label="Bibliothek sortieren" value={sort} onChange={order}
            options={[{ value: 'added', label: 'Zuletzt gekauft' }, { value: 'name', label: 'A–Z' }]} />
        </div>
      </div>}
    </header>
    {loadError && <Notice error>{loadError}<Button size="sm" onClick={() => setReload(n => n + 1)}>Erneut laden</Button></Notice>}
    {loading && <>
      <p className="sr-only" role="status">Bibliothek wird geladen …</p>
      <ul className="lib-grid lib-skeleton" aria-hidden="true">{[0, 1, 2, 3, 4, 5].map(n => <li key={n}><span className="lib-ghost cover" /><span className="lib-ghost line" /><span className="lib-ghost line short" /></li>)}</ul>
    </>}
    {empty && <div className="lib-empty"><EmptyState icon="library" title="Noch keine Spiele in der Bibliothek"
      action={<Button onClick={onOpenWishlist}>Zur Wunschliste</Button>}>
      Spiele, die du auf der Wunschliste als gekauft markierst, erscheinen hier. Ihr Preisverlauf bleibt erhalten.</EmptyState></div>}
    {!loading && items.length > 0 && <ul className="lib-grid" aria-label="Meine Spiele">
      {visible.map(item => {
        const name = itemName(item);
        const edition = item.game?.edition_name;
        return <li key={item.id} className="lib-card">
          <Cover src={item.game?.cover_url ?? null} large />
          <div className="lib-info">
            <strong className="lib-title">{name}</strong>
            <span className="lib-meta">{platformName(item.platform_id)}{edition ? ` · ${edition}` : ''}</span>
            {item.acquired_at > 0 && <span className="lib-date label">Gekauft {boughtOn(item.acquired_at)}</span>}
          </div>
          <div className="lib-actions">
            <Button size="sm" aria-label={`${name} zurück in die Wunschliste`} onClick={() => ask('restore', item)}>In Wunschliste</Button>
            <IconButton variant="ghost" label={`${name} aus der Bibliothek entfernen`} onClick={() => ask('remove', item)}><Icon name="x" size={16} /></IconButton>
          </div>
        </li>;
      })}
    </ul>}
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
