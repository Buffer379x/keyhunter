import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api, HttpError } from '../api';
import type { CatalogGame, WishlistItem } from '../api';
import { Button, Icon, Notice } from '../components';
import { Cover, kindName, platformName, releaseYear, selectionAllowed } from './catalog-ui';

interface Props { csrf: string; open: boolean; inline?: boolean; items?: WishlistItem[]; onOpen?: () => void; onClose: () => void; onAdded: (item: WishlistItem, created: boolean) => void; onError: (error: unknown) => void }
export default function CatalogSearch({ csrf, open, inline = false, items, onOpen, onClose, onAdded, onError }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [platform, setPlatform] = useState(169);
  const [results, setResults] = useState<CatalogGame[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState('');
  const [addError, setAddError] = useState('');
  const [busy, setBusy] = useState(false);
  const [cached, setCached] = useState(false);
  const [savedItems, setSavedItems] = useState<WishlistItem[]>([]);
  const queryId = inline ? 'global-query' : 'catalog-query';
  const platformId = inline ? 'global-platform' : 'catalog-platform';

  useEffect(() => {
    if (inline) return;
    if (open) { dialog.current?.showModal(); input.current?.focus(); }
    else dialog.current?.close();
  }, [open, inline]);
  useEffect(() => {
    if (!inline || !open) return;
    const controller = new AbortController();
    void api<WishlistItem[]>('/wishlist', 'GET', undefined, undefined, controller.signal)
      .then(rows => { if (!controller.signal.aborted) setSavedItems(rows); })
      .catch(e => { if (!controller.signal.aborted) onError(e); });
    function outside(event: PointerEvent) {
      if (!busy && event.target instanceof Node && !container.current?.contains(event.target)) onClose();
    }
    document.addEventListener('pointerdown', outside);
    return () => { controller.abort(); document.removeEventListener('pointerdown', outside); };
  }, [inline, open, busy, onClose, onError]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const text = query.trim();
    setResults([]); setError(''); setAddError('');
    if (text.length < 2) { setState('idle'); return () => controller.abort(); }
    setState('loading');
    const timer = window.setTimeout(() => {
      void api<{ games: CatalogGame[]; cached: boolean }>(`/catalog/search?q=${encodeURIComponent(text)}&platform=${platform}`, 'GET', undefined, undefined, controller.signal)
        .then(data => { if (!controller.signal.aborted) { setResults(data.games); setCached(data.cached); setState('ready'); } })
        .catch(e => {
          if (controller.signal.aborted) return;
          if (e instanceof HttpError && e.status === 401) { onError(e); onClose(); return; }
          setError(e instanceof Error ? e.message : 'Katalogsuche fehlgeschlagen.'); setState('error');
        });
    }, 350);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, platform, open, onError, onClose]);

  async function add(game: CatalogGame | null) {
    if (busy) return;
    const saved = inline && game ? savedItems.find(item => item.game?.igdb_id === game.igdb_id && item.platform_id === platform) : undefined;
    if (saved) { onAdded(saved, false); onClose(); setQuery(''); return; }
    setBusy(true); setAddError('');
    try {
      const result = await api<{ item: WishlistItem; created: boolean }>('/wishlist', 'POST', game ? { igdb_id: game.igdb_id, platform_id: platform } : { manual_title: query.trim(), platform_id: platform }, csrf);
      onAdded(result.item, result.created); onClose(); setQuery('');
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) { onError(e); onClose(); }
      else setAddError(e instanceof Error ? e.message : 'Speichern fehlgeschlagen.');
    } finally { setBusy(false); }
  }
  function submit(event: FormEvent) { event.preventDefault(); }

  const platformField = <div className="field"><label htmlFor={platformId}>Plattform wählen</label><select id={platformId} value={platform} onChange={event => setPlatform(Number(event.target.value))} disabled={busy}><option value={169}>Xbox Series X|S</option><option value={49}>Xbox One</option></select></div>;
  const searchInput = <input ref={input} id={queryId} type={inline ? 'search' : 'text'} aria-label={inline ? 'Nach Spielen suchen' : undefined} aria-controls={inline && open ? 'global-results' : undefined} aria-expanded={inline ? open : undefined} autoComplete="off" maxLength={100} placeholder={inline ? 'Nach Spielen suchen …' : 'Zum Beispiel Forza Horizon …'} value={query} onFocus={inline ? onOpen : undefined} onChange={event => { setQuery(event.target.value); if (inline) onOpen?.(); }} disabled={busy} />;
  const resultsPanel = <>
    {addError && <Notice error>{addError}</Notice>}
    {state === 'idle' && <p className="search-hint">Mindestens zwei Zeichen eingeben. Quelle: IGDB.</p>}
    {state === 'loading' && <p className="search-hint" role="status">Katalog wird durchsucht …</p>}
    {state === 'error' && <Notice error>{error}</Notice>}
    {state === 'ready' && <p className="search-hint" role="status">{results.length ? `${results.length === 20 ? 'Bis zu 20' : results.length} Treffer für ${platformName(platform)}` : 'Keine passenden Katalogtreffer.'}{cached && results.length > 0 ? ' · aus dem Zwischenspeicher' : ''}</p>}
    {results.length > 0 && <ul className="catalog-results" aria-label="Katalogtreffer">{results.map(game => {
      const saved = (items ?? savedItems).some(item => item.game?.igdb_id === game.igdb_id && item.platform_id === platform);
      return <li className="catalog-result" key={game.igdb_id}><Cover src={game.cover_url} /><div className="result-info"><h3>{game.name}</h3><p><span title="Jahr der Erstveröffentlichung">{releaseYear(game.first_release_date)}</span> · {platformName(platform)}</p><span className={`kind-badge ${selectionAllowed(game) ? '' : 'unverified'}`}>{kindName(game)}</span>{game.kind === 'edition' && <p className="edition-note">Edition separat erfasst · Händlerinhalt noch ungeprüft</p>}{!selectionAllowed(game) && <p className="edition-note">Kein belegtes eigenständiges Spiel bzw. keine zuordenbare Edition.</p>}</div><Button secondary disabled={busy || (saved && !inline) || !selectionAllowed(game)} onClick={() => void add(game)} aria-label={`${game.name} ${saved && inline ? 'öffnen' : 'vormerken'}`}>{busy ? '…' : saved ? inline ? 'Öffnen' : 'Vorgemerkt' : 'Vormerken'}</Button></li>;
    })}</ul>}
    {(state === 'error' || (state === 'ready' && results.length === 0)) && query.trim().length >= 2 && <div className="manual-fallback"><h3>Titel trotzdem vormerken?</h3><p>„{query.trim()}“ wird manuell gespeichert. Plattform, Edition und Inhalte bleiben ungeprüft; daraus entstehen keine bestätigten Angebote.</p><Button secondary disabled={busy} onClick={() => void add(null)}>{busy ? 'Wird gespeichert …' : 'Ungeprüft vormerken'}</Button></div>}
    <div className="catalog-attribution">Spieledaten von IGDB · Erstveröffentlichung ist nicht zwingend das Xbox-Veröffentlichungsdatum.</div>
  </>;
  if (inline) return <div className="global-search-wrap" ref={container} onKeyDown={event => {
    if (event.key === 'Escape' && !busy) { event.preventDefault(); input.current?.focus(); onClose(); }
    if (event.key === 'ArrowDown' && event.target === input.current) { event.preventDefault(); container.current?.querySelector<HTMLButtonElement>('.catalog-result button:not(:disabled)')?.focus(); }
  }} onBlur={event => { if (!busy && event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) onClose(); }}>
    <div className="global-search" role="search"><Icon name="search" />{searchInput}<kbd>Ctrl K</kbd></div>
    {open && <section className="global-results" id="global-results" aria-label="Suchergebnisse"><div className="inline-search-heading"><span>Spiele suchen · IGDB</span><button className="icon-action" type="button" aria-label="Suche schließen" disabled={busy} onClick={onClose}><Icon name="close" /></button></div>{platformField}{resultsPanel}</section>}
  </div>;
  return <dialog ref={dialog} className="catalog-dialog" aria-labelledby="catalog-title" onCancel={event => { if (busy) event.preventDefault(); else onClose(); }}>
    <div className="dialog-heading"><div><p className="eyebrow">DEIN NÄCHSTES SPIEL</p><h2 id="catalog-title">Spiel hinzufügen</h2></div><Button secondary type="button" aria-label="Suche schließen" onClick={onClose} disabled={busy}>×</Button></div>
    <p>Suche im IGDB-Katalog und bestätige Titel, Edition und Xbox-Plattform.</p>
    <form className="catalog-form" onSubmit={submit}><div className="field"><label htmlFor={queryId}>Spiel im Katalog suchen</label>{searchInput}</div>{platformField}</form>{resultsPanel}
  </dialog>;
}
