import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { Brand, Button, Icon, IconButton, InfoDialog, Notice } from './components';
import FetchStatus from './FetchStatus';
import { mediaQuery } from './breakpoints';
import { useMediaQuery } from './useMediaQuery';
import { useSettingsAutosave } from './features/settings/autosave';
import { appVersion } from './version';

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
  const [wishlistRevision, setWishlistRevision] = useState(0);
  const [page, setPage] = useState<Page>(routePage);
  const [wishlistCount, setWishlistCount] = useState<number | null>(null);
  const [libraryCount, setLibraryCount] = useState<number | null>(null);
  const desktop = useMediaQuery(mediaQuery.desktop);
  const [sourceStatus, setSourceStatus] = useState<SourceStatuses | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);

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
  async function logout() {
    setBusy(true); setError('');
    try {
      await auto.settle(); // Never sign out with an unsaved edit.
      await api('/session', 'DELETE', undefined, csrf);
      setCsrf(''); setWishlistCount(null); setLibraryCount(null); setSearchOpen(false); setPage('wishlist'); setScreen('login');
      window.history.replaceState(null, '', window.location.pathname);
    } catch (e) { handleProtectedError(e); }
    finally { setBusy(false); }
  }
  const handleProtectedError = useCallback((e: unknown) => {
    setError(errorText(e));
    if (e instanceof HttpError && e.status === 401) { setCsrf(''); setWishlistCount(null); setSearchOpen(false); setScreen('login'); }
  }, []);
  const auto = useSettingsAutosave({ csrf, onSaved: refreshSources, onProtectedError: handleProtectedError });
  const savedCountry = auto.saved?.target_country ?? null;
  const savedPriceScope = auto.saved?.wishlist_price_scope ?? 'preferred';
  const navigate = useCallback((next: Page) => {
    const go = () => {
      setSearchOpen(false);
      setPage(next); setError('');
      const url = new URL(window.location.href);
      url.hash = '';
      if (next === 'settings') { url.searchParams.set('view', 'settings'); refreshSources(); }
      else if (next === 'alerts' || next === 'library') url.searchParams.set('view', next);
      else url.searchParams.delete('view');
      if (next !== 'settings') url.searchParams.delete('section');
      if (url.href !== window.location.href) window.history.pushState(null, '', url);
    };
    // Leaving the settings: save open edits first, so the next page already sees the new target country and price scope.
    if (page === 'settings' && next !== 'settings' && auto.dirty) void auto.settle().then(go); else go();
  }, [refreshSources, page, auto.dirty, auto.settle]);
  useEffect(() => { if (page !== 'settings') void auto.settle(); }, [page, auto.settle]); // Also covers browser back and forward.
  useEffect(() => {
    const restore = () => { setPage(routePage()); setSearchOpen(false); };
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
  useEffect(() => {
    function keyboard(event: KeyboardEvent) {
      if (document.querySelector('dialog[open]')) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        const input = document.getElementById('global-query');
        if (input) { event.preventDefault(); input.focus(); openSearch(); }
      }
    }
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  }, [openSearch]);
  const openSettings = useCallback(() => navigate('settings'), [navigate]);
  // The library count in the navigation: one cheap read after sign-in and whenever the wishlist or the page changes.
  useEffect(() => {
    if (screen !== 'ready' || page === 'library') return;
    const controller = new AbortController();
    api<unknown[]>('/library', 'GET', undefined, undefined, controller.signal)
      .then(rows => { if (!controller.signal.aborted) setLibraryCount(rows.length); })
      .catch(() => {});
    return () => controller.abort();
  }, [screen, page, wishlistCount]);

  const countryNames = useMemo(() => new Intl.DisplayNames(['de'], { type: 'region' }), []);
  const countries = useMemo(() => (auto.settings?.countries ?? []).map(code => ({ code, name: countryNames.of(code) ?? code })).sort((a, b) => a.name.localeCompare(b.name, 'de')), [auto.settings?.countries, countryNames]);
  const targetLabel = savedCountry ? countryNames.of(savedCountry) : 'Noch nicht gewählt';

  if (screen !== 'ready') return <main className="auth-layout">
    <div className="auth-card panel">
      <Brand />
      {screen === 'loading' ? <p role="status">KeyHunter wird geladen …</p> : screen === 'offline' ? <div><h1>Verbindung unterbrochen</h1><Notice error>{error}</Notice><Button onClick={() => void initialize()}>Erneut versuchen</Button></div> :
        <AuthForm setup={screen === 'setup'} busy={busy} error={error} onSubmit={signIn} />}
    </div>
  </main>;

  const navItems: { page: Page; label: string; icon: string; count?: number | null }[] = [
    { page: 'wishlist', label: 'Wunschliste', icon: 'heart', count: wishlistCount },
    { page: 'library', label: 'Bibliothek', icon: 'library', count: libraryCount },
    { page: 'alerts', label: 'Alarme', icon: 'bell' },
    { page: 'settings', label: 'Einstellungen', icon: 'settings' },
  ];
  return <div className={`app-shell ${page === 'wishlist' ? 'dashboard-page' : 'settings-page'}`}>
    <a href="#main-content" className="skip-link">Zum Inhalt</a>
    <aside className="sidebar">
      <a className="shell-brand" href={window.location.pathname} aria-label="KeyHunter, zur Wunschliste" onClick={event => { event.preventDefault(); navigate('wishlist'); }}><Brand /></a>
      <div className="shell-search"><CatalogSearch inline csrf={csrf} open={searchOpen} onOpen={openSearch} onClose={closeSearch} onAdded={selectSearchResult} onError={handleProtectedError} /></div>
      <nav className="main-nav" aria-label="Hauptnavigation">
        {navItems.map(item => <button key={item.page} className="nav-item" aria-current={page === item.page ? 'page' : undefined} onClick={() => navigate(item.page)}>
          <Icon name={item.icon} /><span className="label">{item.label}</span>{item.count !== undefined && <span className="count" aria-hidden="true">{item.count ?? '–'}</span>}
        </button>)}
      </nav>
      {desktop && <FetchStatus />}
      <button className="target-pill" aria-label="Zielland ändern" onClick={openSettings}><Icon name="globe" /><span className="target-key">Zielland</span>{' '}<span className="target-value">{savedCountry ? targetLabel : 'wählen'}</span></button>
      <div className="sidebar-foot">
        <small className="version ui-mono">{appVersion}</small>
        <IconButton variant="ghost" className="logout" label="Abmelden" onClick={() => void logout()} disabled={busy}><Icon name="logout" /></IconButton>
      </div>
    </aside>
    <div className="workspace">
      <main id="main-content" tabIndex={-1}>
        {error && <Notice error>{error}</Notice>}
        {page === 'wishlist' ? <Wishlist key={wishlistRevision} csrf={csrf} targetCountry={savedCountry} priceScope={savedPriceScope} targetLabel={targetLabel ?? 'Noch nicht gewählt'} onSettings={openSettings} onCountChange={setWishlistCount} onError={handleProtectedError} /> : page === 'library' ? <Library csrf={csrf} onRestored={selectSearchResult} onOpenWishlist={() => navigate('wishlist')} onCountChange={setLibraryCount} onError={handleProtectedError} /> : page === 'alerts' ? <PriceAlerts csrf={csrf} onError={handleProtectedError} /> : auto.settings && <SettingsPage settings={auto.settings} auto={auto} csrf={csrf} busy={busy} countries={countries} sourceStatus={sourceStatus}
          onSourcesChanged={refreshSources} onShopsChanged={saved => { auto.reset(saved); refreshSources(); }} onError={handleProtectedError} onHelp={() => setDialogOpen(true)} onLogout={() => void logout()} />}
      </main>
    </div>
    <InfoDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
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
      {setup && <div className="field"><label htmlFor="setup-token">Einrichtungscode</label><input id="setup-token" type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} required spellCheck={false} /><span className="field-help">Aus der lokalen Datei <code>bootstrap-token</code> im Datenverzeichnis.</span></div>}
      <div className="field"><label htmlFor="password">Passphrase</label><input id="password" type="password" autoComplete={setup ? 'new-password' : 'current-password'} value={password} onChange={e => setPassword(e.target.value)} required />{setup && <span className="field-help">12 bis 128 Zeichen, gerne mehrere Wörter.</span>}</div>
      {setup && <div className="field"><label htmlFor="password-confirm">Passphrase wiederholen</label><input id="password-confirm" type="password" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} required /></div>}
      {setup && <div className="field"><label htmlFor="setup-country">Zielland</label><select id="setup-country" value={country} onChange={e => setCountry(e.target.value)}>{countryOptions.map(c => <option key={c.code} value={c.code}>{c.name}</option>)}</select><span className="field-help">Für dieses Land werden Angebote als aktivierbar bewertet. Später in den Einstellungen änderbar.</span></div>}
      <Button type="submit" loading={busy}>{busy ? 'Bitte warten …' : setup ? 'Privaten Bereich einrichten' : 'Anmelden'}</Button>
    </form>
  </>;
}
