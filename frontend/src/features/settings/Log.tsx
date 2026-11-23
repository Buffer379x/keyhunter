import type { LogLevel, LogPage } from '../../api';
import { Help, Inset, Label, Panel, PanelHead, Pill } from '../../components';
import { Pager, PagedTools, usePaged } from './paged';

type LevelFilter = '' | LogLevel;
const levels: { value: LevelFilter; label: string }[] = [
  { value: '', label: 'Alle' },
  { value: 'info', label: 'Info' },
  { value: 'warn', label: 'Warnung' },
  { value: 'error', label: 'Fehler' },
];
const levelPill = {
  info: { tone: 'dim', icon: 'info', text: 'Info' },
  warn: { tone: 'warn', icon: 'alert', text: 'Warnung' },
  error: { tone: 'danger', icon: 'alert', text: 'Fehler' },
} as const;
const when = (seconds: number) =>
  new Date(seconds * 1000).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Einstellungen › Log (0.8.3): what happened in KeyHunter in the last 7 days, newest first, by level and full text. */
export default function Log() {
  const list = usePaged<LogPage, LevelFilter>(
    '/log',
    'level',
    'keyhunter.list.log',
    levels.map(l => l.value),
    '',
  );
  const level = list.filter;
  const { data } = list;
  return (
    <Panel aria-labelledby="log-title" className="paged">
      <PanelHead className="paged-title">
        <Label as="h2" tone="soft" id="log-title">
          Ereignisse · 7 Tage
        </Label>
        <Help label="Hilfe zum Log">
          <span>
            Anmeldungen, Änderungen an Wunschliste, Bibliothek, Warenkorb und Einstellungen, bestätigte oder gelöschte Zuordnungen, Benachrichtigungen und
            Fehler beim Abruf.
          </span>
          <span>Einträge bleiben 7 Tage, dann löscht KeyHunter den ältesten automatisch. Passphrase, Zugangsdaten und Tokens stehen nie im Log.</span>
        </Help>
      </PanelHead>
      <PagedTools
        label="Log"
        filter={level}
        filters={levels}
        onFilter={list.setFilter}
        text={list.text}
        onText={list.setText}
        placeholder="Meldung, Bereich …"
        perPage={list.perPage}
        onPerPage={list.setPerPage}
      />
      {/* RESP-20: a table that scrolls sideways can be reached and scrolled with the keyboard */}
      <Inset className="table-wrap" tabIndex={0} role="region" aria-label="Ereignistabelle">
        {!data ? (
          <p className="hint set-pad" role="status">
            {list.failed ? 'Das Log konnte nicht gelesen werden.' : 'Log wird geladen …'}
          </p>
        ) : data.entries.length === 0 ? (
          <p className="hint set-pad">{level || list.text.trim() ? 'Kein Eintrag passt zu diesem Filter.' : 'Noch keine Ereignisse aufgezeichnet.'}</p>
        ) : (
          <table aria-label="Ereignisse" className="log-table">
            <thead>
              <tr>
                <th>Zeit</th>
                <th>Stufe</th>
                <th>Bereich</th>
                <th>Meldung</th>
              </tr>
            </thead>
            <tbody>
              {data.entries.map(entry => {
                const pill = levelPill[entry.level] ?? levelPill.info;
                return (
                  <tr key={entry.id} className={`lv-${entry.level}`}>
                    <td className="mono">{when(entry.at)}</td>
                    <td>
                      <Pill tone={pill.tone} icon={pill.icon}>
                        {pill.text}
                      </Pill>
                    </td>
                    <td>{entry.area}</td>
                    <td className="log-msg">{entry.message}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Inset>
      {data && data.total > 0 && <Pager label="Log" total={data.total} page={list.page} perPage={list.perPage} onPage={list.setPage} />}
      {list.failed && data && (
        <p className="hint set-pad" role="status">
          Aktualisierung fehlgeschlagen, angezeigt wird der letzte Stand.
        </p>
      )}
    </Panel>
  );
}
