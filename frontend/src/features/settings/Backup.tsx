import { useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { api, HttpError } from '../../api';
import type { WishlistItem } from '../../api';
import { notify } from '../../notify';
import { Button, ConfirmDialog, Help, Icon, Notice } from '../../components';
import { downloadJson, wishlistExport } from '../wishlist-export';
import { IMPORT_MAX_BYTES, importInChunks, importSummary, parseWishlistFile } from '../wishlist-import';
import { PLATFORMS, platformName } from '../catalog-ui';
import type { ImportReport, ImportStatus } from '../wishlist-import';
import { appVersion } from '../../version';
import { Facts, SettingsPanel } from './parts';

type Props = {
  csrf: string;
  onError: (error: unknown) => void;
};

/** What the dialog shows: the file is being checked, the preview of the result, or why the file cannot be imported. */
type Import = { items: unknown[]; report: ImportReport | null; error: string };

const rows: { status: ImportStatus; label: string }[] = [
  { status: 'added', label: 'werden hinzugefügt' },
  { status: 'existing', label: 'sind schon auf der Liste' },
  { status: 'library', label: 'sind in der Bibliothek' },
  { status: 'unknown', label: 'sind unbekannt oder nicht unterstützt' },
  { status: 'invalid', label: 'sind ungültig' },
];
const SHOWN_PROBLEMS = 6;

/** Sends the entries in parts; with `dryRun` the server only reports what would happen. */
function importWishlist(items: unknown[], dryRun: boolean, csrf: string): Promise<ImportReport> {
  return importInChunks(items, PLATFORMS.map(platformName), chunk =>
    api<ImportReport>('/wishlist/import', 'POST', { version: 1, items: chunk, dry_run: dryRun }, csrf),
  );
}

/** Einstellungen › System › Sichern & Wiederherstellen (PROD-01): export and import of the wishlist, and where the full backup lives. */
export default function Backup({ csrf, onError }: Props) {
  const [exporting, setExporting] = useState(false);
  const [job, setJob] = useState<Import | null>(null);
  const [importing, setImporting] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  async function exportList() {
    setExporting(true);
    try {
      const wishes = await api<WishlistItem[]>('/wishlist');
      downloadJson('keyhunter-wunschliste.json', wishlistExport(wishes));
    } catch (e) {
      onError(e);
    } finally {
      setExporting(false);
    }
  }

  /** Reads the file and asks the server what an import would do, without changing anything. */
  async function choose(event: ChangeEvent<HTMLInputElement>) {
    const picked = event.target.files?.[0];
    event.target.value = '';
    if (!picked) return;
    if (picked.size > IMPORT_MAX_BYTES) {
      setJob({ items: [], report: null, error: 'Die Datei ist größer als 2 MB.' });
      return;
    }
    const parsed = parseWishlistFile(await picked.text());
    if ('error' in parsed) {
      setJob({ items: [], report: null, error: parsed.error });
      return;
    }
    setJob({ items: parsed.items, report: null, error: '' });
    try {
      const report = await importWishlist(parsed.items, true, csrf);
      setJob(current => current && { ...current, report });
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) onError(e);
      else setJob(current => current && { ...current, error: e instanceof Error ? e.message : 'Die Datei konnte nicht geprüft werden.' });
    }
  }

  async function confirm() {
    if (!job) return;
    setImporting(true);
    try {
      const report = await importWishlist(job.items, false, csrf);
      setJob(null);
      notify(importSummary(report));
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) onError(e);
      else setJob({ ...job, error: `${e instanceof Error ? e.message : 'Der Import ist fehlgeschlagen.'} Ein zweiter Import ergänzt, was fehlt.` });
    } finally {
      setImporting(false);
    }
  }

  const report = job?.report ?? null;
  const problems = report?.results.filter(r => r.status === 'library' || r.status === 'unknown' || r.status === 'invalid') ?? [];
  return (
    <>
      <SettingsPanel
        title="Sichern & Wiederherstellen"
        titleId="backup-title"
        aside={
          <Help label="Hilfe zu Sichern und Wiederherstellen">
            <span>
              Export und Import betreffen nur die Wunschliste: Titel, Plattform und IGDB-ID. Preise, Zuordnungen, Alarme und Einstellungen sind nicht darin.
            </span>
            <span>
              Der Import fügt nur hinzu. Nichts wird gelöscht oder überschrieben, Spiele aus der Bibliothek bleiben dort, und ein zweiter Import derselben Datei
              ändert nichts.
            </span>
            <span>
              Vollständig sichern heißt: Container stoppen und das Datenverzeichnis (Unraid: das Appdata-Verzeichnis) kopieren. Es enthält Datenbank,
              Zugangsdaten und die Sicherungen, die KeyHunter vor jeder Migration unter <code>backups</code> ablegt (die drei neuesten). Die Schritte stehen in
              der Dokumentation unter „Backup und Update“.
            </span>
          </Help>
        }
      >
        <div className="form-grid">
          <div className="set-row">
            <div className="with-help">
              <h3 className="set-row-title">Wunschliste exportieren</h3>
              <Help label="Hilfe zum Export">Titel, Plattform, IGDB-ID, Art und Prüfstatus als JSON-Datei.</Help>
            </div>
            <Button loading={exporting} onClick={() => void exportList()}>
              <Icon name="download" />
              Exportieren
            </Button>
          </div>
          <div className="set-row">
            <div className="with-help">
              <h3 className="set-row-title">Wunschliste importieren</h3>
              <Help label="Hilfe zum Import">
                <span>Wähle eine Datei aus dem Export. Vor dem Hinzufügen siehst du, was passiert.</span>
                <span>
                  Die Shops durchsucht KeyHunter danach im normalen Abruftempo, nicht alle Spiele auf einmal: So bleibt das Tagesbudget für die übrigen Preise.
                  Mit „Jetzt prüfen“ suchst du ein Spiel sofort.
                </span>
              </Help>
            </div>
            <input
              ref={file}
              type="file"
              accept=".json,application/json"
              className="sr-only"
              aria-label="Datei der Wunschliste wählen"
              tabIndex={-1}
              onChange={event => void choose(event)}
            />
            <Button onClick={() => file.current?.click()}>
              <Icon name="upload" />
              Datei wählen …
            </Button>
          </div>
        </div>
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
        open={job !== null}
        title="Wunschliste importieren"
        confirmLabel={report && report.counts.added > 0 ? `${report.counts.added} hinzufügen` : 'Hinzufügen'}
        cancelLabel={job?.report === null && job.error ? 'Schließen' : 'Abbrechen'}
        busy={importing}
        confirmDisabled={!report || report.counts.added === 0}
        onCancel={() => setJob(null)}
        onConfirm={() => void confirm()}
      >
        {job?.error && <Notice error>{job.error}</Notice>}
        {job && !job.error && !report && <p>Die Datei wird geprüft …</p>}
        {report && (
          <>
            <p>Das passiert mit den {report.results.length} Einträgen der Datei:</p>
            <ul className="import-counts" aria-label="Ergebnis des Imports">
              {rows.map(row => (
                <li key={row.status} data-status={row.status}>
                  <strong>{report.counts[row.status]}</strong> {row.label}
                </li>
              ))}
            </ul>
            {problems.length > 0 && (
              <ul className="import-problems" aria-label="Übersprungene Einträge">
                {problems.slice(0, SHOWN_PROBLEMS).map((entry, index) => (
                  <li key={index}>
                    <span>{entry.title || 'Ohne Titel'}</span> <span className="muted">{entry.message}</span>
                  </li>
                ))}
                {problems.length > SHOWN_PROBLEMS && <li className="muted">und {problems.length - SHOWN_PROBLEMS} weitere</li>}
              </ul>
            )}
          </>
        )}
      </ConfirmDialog>
    </>
  );
}
