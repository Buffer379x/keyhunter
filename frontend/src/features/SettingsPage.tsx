import { useEffect, useState } from 'react';
import type { Settings, SourceStatuses } from '../api';
import { Button, Icon, IconButton, TabPanel, Tabs } from '../components';
import General from './settings/General';
import Shops from './settings/Shops';
import Index from './settings/Index';
import Notifications from './settings/Notifications';
import FetchPanel from './settings/FetchPanel';
import System from './settings/System';
import { useFetchStatus } from './settings/data';
import type { SettingsDraft } from './settings/draft';
import Log from './settings/Log';
import { sections } from './settings/sections';
import type { Section } from './settings/sections';
import '../styles/settings.css';

const OPERATIONS_GUIDE = 'https://github.com/Buffer379x/keyhunter/blob/main/docs/operations.md';
/** The HTTPS notice, once closed, stays closed in this browser (0.9.0). */
const HTTPS_SEEN = 'keyhunter.httpsNotice.dismissed';
const readSeen = () => {
  try {
    return localStorage.getItem(HTTPS_SEEN) === '1';
  } catch {
    return false;
  }
};

interface Props {
  /** The open tab; kept in the URL. */
  section: Section;
  settings: Settings;
  auto: SettingsDraft;
  csrf: string;
  countries: { code: string; name: string }[];
  sourceStatus: SourceStatuses | null;
  busy: boolean;
  onSection: (section: Section) => void;
  onSourcesChanged: () => void;
  onError: (error: unknown) => void;
  onLogout: () => void;
  /** Every session ended ("Überall abmelden"). */
  onSignedOut: () => void;
}

/**
 * Save bar in the page head: changes stay a draft until "Speichern"; "Verwerfen" returns to the saved state.
 * While something is unsaved the page head stays visible when scrolling (sticky), so the button is always at hand.
 */
function SaveBar({ auto }: { auto: SettingsDraft }) {
  const { state, error, dirty, save, discard } = auto;
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const timer = window.setTimeout(() => setDone(false), 3000);
    return () => window.clearTimeout(timer);
  }, [done]);
  async function submit() {
    if (await save()) setDone(true);
  }
  return (
    <div className={`set-save ${state}`}>
      <span role="status" className="label">
        {state === 'saving' ? (
          <>
            <span className="spinner" aria-hidden="true" />
            Wird gespeichert …
          </>
        ) : dirty ? (
          <>
            <i className="dot" aria-hidden="true" />
            Nicht gespeichert
          </>
        ) : done ? (
          <>
            <Icon name="check" size={14} />
            Gespeichert
          </>
        ) : null}
      </span>
      {dirty && (
        <Button variant="ghost" disabled={state === 'saving'} onClick={discard}>
          Verwerfen
        </Button>
      )}
      <Button variant="primary" disabled={!dirty} loading={state === 'saving'} onClick={() => void submit()}>
        Speichern
      </Button>
      {state === 'error' && (
        <span className="set-save-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

export default function SettingsPage({
  section,
  settings,
  auto,
  csrf,
  countries,
  sourceStatus,
  busy,
  onSection,
  onSourcesChanged,
  onError,
  onLogout,
  onSignedOut,
}: Props) {
  const fetched = useFetchStatus(section === 'shops' || section === 'status');
  const [httpsSeen, setHttpsSeen] = useState(readSeen);
  const dismissHttps = () => {
    setHttpsSeen(true);
    try {
      localStorage.setItem(HTTPS_SEEN, '1');
    } catch {
      /* closed for this visit */
    }
  };
  const igdbState = sourceStatus?.igdb?.state;

  // Sections whose controls belong to the draft; the others (alarms, status, system) save their own way.
  const drafted = section === 'general' || section === 'shops' || section === 'index';
  return (
    <div className={`page settings-page${auto.dirty ? ' unsaved' : ''}`}>
      <header className="page-head">
        <div>
          <h1>Einstellungen</h1>
        </div>
        {(drafted || auto.dirty) && <SaveBar auto={auto} />}
      </header>
      <Tabs
        id="settings"
        label="Einstellungen"
        className="set-tabs"
        value={section}
        onChange={id => onSection(id as Section)}
        items={sections.map(({ id, label, icon }) => ({ id, label, icon }))}
      />
      {location.protocol === 'http:' && !httpsSeen && (
        <div className="note warn" role="note">
          <Icon name="alert" />
          <span>
            <b>Verbindung ohne HTTPS.</b> Passphrase und Sitzung sind im Heimnetz mitlesbar. Für den Dauerbetrieb einen Reverse Proxy mit HTTPS einrichten.{' '}
            <a href={OPERATIONS_GUIDE} target="_blank" rel="noopener noreferrer">
              Anleitung<span className="sr-only"> (öffnet in neuem Tab)</span>
            </a>
          </span>
          <IconButton className="note-close" variant="ghost" label="Hinweis ausblenden" onClick={dismissHttps}>
            <Icon name="x" />
          </IconButton>
        </div>
      )}
      {sections.map(({ id }) => (
        <TabPanel key={id} id="settings" tab={id} value={section}>
          <div id="settings-panel" className="set-panel" data-section={id}>
            {id === 'general' && <General settings={settings} countries={countries} edit={auto.edit} onError={onError} />}
            {id === 'shops' && <Shops settings={settings} feeDraft={auto.feeDraft} edit={auto.edit} editFee={auto.editFee} status={fetched.data?.shops} />}
            {id === 'index' && (
              <Index
                settings={settings}
                edit={auto.edit}
                igdbState={igdbState}
                igdbConfigured={sourceStatus?.igdb?.configured}
                csrf={csrf}
                onChanged={onSourcesChanged}
                onError={onError}
              />
            )}
            {id === 'notifications' && <Notifications csrf={csrf} onError={onError} />}
            {id === 'status' && (
              <FetchPanel
                data={fetched.data}
                failed={fetched.failed}
                loadedAt={fetched.loadedAt}
                intervals={Object.fromEntries(settings.sources.map(s => [s.id, s.poll_interval_seconds]))}
                onShops={() => onSection('shops')}
              />
            )}
            {id === 'log' && <Log />}
            {id === 'system' && <System csrf={csrf} busy={busy} onLogout={onLogout} onSignedOut={onSignedOut} onError={onError} />}
          </div>
        </TabPanel>
      ))}
    </div>
  );
}
