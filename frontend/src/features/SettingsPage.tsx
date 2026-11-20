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
import { sectionLabel } from './settings/sections';
import type { Section } from './settings/sections';
import '../styles/settings.css';

const OPERATIONS_GUIDE = 'https://github.com/Buffer379x/keyhunter/blob/main/docs/operations.md';

/** One line under the page title of each section (prototype page-head). */
const subtitles: Record<Section, string> = {
  general: 'Zielland, Preisanzeige und Export',
  shops: 'Welche Shops KeyHunter abfragt und wie oft',
  index: 'Spielesuche, Editionen und Cover über IGDB',
  notifications: 'Push-Nachrichten für Preisalarme über ntfy',
  status: 'Wie viel KeyHunter heute abgefragt hat und was als Nächstes kommt',
  system: 'Sitzung, Datensicherung und Version',
};

interface Props {
  /** The open section; the sidebar navigation chooses it and keeps it in the URL. */
  section: Section;
  settings: Settings; auto: Autosave; csrf: string; countries: { code: string; name: string }[];
  sourceStatus: SourceStatuses | null; busy: boolean;
  onSection: (section: Section) => void;
  onSourcesChanged: () => void; onShopsChanged: (saved: Settings) => void; onError: (error: unknown) => void; onHelp: () => void; onLogout: () => void;
}

function SaveIndicator({ auto }: { auto: Autosave }) {
  const { state, error, retryable, retry } = auto;
  return <div className={`set-save ${state}`}>
    <span role="status" className="label">
      {state === 'saved' ? <><i className="dot" aria-hidden="true" />Alle Änderungen gespeichert</>
        : state === 'error' ? <><Icon name="alert" size={14} />Nicht gespeichert</>
          : <><span className="spinner" aria-hidden="true" />Wird gespeichert …</>}
    </span>
    {state === 'error' && <span className="set-save-error" role="alert">{error}{retryable && <Button variant="ghost" size="sm" onClick={retry}>Erneut versuchen</Button>}</span>}
  </div>;
}

export default function SettingsPage({ section, settings, auto, csrf, countries, sourceStatus, busy, onSection, onSourcesChanged, onShopsChanged, onError, onHelp, onLogout }: Props) {
  const fetched = useFetchStatus(section === 'shops' || section === 'status');
  const alerts = useAlertOverview();
  const igdbState = sourceStatus?.igdb?.state;

  return <div className="page settings-page">
    <header className="page-head">
      <div><h1>{sectionLabel(section)}</h1><p>{subtitles[section]}</p></div>
      <SaveIndicator auto={auto} />
    </header>
    {location.protocol === 'http:' && <div className="note warn" role="note">
      <Icon name="alert" />
      <span><b>Verbindung ohne HTTPS.</b> Passphrase und Sitzung sind im Heimnetz mitlesbar. Für den Dauerbetrieb einen Reverse Proxy mit HTTPS einrichten.{' '}
        <a href={OPERATIONS_GUIDE} target="_blank" rel="noopener noreferrer">Anleitung<span className="sr-only"> (öffnet in neuem Tab)</span></a></span>
    </div>}
    <div id="settings-panel" className="set-panel" data-section={section}>
      {section === 'general' && <General settings={settings} countries={countries} edit={auto.edit} onError={onError} />}
      {section === 'shops' && <Shops settings={settings} feeDraft={auto.feeDraft} edit={auto.edit} editFee={auto.editFee} settle={auto.settle} status={fetched.data?.shops}
        csrf={csrf} onShopsChanged={onShopsChanged} onHelp={onHelp} onError={onError} />}
      {section === 'index' && <Index settings={settings} edit={auto.edit} igdbState={igdbState} igdbConfigured={sourceStatus?.igdb?.configured} csrf={csrf} onChanged={onSourcesChanged} onError={onError} />}
      {section === 'notifications' && <Notifications overview={alerts.data} failed={alerts.failed} csrf={csrf} reload={alerts.reload} onError={onError} />}
      {section === 'status' && <FetchPanel data={fetched.data} failed={fetched.failed} loadedAt={fetched.loadedAt} onShops={() => onSection('shops')} />}
      {section === 'system' && <System onLogout={onLogout} busy={busy} />}
    </div>
  </div>;
}
