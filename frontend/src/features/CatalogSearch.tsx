import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api, HttpError, sessionEnded } from '../api';
import type { CatalogGame, WishlistItem } from '../api';
import { notifyError } from '../notify';
import { Button, ConfirmDialog, Cover, Field, Icon, IconButton, Notice } from '../components';
import { ALL_PLATFORMS, PLATFORMS, kindName, platformName, releaseYear, selectionAllowed } from './catalog-ui';

/**
 * Catalog search: inline in the top bar or as the add dialog. `target` decides where a pick goes: the wishlist
 * (default) or, in the library's dialog, straight into the library as owned (0.7.2).
 */
interface Props {
  open: boolean;
  inline?: boolean;
  target?: 'wishlist' | 'library';
  items?: WishlistItem[];
  onOpen?: () => void;
  onClose: () => void;
  onAdded: (item: WishlistItem, created: boolean) => void;
}
export default function CatalogSearch({ open, inline = false, target = 'wishlist', items, onOpen, onClose, onAdded }: Props) {
  const library = target === 'library';
  const dialog = useRef<HTMLDialogElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  // "Alle" by default (0.8.1): the search covers every Xbox system and each hit shows its system.
  const [platform, setPlatform] = useState(ALL_PLATFORMS);
  const [results, setResults] = useState<CatalogGame[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState('');
  const [addError, setAddError] = useState('');
  const [ownedWarning, setOwnedWarning] = useState<{ game: CatalogGame | null; message: string } | null>(null);
  /** Library: the picked game is on the wishlist and moves over only after confirmation. */
  const [wishedWarning, setWishedWarning] = useState<{ game: CatalogGame | null; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  /** The last pick, so a confirmation dialog repeats it with the same system. */
  const [pending, setPending] = useState<{ game: CatalogGame | null; system: number } | null>(null);
  /** System of a title saved without catalog hit while the filter is "Alle"; any supported Xbox system. */
  const [manualSystem, setManualSystem] = useState(PLATFORMS[0]);
  const [cached, setCached] = useState(false);
  const [savedItems, setSavedItems] = useState<WishlistItem[]>([]);
  const queryId = inline ? 'global-query' : 'catalog-query';
  const platformId = inline ? 'global-platform' : 'catalog-platform';

  useEffect(() => {
    if (inline) return;
    if (open) {
      dialog.current?.showModal();
      input.current?.focus();
    } else dialog.current?.close();
  }, [open, inline]);
  useEffect(() => {
    if (!inline || !open) return;
    const controller = new AbortController();
    void api<WishlistItem[]>('/wishlist', 'GET', undefined, controller.signal)
      .then(rows => {
        if (!controller.signal.aborted) setSavedItems(rows);
      })
      .catch(e => {
        if (!controller.signal.aborted) notifyError(e);
      });
    function outside(event: PointerEvent) {
      if (!busy && !ownedWarning && event.target instanceof Node && !container.current?.contains(event.target)) onClose();
    }
    document.addEventListener('pointerdown', outside);
    return () => {
      controller.abort();
      document.removeEventListener('pointerdown', outside);
    };
  }, [inline, open, busy, ownedWarning, onClose]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const text = query.trim();
    setResults([]);
    setError('');
    setAddError('');
    if (text.length < 2) {
      setState('idle');
      return () => controller.abort();
    }
    setState('loading');
    const timer = window.setTimeout(() => {
      void api<{ games: CatalogGame[]; cached: boolean }>(
        `/catalog/search?q=${encodeURIComponent(text)}&platform=${platform}`,
        'GET',
        undefined,
        controller.signal,
      )
        .then(data => {
          if (!controller.signal.aborted) {
            setResults(data.games);
            setCached(data.cached);
            setState('ready');
          }
        })
        .catch(e => {
          if (controller.signal.aborted) return;
          if (sessionEnded(e)) {
            onClose();
            return;
          }
          setError(e instanceof Error ? e.message : 'Katalogsuche fehlgeschlagen.');
          setState('error');
        });
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, platform, open, onClose]);

  /** The system a pick is for: the hit's own one, or for a title without catalog hit the filter (Series X|S under "Alle"). */
  async function add(game: CatalogGame | null, confirmed = false, system = platform === ALL_PLATFORMS ? manualSystem : platform) {
    if (busy) return;
    const saved = inline && game ? savedItems.find(item => item.game?.igdb_id === game.igdb_id && item.platform_id === system) : undefined;
    if (saved) {
      onAdded(saved, false);
      onClose();
      setQuery('');
      return;
    }
    setBusy(true);
    setAddError('');
    const pick = game ? { igdb_id: game.igdb_id, platform_id: system } : { manual_title: query.trim(), platform_id: system };
    setPending({ game, system });
    try {
      const result = await api<{ item: WishlistItem; created: boolean }>(
        library ? '/library' : '/wishlist',
        'POST',
        library ? { ...pick, confirm_wished: confirmed } : { ...pick, confirm_owned: confirmed },
      );
      setOwnedWarning(null);
      setWishedWarning(null);
      onAdded(result.item, result.created);
      onClose();
      setQuery('');
    } catch (e) {
      if (e instanceof HttpError && e.code === 'owned_game') setOwnedWarning({ game, message: e.message });
      else if (e instanceof HttpError && e.code === 'wished_game') setWishedWarning({ game, message: e.message });
      else if (sessionEnded(e)) onClose();
      else setAddError(e instanceof Error ? e.message : 'Speichern fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
  }

  // "Alle" plus the systems of the games already in the list (0.8.1): a system shows up once a game for it is added and
  // goes away with the last one.
  const known = new Set((items ?? savedItems).map(item => item.platform_id));
  const systems = PLATFORMS.filter(id => known.has(id) || id === platform);
  const platformSelect = (
    <select
      id={platformId}
      value={platform}
      onChange={event => setPlatform(Number(event.target.value))}
      disabled={busy}
      aria-label={inline ? 'Plattform wählen' : undefined}
    >
      <option value={ALL_PLATFORMS}>Alle</option>
      {systems.map(id => (
        <option key={id} value={id}>
          {platformName(id)}
        </option>
      ))}
    </select>
  );
  // Under "Alle" every hit once per Xbox system it is on, each with that system.
  const hits = results.flatMap(game =>
    (platform === ALL_PLATFORMS ? PLATFORMS.filter(id => game.platforms.some(p => p.id === id)) : [platform]).map(system => ({ game, system })),
  );
  const platformField = inline ? (
    <Field className="search-platform">
      <span className="muted">Plattform</span>
      {platformSelect}
    </Field>
  ) : (
    <div className="form-row">
      <label htmlFor={platformId}>Plattform wählen</label>
      {platformSelect}
    </div>
  );
  const searchInput = (
    <input
      ref={input}
      id={queryId}
      type={inline ? 'search' : 'text'}
      aria-label={inline ? 'Nach Spielen suchen' : undefined}
      aria-controls={inline && open ? 'global-results' : undefined}
      autoComplete="off"
      maxLength={100}
      placeholder={inline ? 'Spiele suchen …' : 'Titel oder IGDB-ID, z. B. Forza Horizon'}
      value={query}
      // RESP-20: the top search opens its popup on a click, from the first character or with Ctrl K, not on a Tab stop into the empty field.
      onFocus={inline && query.trim() ? onOpen : undefined}
      onClick={inline ? onOpen : undefined}
      onChange={event => {
        setQuery(event.target.value);
        if (inline && event.target.value.trim()) onOpen?.();
      }}
      disabled={busy}
    />
  );
  const resultsPanel = (
    <>
      <ConfirmDialog
        open={wishedWarning !== null}
        title="Steht auf der Wunschliste"
        confirmLabel="Als gekauft verschieben"
        busy={busy}
        onCancel={() => {
          setWishedWarning(null);
          setAddError('');
        }}
        onConfirm={() => void add(wishedWarning?.game ?? null, true, pending?.system)}
      >
        <p>{wishedWarning?.message}</p>
        <p>Der Eintrag wandert mit seinem Preisverlauf in die Bibliothek; Preisalarme dafür enden.</p>
        {addError && <Notice error>{addError}</Notice>}
      </ConfirmDialog>
      <ConfirmDialog
        open={ownedWarning !== null}
        title="Bereits in der Bibliothek"
        confirmLabel="Trotzdem vormerken"
        busy={busy}
        onCancel={() => {
          setOwnedWarning(null);
          setAddError('');
        }}
        onConfirm={() => void add(ownedWarning?.game ?? null, true, pending?.system)}
      >
        <p>{ownedWarning?.message}</p>
        <p>Die gleiche Edition wird in die Wunschliste zurückverschoben. Bei einer anderen Edition bleibt dein vorhandenes Spiel in der Bibliothek.</p>
        {addError && <Notice error>{addError}</Notice>}
      </ConfirmDialog>
      {addError && <Notice error>{addError}</Notice>}
      {state === 'idle' && <p className="search-hint">Mindestens zwei Zeichen eingeben. Quelle: IGDB.</p>}
      {state === 'loading' && (
        <p className="search-hint" role="status">
          Katalog wird durchsucht …
        </p>
      )}
      {state === 'error' && <Notice error>{error}</Notice>}
      {state === 'ready' && (
        <p className="search-hint" role="status">
          {results.length
            ? `${results.length === 20 ? 'Bis zu 20' : results.length} Treffer ${platform === ALL_PLATFORMS ? 'für alle Xbox-Systeme' : `für ${platformName(platform)}`}`
            : 'Keine passenden Katalogtreffer.'}
          {cached && results.length > 0 ? ' · aus dem Zwischenspeicher' : ''}
        </p>
      )}
      {hits.length > 0 && (
        <ul className="catalog-results" aria-label="Katalogtreffer">
          {hits.map(({ game, system }) => {
            const saved = (items ?? savedItems).some(item => item.game?.igdb_id === game.igdb_id && item.platform_id === system);
            const several = platform === ALL_PLATFORMS && hits.filter(hit => hit.game.igdb_id === game.igdb_id).length > 1;
            const label = several ? `${game.name} (${platformName(system)})` : game.name;
            return (
              <li className="catalog-result" key={`${game.igdb_id}-${system}`}>
                <Cover src={game.cover_url} title={game.name} />
                <div className="result-info">
                  <h3>{game.name}</h3>
                  <p>
                    <span title="Jahr der Erstveröffentlichung">{releaseYear(game.first_release_date)}</span> ·{' '}
                    <span className="result-system">{platformName(system)}</span>
                  </p>
                  <span className={`kind-badge ${selectionAllowed(game) ? '' : 'unverified'}`}>{kindName(game)}</span>
                  {game.kind === 'edition' && !library && <p className="edition-note">Edition separat erfasst · Händlerinhalt noch ungeprüft</p>}
                  {game.kind === 'bundle' && !library && <p className="edition-note">Bündel als ein Key · Inhalt beim Shop prüfen</p>}
                  {game.kind === 'dlc' && !library && <p className="edition-note">DLC · zählt mit DLC-Keys der Shops, das Hauptspiel ist nötig</p>}
                  {!selectionAllowed(game) && <p className="edition-note">Kein belegtes eigenständiges Spiel bzw. keine zuordenbare Edition.</p>}
                </div>
                <Button
                  size="sm"
                  disabled={busy || (saved && !inline) || !selectionAllowed(game)}
                  onClick={() => void add(game, false, system)}
                  aria-label={`${label} ${saved && inline ? 'öffnen' : library ? 'zur Bibliothek hinzufügen' : 'vormerken'}`}
                >
                  {busy ? '…' : saved ? (inline ? 'Öffnen' : library ? 'In der Bibliothek' : 'Vorgemerkt') : library ? 'Hinzufügen' : 'Vormerken'}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {/* The library also offers it next to hits (1.1.2): an owned game the catalog does not know may still bring similar names. */}
      {(state === 'error' || (state === 'ready' && (results.length === 0 || library))) && query.trim().length >= 2 && (
        <div className="manual-fallback">
          {platform === ALL_PLATFORMS && (
            <div className="form-row manual-system">
              <label htmlFor={`${platformId}-manual`}>System</label>
              <select id={`${platformId}-manual`} value={manualSystem} onChange={event => setManualSystem(Number(event.target.value))} disabled={busy}>
                {PLATFORMS.map(id => (
                  <option key={id} value={id}>
                    {platformName(id)}
                  </option>
                ))}
              </select>
            </div>
          )}
          {library ? (
            <>
              <h3>{results.length ? 'Nicht dabei? Manuell hinzufügen' : 'Manuell hinzufügen'}</h3>
              <p>„{query.trim()}“ wird ohne Katalogtreffer in der Bibliothek gespeichert.</p>
              <Button disabled={busy} onClick={() => void add(null)}>
                {busy ? 'Wird gespeichert …' : 'Ohne Katalog hinzufügen'}
              </Button>
            </>
          ) : (
            <>
              <h3>Manuell vormerken</h3>
              <p>„{query.trim()}“ wird manuell gespeichert. Plattform, Edition und Inhalte bleiben ungeprüft; daraus entstehen keine bestätigten Angebote.</p>
              <Button disabled={busy} onClick={() => void add(null)}>
                {busy ? 'Wird gespeichert …' : 'Ungeprüft vormerken'}
              </Button>
            </>
          )}
        </div>
      )}
      <div className="catalog-attribution">Spieledaten von IGDB · Erstveröffentlichung ist nicht zwingend das Xbox-Veröffentlichungsdatum.</div>
    </>
  );
  if (inline)
    return (
      <div
        className="search"
        ref={container}
        onKeyDown={event => {
          if (event.key === 'Escape' && !busy) {
            event.preventDefault();
            input.current?.focus();
            onClose();
          }
          if (event.key === 'ArrowDown' && event.target === input.current) {
            event.preventDefault();
            container.current?.querySelector<HTMLButtonElement>('.catalog-result button:not(:disabled)')?.focus();
          }
        }}
        onBlur={event => {
          if (!busy && !ownedWarning && event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) onClose();
        }}
      >
        <div className="search-box" role="search">
          <Icon name="search" size={15} />
          {searchInput}
          <span className="kbd" aria-hidden="true">
            Ctrl K
          </span>
        </div>
        {open && (
          <section className="search-pop" id="global-results" aria-label="Suchergebnisse">
            <div className="search-pop-head">
              <span className="label">Suche · IGDB</span>
              <span className="spacer" />
              {platformField}
              <IconButton variant="ghost" label="Suche schließen" disabled={busy} onClick={onClose}>
                <Icon name="x" />
              </IconButton>
            </div>
            {resultsPanel}
          </section>
        )}
      </div>
    );
  // The add dialog: a panel with the title in the head and search, platform and results in the inset.
  return (
    <dialog
      ref={dialog}
      className="catalog-dialog"
      aria-labelledby="catalog-title"
      onCancel={event => {
        if (busy) event.preventDefault();
        else onClose();
      }}
    >
      <div className="dialog-heading">
        <h2 id="catalog-title">{library ? 'Zur Bibliothek hinzufügen' : 'Spiel hinzufügen'}</h2>
        <IconButton variant="ghost" label="Suche schließen" onClick={onClose} disabled={busy}>
          <Icon name="x" />
        </IconButton>
      </div>
      <div className="inset catalog-body">
        <form className="catalog-form" onSubmit={submit}>
          <div className="form-row">
            <label htmlFor={queryId}>Spiel im Katalog suchen</label>
            <span className="field">
              <Icon name="search" size={14} />
              {searchInput}
            </span>
          </div>
          {platformField}
        </form>
        {resultsPanel}
      </div>
    </dialog>
  );
}
