import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { api, HttpError } from './api';
import type { Settings, SourceStatuses } from './api';
import Wishlist from './features/Wishlist';
import PriceAlerts from './features/PriceAlerts';
import IgdbAccess from './features/IgdbAccess';
import { shopNames } from './features/Offers';
import { Brand, Button, InfoDialog, Notice } from './components';
import { formatFeePercent, parseFeePercent } from './fees';

type Page = 'wishlist' | 'settings' | 'alerts';
function routePage(): Page {
  const view = new URL(window.location.href).searchParams.get('view');
  return view === 'settings' || view === 'alerts' ? view : 'wishlist';
}
const sourceStates: Record<string, string> = {
  ready: 'Abruf erfolgreich', idle: 'Bereit für die Angebotssuche', paused: 'Abrufe pausiert', error: 'Letzter Abruf fehlgeschlagen',
  configured: 'Zugang konfiguriert', not_configured: 'IGDB-Zugang noch nicht eingerichtet',
  invalid_credentials: 'Zugangsdaten abgewiesen',
  disabled: 'Deaktiviert', rate_limited: 'Abruf pausiert · Limit', unavailable: 'Quelle vorübergehend nicht verfügbar',
};

type Screen = 'loading' | 'setup' | 'login' | 'ready' | 'offline';
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Ein Fehler ist aufgetreten.';

export default function App() {
  const [screen, setScreen] = useState<Screen>('loading');
  const [csrf, setCsrf] = useState('');
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
      setCsrf(''); setSettings(null); setWishlistCount(null); setMessage(''); setPage('wishlist'); setScreen('login');
      window.history.replaceState(null, '', window.location.pathname);
    } catch (e) { handleProtectedError(e); }
    finally { setBusy(false); }
  }
  const handleProtectedError = useCallback((e: unknown) => {
    setError(errorText(e));
    if (e instanceof HttpError && e.status === 401) { setCsrf(''); setSettings(null); setWishlistCount(null); setScreen('login'); }
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
    setPage(next); setMessage(''); setError('');
    const url = new URL(window.location.href);
    if (next === 'settings') { url.searchParams.set('view', 'settings'); refreshSources(); }
    else if (next === 'alerts') url.searchParams.set('view', 'alerts');
    else url.searchParams.delete('view');
    if (url.href !== window.location.href) window.history.pushState(null, '', url);
  }, [refreshSources]);
  useEffect(() => {
    const restore = () => setPage(routePage());
    window.addEventListener('popstate', restore); return () => window.removeEventListener('popstate', restore);
  }, []);
  const openSettings = useCallback(() => navigate('settings'), [navigate]);

  const countryNames = useMemo(() => new Intl.DisplayNames(['de'], { type: 'region' }), []);
  const countries = useMemo(() => (settings?.countries ?? []).map(code => ({ code, name: countryNames.of(code) ?? code })).sort((a, b) => a.name.localeCompare(b.name, 'de')), [settings?.countries, countryNames]);
  const targetLabel = savedCountry ? countryNames.of(savedCountry) : 'Noch nicht gewählt';

  if (screen !== 'ready') return <div className="auth-layout">
    <aside className="auth-story"><Brand /><div><p className="eyebrow">DEINE SPIELE. DEIN ÜBERBLICK.</p><h1>Die nächste<br />Entdeckung<br /><em>beginnt hier.</em></h1><p>Xbox-Spiele vormerken. Editionen unterscheiden. Angebote mit klarem Blick auf Region und Preis verfolgen.</p></div><span className="private-label"><span className="status-dot" /> Privat gehostet · nur für dich</span></aside>
    <main className="auth-main">
      <div className="mobile-brand"><Brand /></div>
      {screen === 'loading' ? <div className="auth-card"><p role="status">KEYHUNTER wird geladen …</p></div> : screen === 'offline' ? <div className="auth-card"><h1>Verbindung unterbrochen</h1><Notice error>{error}</Notice><Button onClick={() => void initialize()}>Erneut versuchen</Button></div> :
        <AuthForm setup={screen === 'setup'} busy={busy} error={error} onSubmit={signIn} />}
    </main>
  </div>;

  return <div className="app-shell">
    <a href="#main-content" className="skip-link">Zum Inhalt</a>
    <aside className="sidebar"><Brand />
      <div className="sidebar-caption">DEIN BEREICH</div>
      <nav aria-label="Hauptnavigation">
        <button className={`nav-item ${page === 'wishlist' ? 'active' : ''}`} aria-current={page === 'wishlist' ? 'page' : undefined} onClick={() => navigate('wishlist')}><span aria-hidden="true">☆</span>Wunschliste<span className="count">{wishlistCount ?? '–'}</span></button>
        <button className={`nav-item ${page === 'alerts' ? 'active' : ''}`} aria-current={page === 'alerts' ? 'page' : undefined} onClick={() => navigate('alerts')}><span aria-hidden="true">♧</span>Preisalarme</button>
        <button className={`nav-item ${page === 'settings' ? 'active' : ''}`} aria-current={page === 'settings' ? 'page' : undefined} onClick={() => navigate('settings')}><span aria-hidden="true">⚙</span>Einstellungen</button>
      </nav>
      <div className="sidebar-bottom"><div className="platform-label">PLATTFORM</div><strong>Xbox Series X|S</strong><p>Auch Xbox One · EUR</p><Button secondary className="logout" onClick={() => void logout()} disabled={busy}>Abmelden</Button></div>
    </aside>
    <div className="workspace">
      <header className="topbar"><span>Deine persönliche Spieleübersicht</span><span className="private-pill"><span className="status-dot" /> Privater Bereich</span></header>
      <main id="main-content" tabIndex={-1}>
        {error && <Notice error>{error}</Notice>}
        {message && <Notice>{message}</Notice>}
        {page === 'wishlist' ? <Wishlist csrf={csrf} targetCountry={savedCountry} targetLabel={targetLabel ?? 'Noch nicht gewählt'} onSettings={openSettings} onCountChange={setWishlistCount} onError={handleProtectedError} /> : page === 'alerts' ? <PriceAlerts csrf={csrf} onError={handleProtectedError} /> : <>
          <div className="page-heading"><div><p className="eyebrow">SO PASST KEYHUNTER ZU DIR</p><h1>Einstellungen<span className="accent-dot">.</span></h1><p>Dein Zielland, deine Quellen und deine Preisgrundlage.</p></div></div>
          {settings && <form onSubmit={saveSettings} className="settings-form">
            <section className="settings-card" aria-labelledby="general-title"><div className="section-number">01</div><div className="section-content"><h2 id="general-title">Region & Anzeige</h2><p>Das Zielland bestimmt die Aktivierungseignung. Angebote aus anderen Ländern bleiben sichtbar.</p><div className="field-grid"><div className="field"><label htmlFor="target-country">Zielland</label><select id="target-country" value={settings.target_country ?? ''} onChange={e => { setSettings({ ...settings, target_country: e.target.value || null }); setMessage(''); }}><option value="">Bitte wählen</option>{countries.map(c => <option key={c.code} value={c.code}>{c.name}</option>)}</select></div><div className="field"><label htmlFor="currency">Vergleichswährung</label><input id="currency" readOnly value="EUR · Euro" /><span className="field-help">Preise werden in Euro verglichen.</span></div></div></div></section>
            <section className="settings-card" aria-labelledby="sources-title"><div className="section-number">02</div><div className="section-content"><h2 id="sources-title">Datenquellen</h2><p>Metadaten und Shopangebote erfüllen unterschiedliche Aufgaben.</p><div className="source-list">{settings.sources.map(source => <article className="source-card" key={source.id} aria-label={shopNames[source.id]}>
              <div className="source-heading"><div className={`source-logo ${source.id}`}>{source.kind === 'catalog' ? 'IG' : shopNames[source.id]?.[0]}</div><div><h3>{shopNames[source.id]}</h3><span>{source.kind === 'shop' ? 'Key-Angebote · öffentliche Produktdaten' : 'Spielekatalog · offizielle API'}</span></div><label className="source-toggle"><input type="checkbox" aria-label={`${shopNames[source.id]} aktivieren`} checked={source.enabled} onChange={e => { setSettings({ ...settings, sources: settings.sources.map(s => s.id === source.id ? { ...s, enabled: e.target.checked } : s) }); setMessage(''); }} /><span>Aktiv</span></label></div>
              <span className="source-state">{sourceStates[sourceStatus?.[source.id]?.state ?? ''] ?? 'Status wird gelesen …'}</span>
              {source.kind === 'shop' && <div className="fee-options"><label className="check-label"><input type="checkbox" checked={source.fee_estimation_enabled} disabled={!source.enabled} onChange={e => { setSettings({ ...settings, sources: settings.sources.map(s => s.id === source.id ? { ...s, fee_estimation_enabled: e.target.checked } : s) }); setMessage(''); }} />Geschätzte Gebühren berücksichtigen</label><div className="fee-row"><div className="field"><label htmlFor={`${source.id}-fee`}>Geschätzte Gebühren (%)</label><input id={`${source.id}-fee`} inputMode="decimal" value={feeDraft[source.id] ?? ''} disabled={!source.enabled || !source.fee_estimation_enabled} onChange={e => { setFeeDraft({ ...feeDraft, [source.id]: e.target.value }); setMessage(''); }} aria-describedby={`${source.id}-fee-help`} /></div><p id={`${source.id}-fee-help`}>Optionaler Aufschlag. Daraus berechnete Gesamtpreise bleiben als Schätzung gekennzeichnet.</p></div></div>}
            </article>)}</div><button className="text-button" type="button" onClick={() => setDialogOpen(true)}>Wie werden Gebühren behandelt?</button></div></section>
            <div className="settings-actions"><p>Änderungen gelten nach dem Speichern.</p><Button type="submit" disabled={busy}>{busy ? 'Wird gespeichert …' : 'Änderungen speichern'}</Button></div>
          </form>}
          {settings && <div className="settings-form"><IgdbAccess
            configured={sourceStatus?.igdb?.configured} csrf={csrf}
            onChanged={refreshSources} onError={handleProtectedError}
          /></div>}
        </>}
      </main>
      <footer className="app-footer"><span>KEYHUNTER <strong>GLOBAL</strong></span><span>Deine Auswahl. Dein Überblick.</span></footer>
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
  return <div className="auth-card"><p className="eyebrow">DEIN PRIVATER BEREICH</p><h1>{setup ? 'Willkommen bei KEYHUNTER.' : 'Schön, dass du da bist.'}</h1><p className="auth-intro">{setup ? 'Richte deinen persönlichen Zugang ein. Nur du verwaltest deine Spiele und Einstellungen.' : 'Melde dich an, um deine Wunschliste und Einstellungen zu öffnen.'}</p>
    <form onSubmit={submit}>
      {(localError || error) && <Notice error>{localError || error}</Notice>}
      {setup && <div className="field"><label htmlFor="setup-token">Einrichtungscode</label><input id="setup-token" type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} required spellCheck={false} /><span className="field-help">Aus der lokalen Datei <code>bootstrap-token</code> im Datenverzeichnis.</span></div>}
      <div className="field"><label htmlFor="password">Passphrase</label><input id="password" type="password" autoComplete={setup ? 'new-password' : 'current-password'} minLength={setup ? 12 : undefined} maxLength={128} value={password} onChange={e => setPassword(e.target.value)} required />{setup && <span className="field-help">12 bis 128 Zeichen, gerne mehrere Wörter.</span>}</div>
      {setup && <div className="field"><label htmlFor="password-confirm">Passphrase wiederholen</label><input id="password-confirm" type="password" autoComplete="new-password" minLength={12} maxLength={128} value={confirm} onChange={e => setConfirm(e.target.value)} required /></div>}
      <Button type="submit" disabled={busy}>{busy ? 'Bitte warten …' : setup ? 'Privaten Bereich einrichten' : 'Anmelden'}<span aria-hidden="true"> →</span></Button>
    </form><p className="auth-footnote">Ein Zugang. Keine öffentliche Registrierung.</p>
  </div>;
}
