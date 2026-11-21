import { useEffect, useState } from 'react';
import type { Settings, SourceStatuses } from '../api';
import { Button, Icon } from '../components';
import General from './settings/General';
import Shops from './settings/Shops';
import Index from './settings/Index';
import Notifications from './settings/Notifications';
import FetchPanel from './settings/FetchPanel';
import System from './settings/System';
import { useAlertOverview, useFetchStatus } from './settings/data';
import type { SettingsDraft } from './settings/draft';
import { sectionLabel } from './settings/sections';
import type { Section } from './settings/sections';
import '../styles/settings.css';

const OPERATIONS_GUIDE = 'https://github.com/Buffer379x/keyhunter/blob/main/docs/operations.md';

/** One line under the page title of each section (prototype page-head). */
const subtitles: Record<Section, string> = {
  general: 'Zielland, Spalten der Wunschliste und Export',
  shops: 'Welche Shops KeyHunter abfragt und wie oft',
  index: 'Spielesuche, Editionen und Cover über IGDB',
  notifications: 'Push-Nachrichten für Preisalarme über ntfy',
  status: 'Wie viel KeyHunter heute abgefragt hat und was als Nächstes kommt',
  system: 'Sitzung, Datensicherung und Version',
};

interface Props {
  /** The open section; the sidebar navigation chooses it and keeps it in the URL. */
  section: Section;
  settings: Settings; auto: SettingsDraft; csrf: string; countries: { code: string; name: string }[];
  sourceStatus: SourceStatuses | null; busy: boolean;
  onSection: (section: Section) => void;
  onSourcesChanged: () => void; onShopsChanged: (saved: Settings) => void; onError: (error: unknown) => void; onHelp: () => void; onLogout: () => void;
}

/**
 * Save bar in the page head: changes stay a draft until "Speichern"; "Verwerfen" returns to the saved state.
 * While something is unsaved the page head stays visible when scrolling (sticky), so the button is always at hand.
 */
function SaveBar({ auto }: { auto: SettingsDraft }) {
  const { state, error, dirty, save, discard } = auto;
  const [done, setDone] = useState(false);
  useEffect(() => { if (!done) return; const timer = window.setTimeout(() => setDone(false), 3000); return () => window.clearTimeout(timer); }, [done]);
  async function submit() { if (await save()) setDone(true); }
  return <div className={`set-save ${state}`}>
    <span role="status" className="label">
      {state === 'saving' ? <><span className="spinner" aria-hidden="true" />Wird gespeichert …</>
        : dirty ? <><i className="dot" aria-hidden="true" />Nicht gespeichert</>
          : done ? <><Icon name="check" size={14} />Gespeichert</> : null}
    </span>
    {dirty && <Button variant="ghost" disabled={state === 'saving'} onClick={discard}>Verwerfen</Button>}
    <Button variant="primary" disabled={!dirty} loading={state === 'saving'} onClick={() => void submit()}>Speichern</Button>
    {state === 'error' && <span className="set-save-error" role="alert">{error}</span>}
  </div>;
}

export default function SettingsPage({ section, settings, auto, csrf, countries, sourceStatus, busy, onSection, onSourcesChanged, onShopsChanged, onError, onHelp, onLogout }: Props) {
  const fetched = useFetchStatus(section === 'shops' || section === 'status');
  const alerts = useAlertOverview();
  const igdbState = sourceStatus?.igdb?.state;

  // Sections whose controls belong to the draft; the others (alarms, status, system) save their own way.
  const drafted = section === 'general' || section === 'shops' || section === 'index';
  return <div className={`page settings-page${auto.dirty ? ' unsaved' : ''}`}>
    <header className="page-head">
      <div><h1>{sectionLabel(section)}</h1><p>{subtitles[section]}</p></div>
      {(drafted || auto.dirty) && <SaveBar auto={auto} />}
    </header>
    {location.protocol === 'http:' && <div className="note warn" role="note">
      <Icon name="alert" />
      <span><b>Verbindung ohne HTTPS.</b> Passphrase und Sitzung sind im Heimnetz mitlesbar. Für den Dauerbetrieb einen Reverse Proxy mit HTTPS einrichten.{' '}
        <a href={OPERATIONS_GUIDE} target="_blank" rel="noopener noreferrer">Anleitung<span className="sr-only"> (öffnet in neuem Tab)</span></a></span>
    </div>}
    <div id="settings-panel" className="set-panel" data-section={section}>
      {section === 'general' && <General settings={settings} countries={countries} edit={auto.edit} onError={onError} />}
      {section === 'shops' && <Shops settings={settings} feeDraft={auto.feeDraft} edit={auto.edit} editFee={auto.editFee} dirty={auto.dirty} status={fetched.data?.shops}
        csrf={csrf} onShopsChanged={onShopsChanged} onHelp={onHelp} onError={onError} />}
      {section === 'index' && <Index settings={settings} edit={auto.edit} igdbState={igdbState} igdbConfigured={sourceStatus?.igdb?.configured} csrf={csrf} onChanged={onSourcesChanged} onError={onError} />}
      {section === 'notifications' && <Notifications overview={alerts.data} failed={alerts.failed} csrf={csrf} reload={alerts.reload} onError={onError} />}
      {section === 'status' && <FetchPanel data={fetched.data} failed={fetched.failed} loadedAt={fetched.loadedAt} intervals={Object.fromEntries(settings.sources.map(s => [s.id, s.poll_interval_seconds]))}
        csrf={csrf} onChanged={fetched.reload} onShops={() => onSection('shops')} />}
      {section === 'system' && <System onLogout={onLogout} busy={busy} />}
    </div>
  </div>;
}
