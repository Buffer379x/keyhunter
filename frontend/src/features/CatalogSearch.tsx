import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api, HttpError } from '../api';
import type { CatalogGame, WishlistItem } from '../api';
import { Button, Notice } from '../components';
import { Cover, kindName, platformName, releaseYear, selectionAllowed } from './catalog-ui';

interface Props { csrf: string; open: boolean; items: WishlistItem[]; onClose: () => void; onAdded: (item: WishlistItem, created: boolean) => void; onError: (error: unknown) => void }
export default function CatalogSearch({ csrf, open, items, onClose, onAdded, onError }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [platform, setPlatform] = useState(169);
  const [results, setResults] = useState<CatalogGame[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState('');
  const [addError, setAddError] = useState('');
  const [busy, setBusy] = useState(false);
  const [cached, setCached] = useState(false);

  useEffect(() => {
    if (open) { dialog.current?.showModal(); input.current?.focus(); }
    else dialog.current?.close();
  }, [open]);
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

  return <dialog ref={dialog} className="catalog-dialog" aria-labelledby="catalog-title" onCancel={event => { if (busy) event.preventDefault(); else onClose(); }}>
    <div className="dialog-heading"><div><p className="eyebrow">DEIN NÄCHSTES SPIEL</p><h2 id="catalog-title">Spiel hinzufügen</h2></div><Button secondary type="button" aria-label="Suche schließen" onClick={onClose} disabled={busy}>×</Button></div>
    <p>Suche im IGDB-Katalog und bestätige Titel, Edition und Xbox-Plattform.</p>
    <form className="catalog-form" onSubmit={submit}><div className="field"><label htmlFor="catalog-query">Spiel im Katalog suchen</label><input ref={input} id="catalog-query" autoComplete="off" maxLength={100} placeholder="Zum Beispiel Forza Horizon …" value={query} onChange={event => setQuery(event.target.value)} disabled={busy} /></div><div className="field"><label htmlFor="catalog-platform">Plattform wählen</label><select id="catalog-platform" value={platform} onChange={event => setPlatform(Number(event.target.value))} disabled={busy}><option value={169}>Xbox Series X|S</option><option value={49}>Xbox One</option></select></div></form>
    {addError && <Notice error>{addError}</Notice>}
    {state === 'idle' && <p className="search-hint">Mindestens zwei Zeichen eingeben. Quelle: IGDB.</p>}
    {state === 'loading' && <p className="search-hint" role="status">Katalog wird durchsucht …</p>}
    {state === 'error' && <Notice error>{error}</Notice>}
    {state === 'ready' && <p className="search-hint" role="status">{results.length ? `${results.length === 20 ? 'Bis zu 20' : results.length} Treffer für ${platformName(platform)}` : 'Keine passenden Katalogtreffer.'}{cached && results.length > 0 ? ' · aus dem Zwischenspeicher' : ''}</p>}
    {results.length > 0 && <ul className="catalog-results" aria-label="Katalogtreffer">{results.map(game => {
      const saved = items.some(item => item.game?.igdb_id === game.igdb_id && item.platform_id === platform);
      return <li className="catalog-result" key={game.igdb_id}><Cover src={game.cover_url} /><div className="result-info"><h3>{game.name}</h3><p><span title="Jahr der Erstveröffentlichung">{releaseYear(game.first_release_date)}</span> · {platformName(platform)}</p><span className={`kind-badge ${selectionAllowed(game) ? '' : 'unverified'}`}>{kindName(game)}</span>{game.kind === 'edition' && <p className="edition-note">Edition separat erfasst · Händlerinhalt noch ungeprüft</p>}{!selectionAllowed(game) && <p className="edition-note">Kein belegtes eigenständiges Spiel bzw. keine zuordenbare Edition.</p>}</div><Button secondary disabled={busy || saved || !selectionAllowed(game)} onClick={() => void add(game)} aria-label={`${game.name} vormerken`}>{saved ? 'Vorgemerkt' : busy ? '…' : 'Vormerken'}</Button></li>;
    })}</ul>}
    {(state === 'error' || (state === 'ready' && results.length === 0)) && query.trim().length >= 2 && <div className="manual-fallback"><h3>Titel trotzdem vormerken?</h3><p>„{query.trim()}“ wird manuell gespeichert. Plattform, Edition und Inhalte bleiben ungeprüft; daraus entstehen keine bestätigten Angebote.</p><Button secondary disabled={busy} onClick={() => void add(null)}>{busy ? 'Wird gespeichert …' : 'Ungeprüft vormerken'}</Button></div>}
    <div className="catalog-attribution">Spieledaten von IGDB · Erstveröffentlichung ist nicht zwingend das Xbox-Veröffentlichungsdatum.</div>
  </dialog>;
}
