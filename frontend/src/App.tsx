import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { api, HttpError } from './api';
import type { Settings, SourceStatuses } from './api';
import Wishlist from './features/Wishlist';
import CatalogSearch from './features/CatalogSearch';
import type { WishlistItem } from './api';
import PriceAlerts from './features/PriceAlerts';
import SettingsPage from './features/SettingsPage';
import { shopNames } from './features/Offers';
import { Brand, Button, Icon, InfoDialog, Notice } from './components';
import { formatFeePercent, parseFeePercent } from './fees';

type Page = 'wishlist' | 'settings' | 'alerts';
function routePage(): Page {
  const view = new URL(window.location.href).searchParams.get('view');
  return view === 'settings' || view === 'alerts' ? view : 'wishlist';
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
  const [sourceStatus, setSourceStatus] = useState<SourceStatuses | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [savedCountry, setSavedCountry] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [feeDraft, setFeeDraft] = useState<Record<string, string>>({});

  const refreshSources = useCallback(() => {
    void api<SourceStatuses>('/sources/status').then(setSourceStatus).catch(() => setSourceStatus(null));
  }, []);

  async function loadSettings() {
    const data = await api<Settings>('/settings');
    setSettings(data);
    refreshSources();
    setSavedCountry(data.target_country);
    setFeeDraft(Object.fromEntries(data.sources.map(source => [source.id, formatFeePercent(source.fee_basis_points)])));
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

  async function signIn(password: string, token?: string) {
    setBusy(true); setError('');
    try {
      const session = await api<{ csrf_token: string }>(token !== undefined ? '/setup' : '/session', 'POST', token !== undefined ? { token, password } : { password });
      setCsrf(session.csrf_token); await loadSettings(); setScreen('ready');
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }
  async function logout() {
    setBusy(true); setError('');
    try {
      await api('/session', 'DELETE', undefined, csrf);
      setCsrf(''); setSettings(null); setWishlistCount(null); setMessage(''); setSearchOpen(false); setPage('wishlist'); setScreen('login');
      window.history.replaceState(null, '', window.location.pathname);
    } catch (e) { handleProtectedError(e); }
    finally { setBusy(false); }
  }
  const handleProtectedError = useCallback((e: unknown) => {
    setError(errorText(e));
    if (e instanceof HttpError && e.status === 401) { setCsrf(''); setSettings(null); setWishlistCount(null); setSearchOpen(false); setScreen('login'); }
  }, []);
  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    if (!settings) return;
    const sources = [];
    for (const source of settings.sources) {
      const value = source.kind === 'shop' && source.enabled && source.fee_estimation_enabled
        ? parseFeePercent(feeDraft[source.id] ?? '') : source.fee_basis_points;
      if (value === null) { setError(`${shopNames[source.id]}: Gebühren bitte als Zahl von 0 bis 100 mit höchstens zwei Nachkommastellen eingeben.`); return; }
      sources.push({ ...source, fee_basis_points: value });
    }
    setBusy(true); setError(''); setMessage('');
    try {
      const saved = await api<Settings>('/settings', 'PUT', {
        ...settings, sources,
      }, csrf);
      setSettings(saved); setSavedCountry(saved.target_country); setFeeDraft(Object.fromEntries(saved.sources.map(s => [s.id, formatFeePercent(s.fee_basis_points)]))); setMessage('Einstellungen gespeichert.');
      refreshSources();
    } catch (e) { handleProtectedError(e); }
    finally { setBusy(false); }
  }
  const navigate = useCallback((next: Page) => {
    setSearchOpen(false);
    setPage(next); setMessage(''); setError('');
    const url = new URL(window.location.href);
    if (next === 'settings') { url.searchParams.set('view', 'settings'); refreshSources(); }
    else if (next === 'alerts') url.searchParams.set('view', 'alerts');
    else url.searchParams.delete('view');
    if (next !== 'settings') url.searchParams.delete('section');
    if (url.href !== window.location.href) window.history.pushState(null, '', url);
  }, [refreshSources]);
  useEffect(() => {
    const restore = () => { setPage(routePage()); setSearchOpen(false); };
    window.addEventListener('popstate', restore); return () => window.removeEventListener('popstate', restore);
  }, []);
  const openSearch = useCallback(() => setSearchOpen(true), []);
  const closeSearch = useCallback(() => setSearchOpen(false), []);
  const selectSearchResult = useCallback((item: WishlistItem) => {
    const url = new URL(window.location.href);
    url.searchParams.delete('view'); url.searchParams.delete('filter'); url.searchParams.set('item', item.id);
    if (url.href !== window.location.href) window.history.pushState(null, '', url);
    setPage('wishlist'); setMessage(''); setError(''); setWishlistRevision(n => n + 1);
  }, []);
  useEffect(() => {
    function keyboard(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        const input = document.getElementById('global-query');
        if (input) { event.preventDefault(); input.focus(); openSearch(); }
      }
    }
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  }, [openSearch]);
  const openSettings = useCallback(() => navigate('settings'), [navigate]);

  const countryNames = useMemo(() => new Intl.DisplayNames(['de'], { type: 'region' }), []);
  const countries = useMemo(() => (settings?.countries ?? []).map(code => ({ code, name: countryNames.of(code) ?? code })).sort((a, b) => a.name.localeCompare(b.name, 'de')), [settings?.countries, countryNames]);
  const targetLabel = savedCountry ? countryNames.of(savedCountry) : 'Noch nicht gewählt';

  if (screen !== 'ready') return <div className="auth-layout">
    <aside className="auth-story"><Brand /><div><p className="eyebrow">DEINE SPIELE. DEIN ÜBERBLICK.</p><h1>Die nächste<br />Entdeckung<br /><em>beginnt hier.</em></h1><p>Xbox-Spiele vormerken. Editionen unterscheiden. Angebote mit klarem Blick auf Region und Preis verfolgen.</p></div><span className="private-label"><span className="status-dot" /> Privat gehostet · nur für dich</span></aside>
    <main className="auth-main">
      <div className="mobile-brand"><Brand /></div>
      {screen === 'loading' ? <div className="auth-card"><p role="status">KeyHunter wird geladen …</p></div> : screen === 'offline' ? <div className="auth-card"><h1>Verbindung unterbrochen</h1><Notice error>{error}</Notice><Button onClick={() => void initialize()}>Erneut versuchen</Button></div> :
        <AuthForm setup={screen === 'setup'} busy={busy} error={error} onSubmit={signIn} />}
    </main>
  </div>;

  return <div className={`app-shell ${page === 'wishlist' ? 'dashboard-page' : 'settings-page'}`}>
    <a href="#main-content" className="skip-link">Zum Inhalt</a>
    <aside className="sidebar"><Brand />

      <nav aria-label="Hauptnavigation">
        <button className={`nav-item ${page === 'wishlist' ? 'active' : ''}`} aria-current={page === 'wishlist' ? 'page' : undefined} onClick={() => navigate('wishlist')}><Icon name="heart" />Wunschliste<span className="count">{wishlistCount ?? '–'}</span></button>
        <button className={`nav-item ${page === 'alerts' ? 'active' : ''}`} aria-current={page === 'alerts' ? 'page' : undefined} onClick={() => navigate('alerts')}><Icon name="bell" />Preisalarme</button>
        <button className={`nav-item ${page === 'settings' ? 'active' : ''}`} aria-current={page === 'settings' ? 'page' : undefined} onClick={() => navigate('settings')}><Icon name="settings" />Einstellungen</button>
      </nav>
      <div className="sidebar-platform"><p>Plattformen</p><div className="platform-selected"><Icon name="game" /><span>Xbox</span><span>✓</span></div><small>Series X|S · Xbox One</small></div>
      <div className="sidebar-bottom"><span className="status-dot" /><small>KeyHunter <span className="version">0.4.0</span></small><Button secondary className="logout" aria-label="Abmelden" title="Abmelden" onClick={() => void logout()} disabled={busy}><Icon name="logout" /></Button></div>
    </aside>
    <div className="workspace">
      <header className="topbar"><CatalogSearch inline csrf={csrf} open={searchOpen} onOpen={openSearch} onClose={closeSearch} onAdded={selectSearchResult} onError={handleProtectedError} /><div className="topbar-right"><span className="target-pill"><Icon name="globe" />{savedCountry ? targetLabel : 'Zielland wählen'}</span><button className="avatar" aria-label="Einstellungen öffnen" onClick={openSettings}>K</button></div></header>
      <main id="main-content" tabIndex={-1}>
        {error && <Notice error>{error}</Notice>}
        {message && <Notice>{message}</Notice>}
        {page === 'wishlist' ? <Wishlist key={wishlistRevision} csrf={csrf} targetCountry={savedCountry} targetLabel={targetLabel ?? 'Noch nicht gewählt'} onSettings={openSettings} onCountChange={setWishlistCount} onError={handleProtectedError} /> : page === 'alerts' ? <PriceAlerts csrf={csrf} onError={handleProtectedError} /> : settings && <SettingsPage settings={settings} setSettings={next=>{setSettings(next);setMessage('');}} csrf={csrf} busy={busy} countries={countries} feeDraft={feeDraft} setFeeDraft={next=>{setFeeDraft(next);setMessage('');}} status={sourceStatus} onSave={saveSettings} onChanged={refreshSources} onError={handleProtectedError} onHelp={()=>setDialogOpen(true)} onShopChanged={next=>{
          const changed=next.sources.filter(source=>settings.sources.find(old=>old.id===source.id)?.configured!==source.configured);
          setSettings({...settings,sources:settings.sources.map(source=>changed.find(row=>row.id===source.id)??source)});
          setFeeDraft({...feeDraft,...Object.fromEntries(changed.map(source=>[source.id,formatFeePercent(source.fee_basis_points)]))});
        }}/>}
      </main>
      <footer className="app-footer"><span>KeyHunter</span><span>Deine Auswahl. Dein Überblick.</span></footer>
    </div>
    <InfoDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
  </div>;
}

function AuthForm({ setup, busy, error, onSubmit }: { setup: boolean; busy: boolean; error: string; onSubmit: (password: string, token?: string) => Promise<void> }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [token, setToken] = useState('');
  const [localError, setLocalError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); setLocalError('');
    if (setup && password !== confirm) { setLocalError('Die Passphrasen stimmen nicht überein.'); return; }
    await onSubmit(password, setup ? token : undefined);
  }
  return <div className="auth-card"><p className="eyebrow">DEIN PRIVATER BEREICH</p><h1>{setup ? 'Willkommen bei KeyHunter.' : 'Schön, dass du da bist.'}</h1><p className="auth-intro">{setup ? 'Richte deinen persönlichen Zugang ein. Nur du verwaltest deine Spiele und Einstellungen.' : 'Melde dich an, um deine Wunschliste und Einstellungen zu öffnen.'}</p>
    <form onSubmit={submit}>
      {(localError || error) && <Notice error>{localError || error}</Notice>}
      {setup && <div className="field"><label htmlFor="setup-token">Einrichtungscode</label><input id="setup-token" type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} required spellCheck={false} /><span className="field-help">Aus der lokalen Datei <code>bootstrap-token</code> im Datenverzeichnis.</span></div>}
      <div className="field"><label htmlFor="password">Passphrase</label><input id="password" type="password" autoComplete={setup ? 'new-password' : 'current-password'} minLength={setup ? 12 : undefined} maxLength={128} value={password} onChange={e => setPassword(e.target.value)} required />{setup && <span className="field-help">12 bis 128 Zeichen, gerne mehrere Wörter.</span>}</div>
      {setup && <div className="field"><label htmlFor="password-confirm">Passphrase wiederholen</label><input id="password-confirm" type="password" autoComplete="new-password" minLength={12} maxLength={128} value={confirm} onChange={e => setConfirm(e.target.value)} required /></div>}
      <Button type="submit" disabled={busy}>{busy ? 'Bitte warten …' : setup ? 'Privaten Bereich einrichten' : 'Anmelden'}<span aria-hidden="true"> →</span></Button>
    </form><p className="auth-footnote">Ein Zugang. Keine öffentliche Registrierung.</p>
  </div>;
}
