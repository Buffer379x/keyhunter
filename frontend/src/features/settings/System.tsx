import { useState } from 'react';
import type { FormEvent } from 'react';
import { api, HttpError } from '../../api';
import { notify } from '../../notify';
import { Button, ConfirmDialog, Help, Icon, Notice } from '../../components';
import { appVersion } from '../../version';
import { Facts, SettingsPanel } from './parts';

type Props = {
  csrf: string;
  busy: boolean;
  onLogout: () => void;
  /** Every session ended ("Überall abmelden"): back to the sign-in. */
  onSignedOut: () => void;
  onError: (error: unknown) => void;
};

const sessions = (count: number) => `${count} ${count === 1 ? 'Sitzung' : 'Sitzungen'}`;

export default function System({ csrf, busy, onLogout, onSignedOut, onError }: Props) {
  const [changing, setChanging] = useState(false);
  const [confirmEverywhere, setConfirmEverywhere] = useState(false);
  const [ending, setEnding] = useState(false);
  const [endError, setEndError] = useState('');

  async function changePassphrase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const current = String(fields.get('current') ?? '');
    const next = String(fields.get('new') ?? '');
    const length = Array.from(next).length;
    if (length < 12 || length > 128) {
      notify('Die neue Passphrase muss 12 bis 128 Zeichen haben.', 'error');
      return;
    }
    if (next !== String(fields.get('confirm') ?? '')) {
      notify('Die neuen Passphrasen stimmen nicht überein.', 'error');
      return;
    }
    setChanging(true);
    try {
      const { ended_sessions: ended } = await api<{ ended_sessions: number }>('/session/passphrase', 'PUT', { current, new: next }, csrf);
      form.reset();
      notify(ended > 0 ? `Passphrase geändert, ${sessions(ended)} auf anderen Geräten beendet.` : 'Passphrase geändert.');
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) onError(e);
      else notify(e instanceof Error ? e.message : 'Die Passphrase konnte nicht geändert werden.', 'error');
    } finally {
      setChanging(false);
    }
  }

  async function signOutEverywhere() {
    setEnding(true);
    setEndError('');
    try {
      await api('/sessions', 'DELETE', undefined, csrf);
      setConfirmEverywhere(false);
      onSignedOut();
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) onError(e);
      else setEndError(e instanceof Error ? e.message : 'Die Sitzungen konnten nicht beendet werden.');
    } finally {
      setEnding(false);
    }
  }

  return (
    <>
      <SettingsPanel
        title="Sicherheit"
        titleId="security-title"
        aside={
          <Help label="Hilfe zur Sicherheit">
            <span>Abmelden beendet die Sitzung in diesem Browser.</span>
            <span>Überall abmelden beendet alle Sitzungen auf allen Geräten, auch diese, etwa nach dem Verlust eines Geräts.</span>
          </Help>
        }
      >
        <div className="form-grid">
          <div className="set-actions">
            <Button loading={busy} onClick={onLogout}>
              <Icon name="logout" />
              Abmelden
            </Button>
            <Button variant="danger" disabled={busy || ending} onClick={() => setConfirmEverywhere(true)}>
              Überall abmelden
            </Button>
          </div>
        </div>
      </SettingsPanel>
      <SettingsPanel
        title="Passphrase ändern"
        titleId="passphrase-title"
        aside={
          <Help label="Hilfe zur Passphrase">
            <span>Die neue Passphrase braucht 12 bis 128 Zeichen, gerne mehrere Wörter.</span>
            <span>Die Sitzung in diesem Browser bleibt bestehen, alle anderen Geräte werden abgemeldet.</span>
          </Help>
        }
      >
        <form className="form-grid" method="post" onSubmit={event => void changePassphrase(event)}>
          <div className="form-row">
            <label htmlFor="current-passphrase">Aktuelle Passphrase</label>
            <input id="current-passphrase" name="current" type="password" autoComplete="current-password" required disabled={changing} />
          </div>
          <div className="set-two">
            <div className="form-row">
              <label htmlFor="new-passphrase">Neue Passphrase</label>
              <input id="new-passphrase" name="new" type="password" autoComplete="new-password" required disabled={changing} />
            </div>
            <div className="form-row">
              <label htmlFor="new-passphrase-confirm">Neue Passphrase wiederholen</label>
              <input id="new-passphrase-confirm" name="confirm" type="password" autoComplete="new-password" required disabled={changing} />
            </div>
          </div>
          <div className="set-actions">
            <Button type="submit" variant="primary" loading={changing}>
              Passphrase ändern
            </Button>
          </div>
        </form>
      </SettingsPanel>
      <SettingsPanel
        title="Daten und Backup"
        titleId="backup-title"
        aside={
          <Help label="Hilfe zum Backup">
            Für ein vollständiges Backup den Container stoppen und das Datenverzeichnis sichern. Die Datenbank darf nicht auf einer Netzwerkfreigabe liegen.
          </Help>
        }
      >
        <Facts
          items={[
            {
              label: 'Sicherung',
              value: (
                <>
                  automatisch vor jeder Migration in <code>&lt;Daten&gt;/backups</code>
                </>
              ),
            },
            { label: 'Version', value: <span className="mono app-version">{appVersion}</span> },
          ]}
        />
      </SettingsPanel>
      <ConfirmDialog
        open={confirmEverywhere}
        title="Überall abmelden?"
        confirmLabel="Überall abmelden"
        danger
        busy={ending}
        onCancel={() => {
          setConfirmEverywhere(false);
          setEndError('');
        }}
        onConfirm={() => void signOutEverywhere()}
      >
        <p>Alle Sitzungen enden, auch die in diesem Browser. Danach meldest du dich überall neu an.</p>
        {endError && <Notice error>{endError}</Notice>}
      </ConfirmDialog>
    </>
  );
}
