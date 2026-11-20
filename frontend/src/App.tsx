import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api, HttpError } from './api';
import type { Settings, SourceStatuses } from './api';
import Wishlist from './features/Wishlist';
import Library from './features/Library';
import CatalogSearch from './features/CatalogSearch';
import type { WishlistItem } from './api';
import PriceAlerts from './features/PriceAlerts';
import SettingsPage from './features/SettingsPage';
import { countryCodes } from './features/Country';
import { Brand, Button, Icon, IconButton, InfoDialog, Notice, Toast } from './components';
import type { IconName } from './components';
import FetchStatus from './FetchStatus';
import { mediaQuery } from './breakpoints';
import { useMediaQuery } from './useMediaQuery';
import { useSettingsAutosave } from './features/settings/autosave';
import { appVersion } from './version';
import { routeSection, sectionLabel, sections } from './features/settings/sections';
import type { Section } from './features/settings/sections';

type Page = 'wishlist' | 'settings' | 'alerts' | 'library';
function routePage(): Page {
  const view = new URL(window.location.href).searchParams.get('view');
  return view === 'settings' || view === 'alerts' || view === 'library' ? view : 'wishlist';
}

type Screen = 'loading' | 'setup' | 'login' | 'ready' | 'offline';
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Ein Fehler ist aufgetreten.';

export default function App() {
  const [screen, setScreen] = useState<Screen>('loading');
  const [csrf, setCsrf] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [wishlistRevision, setWishlistRevision] = useState(0);
  const [page, setPage] = useState<Page>(routePage);
  const [section, setSection] = useState<Section>(routeSection);
  const [gameTitle, setGameTitle] = useState<string | null>(null);
  const [wishlistCount, setWishlistCount] = useState<number | null>(null);
  const [libraryCount, setLibraryCount] = useState<number | null>(null);
  const [alertCount, setAlertCount] = useState<number | null>(null);
  const [toast, setToast] = useState('');
  const drawer = useMediaQuery(mediaQuery.drawer);
  const [sourceStatus, setSourceStatus] = useState<SourceStatuses | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const sidebar = useRef<HTMLElement>(null);

  const refreshSources = useCallback(() => {
    void api<SourceStatuses>('/sources/status').then(setSourceStatus).catch(() => setSourceStatus(null));
  }, []);

  async function loadSettings() {
    const data = await api<Settings>('/settings');
    auto.reset(data);
    refreshSources();
  }
  async function initialize() {
    setScreen('loading'); setError('');
    try {
      const status = await api<{ required: boolean }>('/setup');
      if (status.required) { setScreen('setup'); return; }
      try {
        const session = await api<{ csrf_token: string }>('/me');
        setCsrf(session.csrf_token); await loadSettings(); setScreen('ready');
      } catch (e) {
        if (e instanceof HttpError && e.status === 401) setScreen('login');
        else throw e;
      }
    } catch (e) { setError(errorText(e)); setScreen('offline'); }
  }
  useEffect(() => { void initialize(); }, []); // The initial request only reads local app state.

  async function signIn(password: string, token?: string, targetCountry?: string) {
    setBusy(true); setError('');
    try {
      const session = await api<{ csrf_token: string }>(token !== undefined ? '/setup' : '/session', 'POST', token !== undefined ? { token, password, target_country: targetCountry } : { password });
      setCsrf(session.csrf_token); await loadSettings(); setScreen('ready');
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }
  const resetSession = () => { setCsrf(''); setWishlistCount(null); setLibraryCount(null); setAlertCount(null); setSearchOpen(false); setAddOpen(false); setNavOpen(false); };
  async function logout() {
    setBusy(true); setError('');
    try {
      await auto.settle(); // Never sign out with an unsaved edit.
      await api('/session', 'DELETE', undefined, csrf);
      resetSession(); setPage('wishlist'); setScreen('login');
      window.history.replaceState(null, '', window.location.pathname);
    } catch (e) { handleProtectedError(e); }
    finally { setBusy(false); }
  }
  const handleProtectedError = useCallback((e: unknown) => {
    setError(errorText(e));
    if (e instanceof HttpError && e.status === 401) { setCsrf(''); setWishlistCount(null); setSearchOpen(false); setAddOpen(false); setScreen('login'); }
  }, []);
  const auto = useSettingsAutosave({ csrf, onSaved: refreshSources, onProtectedError: handleProtectedError });
  const savedCountry = auto.saved?.target_country ?? null;
  const savedPriceScope = auto.saved?.wishlist_price_scope ?? 'preferred';
  /** Go to a page (and settings section). `add` opens the wishlist's add dialog on arrival. */
  const navigate = useCallback((next: Page, nextSection: Section = 'general', add = false) => {
    const go = () => {
      setSearchOpen(false); setAddOpen(add); setNavOpen(false);
      setPage(next); setSection(nextSection); setError('');
      const url = new URL(window.location.href);
      url.hash = '';
      if (next === 'settings') {
        url.searchParams.set('view', 'settings'); refreshSources();
        if (nextSection === 'general') url.searchParams.delete('section'); else url.searchParams.set('section', nextSection);
        document.getElementById('main-content')?.scrollTo?.({ top: 0 });
      } else if (next === 'alerts' || next === 'library') url.searchParams.set('view', next);
      else url.searchParams.delete('view');
      if (next !== 'settings') url.searchParams.delete('section');
      if (url.href !== window.location.href) window.history.pushState(null, '', url);
    };
    // Leaving the settings: save open edits first, so the next page already sees the new target country and price scope.
    if (page === 'settings' && next !== 'settings' && auto.dirty) void auto.settle().then(go); else go();
  }, [refreshSources, page, auto.dirty, auto.settle]);
  useEffect(() => { if (page !== 'settings') void auto.settle(); }, [page, auto.settle]); // Also covers browser back and forward.
  useEffect(() => {
    const restore = () => { setPage(routePage()); setSection(routeSection()); setSearchOpen(false); setAddOpen(false); setNavOpen(false); };
    window.addEventListener('popstate', restore); return () => window.removeEventListener('popstate', restore);
  }, []);
  const openSearch = useCallback(() => setSearchOpen(true), []);
  const closeSearch = useCallback(() => setSearchOpen(false), []);
  const selectSearchResult = useCallback((item: WishlistItem) => {
    const url = new URL(window.location.href);
    url.hash = '';
    url.searchParams.delete('view'); url.searchParams.delete('section'); url.searchParams.delete('filter'); url.searchParams.set('item', item.id);
    if (url.href !== window.location.href) window.history.pushState(null, '', url);
    setPage('wishlist'); setError(''); setWishlistRevision(n => n + 1);
  }, []);
  /** "Spiel hinzufügen" in the top bar: the add dialog belongs to the wishlist, so open that page first. */
  function openAdd() {
    if (page !== 'wishlist') navigate('wishlist', 'general', true); else setAddOpen(true);
  }
  /** Breadcrumb "Wunschliste" in the game view: back to the list without a selection; URL-bound views follow through popstate. */
  function backToList() {
    const url = new URL(window.location.href);
    url.searchParams.delete('item'); url.searchParams.delete('tab'); url.hash = '';
    if (url.href !== window.location.href) { window.history.pushState(null, '', url); window.dispatchEvent(new PopStateEvent('popstate')); }
  }
  useEffect(() => {
    function keyboard(event: KeyboardEvent) {
      if (document.querySelector('dialog[open]')) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        const input = document.getElementById('global-query');
        if (input) { event.preventDefault(); setNavOpen(false); input.focus(); openSearch(); }
      }
    }
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  }, [openSearch]);
  // Drawer (up to 900 px): Escape closes it and returns focus to the menu button; opening moves focus into it.
  useEffect(() => {
    if (!navOpen) return;
    sidebar.current?.querySelector<HTMLElement>('.nav-item[aria-current="page"], .nav-item')?.focus();
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setNavOpen(false); menuButton.current?.focus(); } };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [navOpen]);
  useEffect(() => { if (!drawer) setNavOpen(false); }, [drawer]);
  const openSettings = useCallback((next: Section = 'general') => navigate('settings', next), [navigate]);
  // Counts in the navigation: one cheap read after sign-in and whenever the wishlist or the page changes.
  useEffect(() => {
    if (screen !== 'ready' || page === 'library') return;
    const controller = new AbortController();
    api<unknown[]>('/library', 'GET', undefined, undefined, controller.signal)
      .then(rows => { if (!controller.signal.aborted) setLibraryCount(rows.length); })
      .catch(() => {});
    return () => controller.abort();
  }, [screen, page, wishlistCount]);
  useEffect(() => {
    if (screen !== 'ready') return;
    const controller = new AbortController();
    api<{ rules: { enabled: boolean }[] }>('/alerts', 'GET', undefined, undefined, controller.signal)
      .then(data => { if (!controller.signal.aborted) setAlertCount(data.rules.filter(rule => rule.enabled).length); })
      .catch(() => {});
    return () => controller.abort();
  }, [screen, page, wishlistCount]);
  // Opened directly on another page (reload, link): read the wishlist size once for the navigation.
  useEffect(() => {
    if (screen !== 'ready' || page === 'wishlist' || wishlistCount !== null) return;
    const controller = new AbortController();
    api<unknown[]>('/wishlist', 'GET', undefined, undefined, controller.signal)
      .then(rows => { if (!controller.signal.aborted) setWishlistCount(rows.length); })
      .catch(() => {});
    return () => controller.abort();
  }, [screen, page, wishlistCount]);

  const countryNames = useMemo(() => new Intl.DisplayNames(['de'], { type: 'region' }), []);
  const countries = useMemo(() => (auto.settings?.countries ?? []).map(code => ({ code, name: countryNames.of(code) ?? code })).sort((a, b) => a.name.localeCompare(b.name, 'de')), [auto.settings?.countries, countryNames]);
  const targetLabel = savedCountry ? countryNames.of(savedCountry) : 'Noch nicht gewählt';
  const chosenCountry = auto.settings?.target_country ?? '';
  function changeCountry(code: string) {
    auto.edit(current => ({ ...current, target_country: code || null }));
    setToast(code ? `Zielland: ${countryNames.of(code) ?? code}` : 'Zielland entfernt');
  }
  const clearToast = useCallback(() => setToast(''), []);

  if (screen !== 'ready') return <main className="auth-layout">
    <div className="auth-card panel">
      <Brand />
      {screen === 'loading' ? <p role="status">KeyHunter wird geladen …</p> : screen === 'offline' ? <div><h1>Verbindung unterbrochen</h1><Notice error>{error}</Notice><Button variant="primary" onClick={() => void initialize()}>Erneut versuchen</Button></div> :
        <AuthForm setup={screen === 'setup'} busy={busy} error={error} onSubmit={signIn} />}
    </div>
  </main>;

  const overview: { page: Page; label: string; icon: IconName; count: number | null }[] = [
    { page: 'wishlist', label: 'Wunschliste', icon: 'heart', count: wishlistCount },
    { page: 'library', label: 'Bibliothek', icon: 'library', count: libraryCount },
    { page: 'alerts', label: 'Preisalarme', icon: 'bell', count: alertCount },
  ];
  const crumbs = page === 'wishlist' && gameTitle
    ? <><button type="button" onClick={backToList}>Wunschliste</button><Icon name="chev" size={14} /><span className="here" aria-current="page">{gameTitle}</span></>
    : page === 'settings' ? <><span>Einstellungen</span><Icon name="chev" size={14} /><span className="here" aria-current="page">{sectionLabel(section)}</span></>
      : <><span>KeyHunter</span><Icon name="chev" size={14} /><span className="here" aria-current="page">{overview.find(item => item.page === page)?.label}</span></>;
  return <div className={`app${navOpen ? ' nav-open' : ''}`}>
    <a href="#main-content" className="skip-link">Zum Inhalt</a>
    <aside className="side" id="app-sidebar" ref={sidebar} aria-label="Seitenleiste">
      <a className="brand-box" href={window.location.pathname} aria-label="KeyHunter, zur Wunschliste" title={`KeyHunter ${appVersion}`} onClick={event => { event.preventDefault(); navigate('wishlist'); }}><Brand /></a>
      <nav className="side-nav" aria-label="Hauptnavigation">
        <div className="nav-group" role="group" aria-labelledby="nav-overview"><span className="label" id="nav-overview">Übersicht</span>
          {overview.map(item => <button key={item.page} type="button" className="nav-item" aria-current={page === item.page ? 'page' : undefined} onClick={() => navigate(item.page)}>
            <Icon name={item.icon} />{item.label}<span className="count" aria-hidden="true">{item.count ?? '–'}</span>
          </button>)}
        </div>
        <div className="nav-group" role="group" aria-labelledby="nav-settings"><span className="label" id="nav-settings">Einstellungen</span>
          {sections.map(item => <button key={item.id} type="button" className="nav-item" aria-current={page === 'settings' && section === item.id ? 'page' : undefined} onClick={() => openSettings(item.id)}>
            <Icon name={item.icon} />{item.label}
          </button>)}
        </div>
      </nav>
      <div className="side-foot">
        <FetchStatus onOpen={() => openSettings('status')} />
        <label className="country"><span className="muted">Zielland</span>
          <select aria-label="Zielland" value={chosenCountry} onChange={event => changeCountry(event.target.value)}>
            {!chosenCountry && <option value="">Bitte wählen</option>}
            {countries.map(c => <option key={c.code} value={c.code}>{c.name}</option>)}
          </select></label>
        <button type="button" className="nav-item" onClick={() => void logout()} disabled={busy}><Icon name="logout" />Abmelden</button>
      </div>
    </aside>
    <div className="scrim" aria-hidden="true" onClick={() => setNavOpen(false)} />
    <div className="main">
      <header className="top">
        <IconButton ref={menuButton} className="menu-btn" label="Menü öffnen" aria-expanded={navOpen} aria-controls="app-sidebar" onClick={() => setNavOpen(true)}><Icon name="menu" /></IconButton>
        <nav className="crumbs" aria-label="Pfad">{crumbs}</nav>
        <div className="top-right">
          <CatalogSearch inline csrf={csrf} open={searchOpen} onOpen={openSearch} onClose={closeSearch} onAdded={selectSearchResult} onError={handleProtectedError} />
          <IconButton className="hide-sm" label="Preisalarme" onClick={() => navigate('alerts')}><Icon name="bell" /></IconButton>
          <Button variant="primary" className="hide-sm" onClick={openAdd}><Icon name="plus" />Spiel hinzufügen</Button>
        </div>
      </header>
      <main id="main-content" className={`content${page === 'wishlist' ? ' fill' : ''}`} tabIndex={-1}>
        {error && <Notice error>{error}</Notice>}
        {page === 'wishlist' ? <Wishlist key={wishlistRevision} csrf={csrf} targetCountry={savedCountry} priceScope={savedPriceScope} targetLabel={targetLabel ?? 'Noch nicht gewählt'} addOpen={addOpen} onAddOpen={setAddOpen} onTitle={setGameTitle} onSettings={() => openSettings()} onCountChange={setWishlistCount} onError={handleProtectedError} />
          : page === 'library' ? <Library csrf={csrf} onRestored={selectSearchResult} onOpenWishlist={() => navigate('wishlist')} onCountChange={setLibraryCount} onError={handleProtectedError} />
            : page === 'alerts' ? <PriceAlerts csrf={csrf} targetCountry={savedCountry} targetLabel={targetLabel ?? 'Zielland'} onError={handleProtectedError} />
              : auto.settings && <SettingsPage section={section} onSection={openSettings} settings={auto.settings} auto={auto} csrf={csrf} busy={busy} countries={countries} sourceStatus={sourceStatus}
                onSourcesChanged={refreshSources} onShopsChanged={saved => { auto.reset(saved); refreshSources(); }} onError={handleProtectedError} onHelp={() => setDialogOpen(true)} onLogout={() => void logout()} />}
      </main>
    </div>
    <InfoDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    <Toast message={toast} onDone={clearToast} />
  </div>;
}

function AuthForm({ setup, busy, error, onSubmit }: { setup: boolean; busy: boolean; error: string; onSubmit: (password: string, token?: string, targetCountry?: string) => Promise<void> }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [token, setToken] = useState('');
  const [country, setCountry] = useState(() => {
    const region = (navigator.language.split('-')[1] ?? '').toUpperCase();
    return countryCodes.includes(region) ? region : 'DE';
  });
  const countryOptions = useMemo(() => {
    const names = new Intl.DisplayNames(['de'], { type: 'region' });
    return countryCodes.map(code => ({ code, name: names.of(code) ?? code })).sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }, []);
  const [localError, setLocalError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); setLocalError('');
    const length = Array.from(password).length;
    if (length > 128 || (setup && length < 12)) {
      setLocalError(setup ? 'Die Passphrase muss 12 bis 128 Zeichen haben.' : 'Die Passphrase darf höchstens 128 Zeichen haben.');
      return;
    }
    if (setup && password !== confirm) { setLocalError('Die Passphrasen stimmen nicht überein.'); return; }
    await onSubmit(password, setup ? token : undefined, setup ? country : undefined);
  }
  return <>
    <h1>{setup ? 'KeyHunter einrichten' : 'Anmelden'}</h1>
    <form onSubmit={submit}>
      {(localError || error) && <Notice error>{localError || error}</Notice>}
      {setup && <div className="form-row"><label htmlFor="setup-token">Einrichtungscode</label><input id="setup-token" type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} required spellCheck={false} /><span className="field-help">Aus der lokalen Datei <code>bootstrap-token</code> im Datenverzeichnis.</span></div>}
      <div className="form-row"><label htmlFor="password">Passphrase</label><input id="password" type="password" autoComplete={setup ? 'new-password' : 'current-password'} value={password} onChange={e => setPassword(e.target.value)} required />{setup && <span className="field-help">12 bis 128 Zeichen, gerne mehrere Wörter.</span>}</div>
      {setup && <div className="form-row"><label htmlFor="password-confirm">Passphrase wiederholen</label><input id="password-confirm" type="password" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} required /></div>}
      {setup && <div className="form-row"><label htmlFor="setup-country">Zielland</label><select id="setup-country" value={country} onChange={e => setCountry(e.target.value)}>{countryOptions.map(c => <option key={c.code} value={c.code}>{c.name}</option>)}</select><span className="field-help">Für dieses Land werden Angebote als aktivierbar bewertet. Später in den Einstellungen änderbar.</span></div>}
      <Button variant="primary" type="submit" loading={busy}>{busy ? 'Bitte warten …' : setup ? 'Privaten Bereich einrichten' : 'Anmelden'}</Button>
    </form>
  </>;
}
