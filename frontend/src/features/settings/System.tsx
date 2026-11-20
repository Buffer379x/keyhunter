import { Button, Icon } from '../../components';
import { appVersion } from '../../version';
import { Facts, SettingsPanel } from './parts';

export default function System({ onLogout, busy }: { onLogout: () => void; busy: boolean }) {
  return <>
    <SettingsPanel title="Sicherheit" titleId="security-title">
      <div className="form-grid">
        <div className="set-row">
          <p className="hint">Abmelden beendet die Sitzung in diesem Browser.</p>
          <Button loading={busy} onClick={onLogout}><Icon name="logout" />Abmelden</Button>
        </div>
      </div>
    </SettingsPanel>
    <SettingsPanel title="Daten und Backup" titleId="backup-title">
      <Facts items={[
        { label: 'Sicherung', value: <>automatisch vor jeder Migration in <code>&lt;Daten&gt;/backups</code></> },
        { label: 'Version', value: <span className="mono">{appVersion}</span> },
      ]} />
      <p className="hint set-pad">Für ein vollständiges Backup den Container stoppen und das Datenverzeichnis sichern. Die Datenbank darf nicht auf einer Netzwerkfreigabe liegen.</p>
    </SettingsPanel>
  </>;
}
