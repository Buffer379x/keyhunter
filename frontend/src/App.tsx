import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, CART_CHANGED, HttpError, onSessionEnd, setCsrf } from './api';
import type { Settings, SourceStatuses } from './api';
import Wishlist from './features/Wishlist';
import Library from './features/Library';
import Cart from './features/Cart';
import CatalogSearch from './features/CatalogSearch';
import type { WishlistItem } from './api';
import PriceAlerts from './features/PriceAlerts';
import SettingsPage from './features/SettingsPage';
import AuthScreen from './features/AuthScreen';
import { Brand, Button, Icon, IconButton, Toaster } from './components';
import { notifyError } from './notify';
import type { IconName } from './components';
import FetchStatus from './FetchStatus';
import { usePolled } from './usePolled';
import { mediaQuery } from './breakpoints';
import { useMediaQuery } from './useMediaQuery';
import { useSettingsDraft } from './features/settings/draft';
import UnsavedDialog from './features/settings/UnsavedDialog';
import { appVersion } from './version';
import { sectionLabel } from './features/settings/sections';
import { navigate, onRouteChange, returnToList, useRoute } from './route';
import type { Page, TabId } from './route';
import type { Section } from './features/settings/sections';

type Screen = 'loading' | 'setup' | 'login' | 'ready' | 'offline';
const errorText = (error: unknown) => (error instanceof Error ? error.message : 'Ein Fehler ist aufgetreten.');

export default function App() {
  const [screen, setScreen] = useState<Screen>('loading');
  const [searchOpen, setSearchOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [libraryAddOpen, setLibraryAddOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [wishlistRevision, setWishlistRevision] = useState(0);
  const { page, section } = useRoute();
  const [gameTitle, setGameTitle] = useState<string | null>(null);
  const [wishlistCount, setWishlistCount] = useState<number | null>(null);
  const [libraryCount, setLibraryCount] = useState<number | null>(null);
  const [alertCount, setAlertCount] = useState<number | null>(null);
  const [cartCount, setCartCount] = useState<number | null>(null);
  const [cartRevision, setCartRevision] = useState(0);
  // A change of the wishlist size (add, remove, purchase) also changes the other counts; its first report does not.
  const [wishlistSize, setWishlistSize] = useState(0);
  const knownWishlist = useRef(wishlistCount);
  knownWishlist.current = wishlistCount;
  const reportWishlistCount = useCallback((count: number) => {
    if (knownWishlist.current !== null && knownWishlist.current !== count) setWishlistSize(n => n + 1);
    setWishlistCount(count);
  }, []);
  const drawer = useMediaQuery(mediaQuery.drawer);
  const [sourceStatus, setSourceStatus] = useState<SourceStatuses | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const menuButton = useRef<HTMLButtonElement>(null);
  const sidebar = useRef<HTMLElement>(null);

  const refreshSources = useCallback(() => {
    void api<SourceStatuses>('/sources/status')
      .then(setSourceStatus)
      .catch(() => setSourceStatus(null));
  }, []);

  async function loadSettings() {
    const data = await api<Settings>('/settings');
    auto.reset(data);
    refreshSources();
  }
  async function initialize() {
    setScreen('loading');
    setError('');
    try {
      const status = await api<{ required: boolean }>('/setup');
      if (status.required) {
        setScreen('setup');
        return;
      }
      try {
        const session = await api<{ csrf_token: string }>('/me');
        setCsrf(session.csrf_token);
        await loadSettings();
        setScreen('ready');
      } catch (e) {
        if (e instanceof HttpError && e.status === 401) setScreen('login');
        else throw e;
      }
    } catch (e) {
      setError(errorText(e));
      setScreen('offline');
    }
  }
  useEffect(() => {
    void initialize();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once on mount; initialize only reads local app state
  }, []);

  async function signIn(password: string, token?: string, targetCountry?: string) {
    setBusy(true);
    setError('');
    try {
      const session = await api<{ csrf_token: string }>(
        token !== undefined ? '/setup' : '/session',
        'POST',
        token !== undefined ? { token, password, target_country: targetCountry } : { password },
      );
      setCsrf(session.csrf_token);
      await loadSettings();
      setScreen('ready');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  /** The session ended: back to the sign-in, with the server's message after a 401 (none after "Abmelden"). */
  const endSession = useCallback((message = '') => {
    setCsrf('');
    setWishlistCount(null);
    setLibraryCount(null);
    setAlertCount(null);
    setCartCount(null);
    setSearchOpen(false);
    setAddOpen(false);
    setLibraryAddOpen(false);
    setNavOpen(false);
    setError(message);
    setScreen('login');
  }, []);
  // Any request that answers 401 ends the session (api.ts); the page stays in the URL for the next sign-in.
  useEffect(() => onSessionEnd(e => endSession(e.message)), [endSession]);
  /** The session ended on purpose ("Abmelden", "Überall abmelden"): the sign-in, then the wishlist. */
  const signedOut = () => {
    endSession();
    navigate({}, { replace: true, reset: true });
  };
  async function logout() {
    setBusy(true);
    setError('');
    try {
      await api('/session', 'DELETE');
      signedOut();
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  }
  const auto = useSettingsDraft({ onSaved: refreshSources });
  const savedCountry = auto.saved?.target_country ?? null;
  /** Go to a page (and settings section). `add` opens the wishlist's add dialog on arrival. */
  const openPage = useCallback(
    (next: Page, nextSection: Section = 'general', add = false) => {
      setSearchOpen(false);
      setNavOpen(false);
      setError('');
      if (next === 'settings') {
        refreshSources();
        document.getElementById('main-content')?.scrollTo?.({ top: 0 });
      }
      // The game is a page of its own below the wishlist: every navigation entry leads to a list, never to the last game.
      navigate({
        view: next === 'wishlist' ? null : next,
        section: next === 'settings' && nextSection !== 'general' ? nextSection : null,
        item: null,
        tab: null,
      });
      setAddOpen(add);
    },
    [refreshSources],
  );
  // Leaving the settings (also with browser back) with unsaved changes asks whether to save or discard them.
  const lastSection = useRef<Section>(section);
  if (page === 'settings') lastSection.current = section;
  const [leaving, setLeaving] = useState<Section | null>(null);
  const wasSettings = useRef(page === 'settings');
  useEffect(() => {
    if (wasSettings.current && page !== 'settings' && auto.dirty) setLeaving(lastSection.current);
    if (page === 'settings') setLeaving(null);
    wasSettings.current = page === 'settings';
  }, [page, auto.dirty]);
  // Browser back/forward and a link to another page or settings tab close the search, the add dialog and the drawer.
  useEffect(
    () =>
      onRouteChange((next, previous, browser) => {
        if (!browser && next.page === previous.page && next.section === previous.section) return;
        setSearchOpen(false);
        setAddOpen(false);
        setNavOpen(false);
      }),
    [],
  );
  const openSearch = useCallback(() => setSearchOpen(true), []);
  const closeSearch = useCallback(() => setSearchOpen(false), []);
  /** A game on its page below the wishlist (search, library, cart); `tab` opens one tab directly (the cart's warning triangle, PROD-03). */
  const showGame = useCallback((item: WishlistItem, tab?: TabId) => {
    navigate({ view: null, section: null, filter: null, item: item.id, tab });
    setError('');
    setWishlistRevision(n => n + 1);
  }, []);
  const selectSearchResult = useCallback((item: WishlistItem) => showGame(item), [showGame]);
  /** "Spiel hinzufügen" in the top bar: in the library it adds straight to the library (0.7.2); elsewhere the
   * dialog belongs to the wishlist, so open that page first. */
  function openAdd() {
    if (page === 'library') setLibraryAddOpen(true);
    else if (page !== 'wishlist') openPage('wishlist', 'general', true);
    else setAddOpen(true);
  }
  /** Breadcrumb "Wunschliste" in the game view: back to the list without a selection. */
  function backToList() {
    // Opened from the list: go back, so the list keeps its place.
    if (!returnToList()) navigate({ item: null, tab: null });
  }
  useEffect(() => {
    function keyboard(event: KeyboardEvent) {
      if (document.querySelector('dialog[open]')) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        const input = document.getElementById('global-query');
        if (input) {
          event.preventDefault();
          setNavOpen(false);
          input.focus();
          openSearch();
        }
      }
    }
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  }, [openSearch]);
  // Drawer (up to 900 px): Escape closes it and returns focus to the menu button; opening moves focus into it.
  // The button is in the page, which is inert while the drawer is open: it gets the focus once the drawer has closed.
  const focusMenu = useRef(false);
  useEffect(() => {
    if (!navOpen) {
      if (focusMenu.current) menuButton.current?.focus();
      focusMenu.current = false;
      return;
    }
    sidebar.current?.querySelector<HTMLElement>('.nav-item[aria-current="page"], .nav-item')?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        focusMenu.current = true;
        setNavOpen(false);
      }
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [navOpen]);
  useEffect(() => {
    if (!drawer) setNavOpen(false);
  }, [drawer]);
  const openSettings = useCallback((next: Section = 'general') => openPage('settings', next), [openPage]);
  // Counts in the navigation (CODE-08): one small read after sign-in, on every page change and whenever the wishlist
  // or the cart changes. The open list page reports its own count, so a read in flight never overwrites it.
  useEffect(() => {
    const changed = () => setCartRevision(n => n + 1);
    window.addEventListener(CART_CHANGED, changed);
    return () => window.removeEventListener(CART_CHANGED, changed);
  }, []);
  usePolled<{ wishlist: number; cart: number; library: number; alerts: number }>(screen === 'ready' ? '/counts' : null, {
    restart: [page, wishlistSize, cartRevision],
    onData: counts => {
      if (page !== 'wishlist') setWishlistCount(counts.wishlist);
      if (page !== 'cart') setCartCount(counts.cart);
      if (page !== 'library') setLibraryCount(counts.library);
      setAlertCount(counts.alerts);
    },
  });

  const countryNames = useMemo(() => new Intl.DisplayNames(['de'], { type: 'region' }), []);
  const countries = useMemo(
    () => (auto.settings?.countries ?? []).map(code => ({ code, name: countryNames.of(code) ?? code })).sort((a, b) => a.name.localeCompare(b.name, 'de')),
    [auto.settings?.countries, countryNames],
  );
  const targetLabel = savedCountry ? countryNames.of(savedCountry) : 'Noch nicht gewählt';

  if (screen !== 'ready') return <AuthScreen screen={screen} busy={busy} error={error} onRetry={() => void initialize()} onSubmit={signIn} />;

  const overview: { page: Page; label: string; icon: IconName; count: number | null }[] = [
    { page: 'wishlist', label: 'Wunschliste', icon: 'heart', count: wishlistCount },
    { page: 'cart', label: 'Warenkorb', icon: 'cart', count: cartCount },
    { page: 'library', label: 'Bibliothek', icon: 'library', count: libraryCount },
    { page: 'alerts', label: 'Preisalarme', icon: 'bell', count: alertCount },
  ];
  const crumbs =
    page === 'wishlist' && gameTitle ? (
      <>
        <button type="button" onClick={backToList}>
          Wunschliste
        </button>
        <Icon name="chev" size={14} />
        <span className="here" aria-current="page">
          {gameTitle}
        </span>
      </>
    ) : page === 'settings' ? (
      <>
        <span>Einstellungen</span>
        <Icon name="chev" size={14} />
        <span className="here" aria-current="page">
          {sectionLabel(section)}
        </span>
      </>
    ) : (
      <>
        <span>KeyHunter</span>
        <Icon name="chev" size={14} />
        <span className="here" aria-current="page">
          {overview.find(item => item.page === page)?.label}
        </span>
      </>
    );
  // RESP-08: the open drawer is modal; the page behind it is inert, so Tab and the screen reader stay in the navigation.
  const modalNav = navOpen && drawer;
  return (
    <div className={`app${navOpen ? ' nav-open' : ''}`}>
      <a href="#main-content" className="skip-link" inert={modalNav}>
        Zum Inhalt
      </a>
      <aside
        className="side"
        id="app-sidebar"
        ref={sidebar}
        aria-label="Seitenleiste"
        role={modalNav ? 'dialog' : undefined}
        aria-modal={modalNav || undefined}
      >
        <a
          className="brand-box"
          href={window.location.pathname}
          aria-label="KeyHunter, zur Wunschliste"
          title={`KeyHunter ${appVersion}`}
          onClick={event => {
            event.preventDefault();
            openPage('wishlist');
          }}
        >
          <Brand />
        </a>
        <nav className="side-nav" aria-label="Hauptnavigation">
          <div className="nav-group" role="group" aria-labelledby="nav-overview">
            <span className="label" id="nav-overview">
              Übersicht
            </span>
            {overview.map(item => (
              <button
                key={item.page}
                type="button"
                className="nav-item"
                aria-current={page === item.page ? 'page' : undefined}
                onClick={() => openPage(item.page)}
              >
                <Icon name={item.icon} />
                {item.label}
                <span className="count" aria-hidden="true">
                  {item.count ?? '–'}
                </span>
              </button>
            ))}
          </div>
        </nav>
        <div className="side-foot">
          <FetchStatus onOpen={() => openSettings('status')} />
          {/* 0.8.3: the settings are one page with tabs; the sidebar keeps only these two buttons below the fetch status. */}
          <div className="side-actions">
            <IconButton
              label="Einstellungen"
              aria-current={page === 'settings' ? 'page' : undefined}
              onClick={() => openSettings(page === 'settings' ? section : 'general')}
            >
              <Icon name="settings" />
            </IconButton>
            <IconButton label="Abmelden" disabled={busy} onClick={() => void logout()}>
              <Icon name="logout" />
            </IconButton>
          </div>
        </div>
      </aside>
      <div className="scrim" aria-hidden="true" onClick={() => setNavOpen(false)} />
      <div className="main" inert={modalNav}>
        <header className="top">
          <IconButton
            ref={menuButton}
            className="menu-btn"
            label="Menü öffnen"
            aria-expanded={navOpen}
            aria-controls="app-sidebar"
            onClick={() => setNavOpen(true)}
          >
            <Icon name="menu" />
          </IconButton>
          <nav className="crumbs" aria-label="Pfad">
            {crumbs}
          </nav>
          <div className="top-right">
            <CatalogSearch inline open={searchOpen} onOpen={openSearch} onClose={closeSearch} onAdded={selectSearchResult} />
            <IconButton className="hide-sm" label="Preisalarme" onClick={() => openPage('alerts')}>
              <Icon name="bell" />
            </IconButton>
            <Button variant="primary" className="hide-sm" onClick={openAdd}>
              <Icon name="plus" />
              Spiel hinzufügen
            </Button>
            {/* 1.0: on the phone the same action as a symbol button, so adding stays one tap away with a filled list. */}
            <IconButton variant="primary" className="show-sm" label="Spiel hinzufügen" onClick={openAdd}>
              <Icon name="plus" />
            </IconButton>
          </div>
        </header>
        <main id="main-content" className="content" tabIndex={-1}>
          {page === 'wishlist' ? (
            <Wishlist
              key={wishlistRevision}
              targetCountry={savedCountry}
              columns={auto.saved?.wishlist_columns}
              hidden={auto.saved?.wishlist_hidden}
              opener={auto.saved?.wishlist_open}
              offersColumns={auto.saved?.offers_columns}
              offersHidden={auto.saved?.offers_hidden}
              targetLabel={targetLabel ?? 'Noch nicht gewählt'}
              addOpen={addOpen}
              onAddOpen={setAddOpen}
              indexState={sourceStatus ? (sourceStatus.igdb?.state ?? 'not_configured') : undefined}
              shopsActive={auto.saved ? auto.saved.sources.some(source => source.kind === 'shop' && source.enabled && source.configured) : undefined}
              onTitle={setGameTitle}
              onSettings={() => openSettings()}
              onCountChange={reportWishlistCount}
            />
          ) : page === 'library' ? (
            <Library
              addOpen={libraryAddOpen}
              onAddOpen={setLibraryAddOpen}
              onRestored={selectSearchResult}
              onOpenWishlist={() => openPage('wishlist')}
              onCountChange={setLibraryCount}
            />
          ) : page === 'cart' ? (
            <Cart
              targetCountry={savedCountry ?? ''}
              onOpen={selectSearchResult}
              onReview={item => showGame(item, 'zuordnungen')}
              onOpenWishlist={() => openPage('wishlist')}
              onCountChange={setCartCount}
            />
          ) : page === 'alerts' ? (
            <PriceAlerts targetCountry={savedCountry} targetLabel={targetLabel ?? 'Zielland'} />
          ) : (
            auto.settings && (
              <SettingsPage
                section={section}
                onSection={openSettings}
                settings={auto.settings}
                auto={auto}
                busy={busy}
                countries={countries}
                sourceStatus={sourceStatus}
                onSourcesChanged={refreshSources}
                onLogout={() => void logout()}
                onSignedOut={signedOut}
              />
            )
          )}
        </main>
      </div>
      <Toaster />
      <UnsavedDialog
        open={leaving !== null && auto.dirty}
        error={auto.state === 'error' ? auto.error : ''}
        onSave={async () => {
          const ok = await auto.save();
          if (ok) setLeaving(null);
          return ok;
        }}
        onDiscard={() => {
          auto.discard();
          setLeaving(null);
        }}
        onBack={() => {
          const back = leaving ?? 'general';
          setLeaving(null);
          openPage('settings', back);
        }}
      />
    </div>
  );
}
