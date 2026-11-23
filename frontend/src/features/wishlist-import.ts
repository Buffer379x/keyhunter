/** Entries one request carries; the server refuses more (PROD-01), longer files go in several requests. */
export const IMPORT_CHUNK = 100;
export const IMPORT_MAX_ENTRIES = 1000;
export const IMPORT_MAX_BYTES = 2 * 1024 * 1024;

export type ImportStatus = 'added' | 'existing' | 'library' | 'unknown' | 'invalid';
export interface ImportEntryResult {
  title: string;
  platform: string;
  status: ImportStatus;
  message?: string;
}
export interface ImportReport {
  counts: Record<ImportStatus, number>;
  results: ImportEntryResult[];
}

/** The entries of an export file (`wishlist-export.ts`, version 1), or the reason it cannot be imported. */
export function parseWishlistFile(text: string): { items: unknown[] } | { error: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { error: 'Die Datei ist kein gültiges JSON.' };
  }
  const file = data as { version?: unknown; items?: unknown } | null;
  if (typeof file !== 'object' || file === null || file.version !== 1 || !Array.isArray(file.items)) {
    return { error: 'Das ist keine Wunschlisten-Datei aus dem Export von KeyHunter.' };
  }
  if (file.items.length > IMPORT_MAX_ENTRIES) return { error: `Die Datei hat mehr als ${IMPORT_MAX_ENTRIES} Einträge.` };
  return { items: file.items };
}

export function mergeReports(reports: ImportReport[]): ImportReport {
  const counts: Record<ImportStatus, number> = { added: 0, existing: 0, library: 0, unknown: 0, invalid: 0 };
  for (const report of reports) for (const status of Object.keys(counts) as ImportStatus[]) counts[status] += report.counts[status];
  return { counts, results: reports.flatMap(report => report.results) };
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The message after an import ("3 Spiele hinzugefügt, 2 waren schon auf der Liste"). */
export function importSummary(report: ImportReport): string {
  const { added, existing, library, unknown, invalid } = report.counts;
  const parts = [
    `${plural(added, 'Spiel', 'Spiele')} hinzugefügt`,
    ...(existing ? [`${existing} schon auf der Liste`] : []),
    ...(library ? [`${library} in der Bibliothek`] : []),
    ...(unknown + invalid ? [`${unknown + invalid} übersprungen`] : []),
  ];
  return parts.join(', ');
}
