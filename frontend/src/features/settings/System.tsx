import { Button, Icon } from '../../components';
import { appVersion } from '../../version';
import { Facts, SectionCard } from './parts';

export default function System({ onLogout, busy }: { onLogout: () => void; busy: boolean }) {
  return <>
    <SectionCard title="Sicherheit" titleId="security-title">
      <div className="set-row-inline">
        <p className="set-hint">Abmelden beendet die Sitzung in diesem Browser.</p>
        <Button variant="secondary" loading={busy} onClick={onLogout}><Icon name="logout" size={16} />Abmelden</Button>
      </div>
    </SectionCard>
    <SectionCard title="Daten und Backup" titleId="backup-title">
      <Facts items={[
        { label: 'Sicherung', value: <>automatisch vor jeder Migration in <code>&lt;Daten&gt;/backups</code></> },
        { label: 'Version', value: appVersion },
      ]} />
      <p className="set-hint">Für ein vollständiges Backup den Container stoppen und das Datenverzeichnis sichern. Die Datenbank darf nicht auf einer Netzwerkfreigabe liegen.</p>
    </SectionCard>
  </>;
}
