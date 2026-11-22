import { Button, Help, Icon } from '../../components';
import { appVersion } from '../../version';
import { Facts, SettingsPanel } from './parts';

export default function System({ onLogout, busy }: { onLogout: () => void; busy: boolean }) {
  return <>
    <SettingsPanel title="Sicherheit" titleId="security-title" aside={<Help label="Hilfe zur Sicherheit">Abmelden beendet die Sitzung in diesem Browser.</Help>}>
      <div className="form-grid">
        <div className="set-actions"><Button loading={busy} onClick={onLogout}><Icon name="logout" />Abmelden</Button></div>
      </div>
    </SettingsPanel>
    <SettingsPanel title="Daten und Backup" titleId="backup-title"
      aside={<Help label="Hilfe zum Backup">Für ein vollständiges Backup den Container stoppen und das Datenverzeichnis sichern. Die Datenbank darf nicht auf einer Netzwerkfreigabe liegen.</Help>}>
      <Facts items={[
        { label: 'Sicherung', value: <>automatisch vor jeder Migration in <code>&lt;Daten&gt;/backups</code></> },
        { label: 'Version', value: <span className="mono">{appVersion}</span> },
      ]} />
    </SettingsPanel>
  </>;
}
