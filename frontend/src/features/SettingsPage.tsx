import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { Settings, SourceStatuses } from '../api';
import { Button, Icon } from '../components';
import General from './settings/General';
import Shops from './settings/Shops';
import Index from './settings/Index';
import Notifications from './settings/Notifications';
import FetchPanel from './settings/FetchPanel';
import System from './settings/System';
import { useAlertOverview, useFetchStatus } from './settings/data';
import type { Autosave } from './settings/autosave';
import '../styles/settings.css';

type Section = 'general' | 'shops' | 'index' | 'notifications' | 'status' | 'system';
const sections: { id: Section; label: string }[] = [
  { id: 'general', label: 'Allgemein' }, { id: 'shops', label: 'Key-Shops' }, { id: 'index', label: 'Spieleindex' },
  { id: 'notifications', label: 'Benachrichtigungen' }, { id: 'status', label: 'Abrufstatus' }, { id: 'system', label: 'System' },
];
const ids = sections.map(s => s.id);
/** The URL carries the section: ?view=settings&section=shops. Allgemein has no parameter. */
const route = (): Section => {
  const value = new URL(location.href).searchParams.get('section');
  return ids.includes(value as Section) ? value as Section : 'general';
};
const OPERATIONS_GUIDE = 'https://github.com/Buffer379x/keyhunter/blob/main/docs/operations.md';

interface Props {
  settings: Settings; auto: Autosave; csrf: string; countries: { code: string; name: string }[];
  sourceStatus: SourceStatuses | null; busy: boolean;
  onSourcesChanged: () => void; onShopsChanged: (saved: Settings) => void; onError: (error: unknown) => void; onHelp: () => void; onLogout: () => void;
}

function SaveIndicator({ auto }: { auto: Autosave }) {
  const { state, error, retryable, retry } = auto;
  return <div className={`set-save ${state}`}>
    <span role="status" className="ui-mono">
      {state === 'saved' ? <><span className="set-dot ok" aria-hidden="true" />Alle Änderungen gespeichert</>
        : state === 'error' ? <><Icon name="alert" size={14} />Nicht gespeichert</>
          : <><span className="ui-spinner" aria-hidden="true" />Wird gespeichert …</>}
    </span>
    {state === 'error' && <span className="set-save-error" role="alert">{error}{retryable && <Button variant="ghost" size="sm" onClick={retry}>Erneut versuchen</Button>}</span>}
  </div>;
}

export default function SettingsPage({ settings, auto, csrf, countries, sourceStatus, busy, onSourcesChanged, onShopsChanged, onError, onHelp, onLogout }: Props) {
  const [section, setSection] = useState<Section>(route);
  const tabs = useRef(new Map<Section, HTMLButtonElement>());
  useEffect(() => { const restore = () => setSection(route()); window.addEventListener('popstate', restore); return () => window.removeEventListener('popstate', restore); }, []);
  // On phones the section list scrolls sideways: keep the open section in view.
  useEffect(() => { tabs.current.get(section)?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' }); }, [section]);
  const fetched = useFetchStatus(section === 'shops' || section === 'status');
  const alerts = useAlertOverview();

  function open(next: Section, focus = false) {
    setSection(next);
    const page = new URL(location.href);
    if (next === 'general') page.searchParams.delete('section'); else page.searchParams.set('section', next);
    if (page.href !== location.href) window.history.pushState(null, '', page);
    document.getElementById('main-content')?.scrollTo?.({ top: 0 });
    if (focus) tabs.current.get(next)?.focus();
  }
  function keys(event: KeyboardEvent) {
    const focused = (event.target as HTMLElement).closest('[role="tab"]')?.id.replace('settings-tab-', '') as Section | undefined;
    const at = ids.indexOf(focused && ids.includes(focused) ? focused : section);
    const target = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? ids[(at + 1) % ids.length]
      : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? ids[(at - 1 + ids.length) % ids.length]
        : event.key === 'Home' ? ids[0] : event.key === 'End' ? ids[ids.length - 1] : undefined;
    if (target) { event.preventDefault(); open(target, true); }
  }

  const shopsActive = settings.sources.filter(s => s.kind === 'shop' && s.configured && s.enabled).length;
  const igdbState = sourceStatus?.igdb?.state;
  const igdbOn = settings.sources.find(s => s.id === 'igdb')?.enabled ?? true;
  const due = fetched.data ? fetched.data.shops.filter(s => s.enabled).reduce((sum, s) => sum + s.backlog.due, 0) : null;
  const hints: Record<Section, string> = {
    general: 'Zielland, Preisanzeige, Export',
    shops: shopsActive === 0 ? 'Kein Shop aktiv' : `${shopsActive} aktiv`,
    index: !igdbState ? '' : !igdbOn ? 'IGDB deaktiviert' : igdbState === 'ready' ? 'IGDB verbunden' : igdbState === 'configured' ? 'IGDB hinterlegt' : igdbState === 'not_configured' ? 'IGDB nicht eingerichtet' : 'IGDB mit Problem',
    notifications: alerts.data ? (alerts.data.configured ? 'ntfy eingerichtet' : 'ntfy nicht eingerichtet') : '',
    status: due === null ? '' : due === 0 ? 'Nichts ausstehend' : `${due} ausstehend`,
    system: 'Sicherheit, Backup, Version',
  };

  return <div className="settings-layout">
    <header className="set-head">
      <div><h1>Einstellungen</h1><p>Zielland, Shops, Spieleindex und Benachrichtigungen</p></div>
      <SaveIndicator auto={auto} />
    </header>
    {location.protocol === 'http:' && <div className="set-banner" role="note">
      <Icon name="alert" />
      <span>Verbindung ohne HTTPS. Passphrase und Sitzung sind im Heimnetz mitlesbar. <span className="set-banner-more">Für den Dauerbetrieb einen Reverse Proxy mit HTTPS einrichten.</span></span>
      <a href={OPERATIONS_GUIDE} target="_blank" rel="noopener noreferrer">Anleitung<span className="sr-only"> (öffnet in neuem Tab)</span></a>
    </div>}
    <div className="set-body">
      <div className="set-nav" role="tablist" aria-label="Einstellungsbereiche" aria-orientation="vertical" onKeyDown={keys}>
        {sections.map(item => <button key={item.id} ref={node => { if (node) tabs.current.set(item.id, node); else tabs.current.delete(item.id); }}
          type="button" role="tab" id={`settings-tab-${item.id}`} aria-label={item.label} aria-describedby={`settings-hint-${item.id}`} aria-selected={section === item.id}
          aria-controls="settings-panel" tabIndex={section === item.id ? 0 : -1} onClick={() => open(item.id)}>
          <span className="set-nav-label">{item.label}</span>
          <span className="set-nav-hint" id={`settings-hint-${item.id}`}>{hints[item.id]}</span>
        </button>)}
      </div>
      <div id="settings-panel" className="set-panel" role="tabpanel" aria-labelledby={`settings-tab-${section}`} tabIndex={0} data-section={section}>
        {section === 'general' && <General settings={settings} countries={countries} edit={auto.edit} onError={onError} />}
        {section === 'shops' && <Shops settings={settings} feeDraft={auto.feeDraft} edit={auto.edit} editFee={auto.editFee} settle={auto.settle} status={fetched.data?.shops}
          csrf={csrf} onShopsChanged={onShopsChanged} onHelp={onHelp} onError={onError} />}
        {section === 'index' && <Index settings={settings} edit={auto.edit} igdbState={igdbState} igdbConfigured={sourceStatus?.igdb?.configured} csrf={csrf} onChanged={onSourcesChanged} onError={onError} />}
        {section === 'notifications' && <Notifications overview={alerts.data} failed={alerts.failed} csrf={csrf} reload={alerts.reload} onError={onError} />}
        {section === 'status' && <FetchPanel data={fetched.data} failed={fetched.failed} loadedAt={fetched.loadedAt} reload={fetched.reload} />}
        {section === 'system' && <System onLogout={onLogout} busy={busy} />}
      </div>
    </div>
  </div>;
}
