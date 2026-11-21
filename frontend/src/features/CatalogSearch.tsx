import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api, HttpError } from '../api';
import type { CatalogGame, WishlistItem } from '../api';
import { Button, ConfirmDialog, Field, Icon, IconButton, Notice } from '../components';
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
  const [ownedWarning,setOwnedWarning]=useState<{game:CatalogGame|null;message:string}|null>(null);
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
      if (!busy && !ownedWarning && event.target instanceof Node && !container.current?.contains(event.target)) onClose();
    }
    document.addEventListener('pointerdown', outside);
    return () => { controller.abort(); document.removeEventListener('pointerdown', outside); };
  }, [inline, open, busy, ownedWarning, onClose, onError]);
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

  async function add(game: CatalogGame | null, confirmOwned=false) {
    if (busy) return;
    const saved = inline && game ? savedItems.find(item => item.game?.igdb_id === game.igdb_id && item.platform_id === platform) : undefined;
    if (saved) { onAdded(saved, false); onClose(); setQuery(''); return; }
    setBusy(true); setAddError('');
    try {
      const result = await api<{ item: WishlistItem; created: boolean }>('/wishlist', 'POST', game ? { igdb_id: game.igdb_id, platform_id: platform, confirm_owned:confirmOwned } : { manual_title: query.trim(), platform_id: platform, confirm_owned:confirmOwned }, csrf);
      setOwnedWarning(null); onAdded(result.item, result.created); onClose(); setQuery('');
    } catch (e) {
      if (e instanceof HttpError && e.code === 'owned_game') setOwnedWarning({game,message:e.message});
      else if (e instanceof HttpError && e.status === 401) { onError(e); onClose(); }
      else setAddError(e instanceof Error ? e.message : 'Speichern fehlgeschlagen.');
    } finally { setBusy(false); }
  }
  function submit(event: FormEvent) { event.preventDefault(); }

  const platformSelect = <select id={platformId} value={platform} onChange={event => setPlatform(Number(event.target.value))} disabled={busy} aria-label={inline ? 'Plattform wählen' : undefined}><option value={169}>Xbox Series X|S</option><option value={49}>Xbox One</option></select>;
  const platformField = inline ? <Field className="search-platform"><span className="muted">Plattform</span>{platformSelect}</Field>
    : <div className="form-row"><label htmlFor={platformId}>Plattform wählen</label>{platformSelect}</div>;
  const searchInput = <input ref={input} id={queryId} type={inline ? 'search' : 'text'} aria-label={inline ? 'Nach Spielen suchen' : undefined} aria-controls={inline && open ? 'global-results' : undefined} autoComplete="off" maxLength={100} placeholder={inline ? 'Spiele suchen …' : 'Titel oder IGDB-ID, z. B. Forza Horizon'} value={query} onFocus={inline ? onOpen : undefined} onChange={event => { setQuery(event.target.value); if (inline) onOpen?.(); }} disabled={busy} />;
  const resultsPanel = <>
    <ConfirmDialog open={ownedWarning!==null} title="Bereits in der Bibliothek" confirmLabel="Trotzdem vormerken" busy={busy} onCancel={()=>{setOwnedWarning(null);setAddError('');}} onConfirm={()=>void add(ownedWarning?.game??null,true)}>
      <p>{ownedWarning?.message}</p><p>Die gleiche Edition wird in die Wunschliste zurückverschoben. Bei einer anderen Edition bleibt dein vorhandenes Spiel in der Bibliothek.</p>{addError&&<Notice error>{addError}</Notice>}
    </ConfirmDialog>
    {addError && <Notice error>{addError}</Notice>}
    {state === 'idle' && <p className="search-hint">Mindestens zwei Zeichen eingeben. Quelle: IGDB.</p>}
    {state === 'loading' && <p className="search-hint" role="status">Katalog wird durchsucht …</p>}
    {state === 'error' && <Notice error>{error}</Notice>}
    {state === 'ready' && <p className="search-hint" role="status">{results.length ? `${results.length === 20 ? 'Bis zu 20' : results.length} Treffer für ${platformName(platform)}` : 'Keine passenden Katalogtreffer.'}{cached && results.length > 0 ? ' · aus dem Zwischenspeicher' : ''}</p>}
    {results.length > 0 && <ul className="catalog-results" aria-label="Katalogtreffer">{results.map(game => {
      const saved = (items ?? savedItems).some(item => item.game?.igdb_id === game.igdb_id && item.platform_id === platform);
      return <li className="catalog-result" key={game.igdb_id}><Cover src={game.cover_url} /><div className="result-info"><h3>{game.name}</h3><p><span title="Jahr der Erstveröffentlichung">{releaseYear(game.first_release_date)}</span> · {platformName(platform)}</p><span className={`kind-badge ${selectionAllowed(game) ? '' : 'unverified'}`}>{kindName(game)}</span>{game.kind === 'edition' && <p className="edition-note">Edition separat erfasst · Händlerinhalt noch ungeprüft</p>}{!selectionAllowed(game) && <p className="edition-note">Kein belegtes eigenständiges Spiel bzw. keine zuordenbare Edition.</p>}</div><Button size="sm" disabled={busy || (saved && !inline) || !selectionAllowed(game)} onClick={() => void add(game)} aria-label={`${game.name} ${saved && inline ? 'öffnen' : 'vormerken'}`}>{busy ? '…' : saved ? inline ? 'Öffnen' : 'Vorgemerkt' : 'Vormerken'}</Button></li>;
    })}</ul>}
    {(state === 'error' || (state === 'ready' && results.length === 0)) && query.trim().length >= 2 && <div className="manual-fallback"><h3>Manuell vormerken</h3><p>„{query.trim()}“ wird manuell gespeichert. Plattform, Edition und Inhalte bleiben ungeprüft; daraus entstehen keine bestätigten Angebote.</p><Button disabled={busy} onClick={() => void add(null)}>{busy ? 'Wird gespeichert …' : 'Ungeprüft vormerken'}</Button></div>}
    <div className="catalog-attribution">Spieledaten von IGDB · Erstveröffentlichung ist nicht zwingend das Xbox-Veröffentlichungsdatum.</div>
  </>;
  if (inline) return <div className="search" ref={container} onKeyDown={event => {
    if (event.key === 'Escape' && !busy) { event.preventDefault(); input.current?.focus(); onClose(); }
    if (event.key === 'ArrowDown' && event.target === input.current) { event.preventDefault(); container.current?.querySelector<HTMLButtonElement>('.catalog-result button:not(:disabled)')?.focus(); }
  }} onBlur={event => { if (!busy && !ownedWarning && event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) onClose(); }}>
    <div className="search-box" role="search"><Icon name="search" size={15} />{searchInput}<span className="kbd" aria-hidden="true">Ctrl K</span></div>
    {open && <section className="search-pop" id="global-results" aria-label="Suchergebnisse">
      <div className="search-pop-head"><span className="label">Spiele suchen · IGDB</span><span className="spacer" />{platformField}<IconButton variant="ghost" label="Suche schließen" disabled={busy} onClick={onClose}><Icon name="x" /></IconButton></div>
      {resultsPanel}
    </section>}
  </div>;
  // The add dialog: a panel with the title in the head and search, platform and results in the inset.
  return <dialog ref={dialog} className="catalog-dialog" aria-labelledby="catalog-title" onCancel={event => { if (busy) event.preventDefault(); else onClose(); }}>
    <div className="dialog-heading"><h2 id="catalog-title">Spiel hinzufügen</h2><IconButton variant="ghost" label="Suche schließen" onClick={onClose} disabled={busy}><Icon name="x" /></IconButton></div>
    <div className="inset catalog-body">
      <form className="catalog-form" onSubmit={submit}>
        <div className="form-row"><label htmlFor={queryId}>Spiel im Katalog suchen</label><span className="field"><Icon name="search" size={14} />{searchInput}</span></div>
        {platformField}
      </form>
      {resultsPanel}
    </div>
  </dialog>;
}
