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

/**
 * The key the server compares entries by (`import_entry` in wishlist.rs): the platform and the IGDB id, else the title
 * with collapsed spaces in lower case. Null for an entry the server rejects before it compares (not the export's
 * format, no title, unsupported platform).
 */
function entryKey(item: unknown, platforms: readonly string[]): string | null {
  if (typeof item !== 'object' || item === null) return null;
  const { title, platform, igdb_id: id } = item as { title?: unknown; platform?: unknown; igdb_id?: unknown };
  if (typeof platform !== 'string' || !platforms.includes(platform)) return null;
  if (title !== undefined && title !== null && typeof title !== 'string') return null;
  if (id !== undefined && id !== null && !Number.isSafeInteger(id)) return null;
  if (typeof id === 'number') return `${platform}\n${id}`;
  if (typeof title !== 'string') return null;
  return `${platform}\n${title.split(/\s+/).filter(Boolean).join(' ').toLowerCase()}`;
}

/**
 * Sends the entries in requests of IMPORT_CHUNK and merges the reports. The server finds a repeated entry only within
 * one request, so a repeat is not sent but reported the way the server reports it: the preview and the import then
 * agree for a file of any length. `platforms` are the names the server accepts.
 */
export async function importInChunks(items: unknown[], platforms: readonly string[], send: (chunk: unknown[]) => Promise<ImportReport>): Promise<ImportReport> {
  const seen = new Set<string>();
  const repeated = items.map(item => {
    const key = entryKey(item, platforms);
    if (key === null) return false;
    if (seen.has(key)) return true;
    seen.add(key);
    return false;
  });
  const sent = items.filter((_, index) => !repeated[index]);
  const reports: ImportReport[] = [];
  for (let start = 0; start < sent.length; start += IMPORT_CHUNK) reports.push(await send(sent.slice(start, start + IMPORT_CHUNK)));
  const merged = mergeReports(reports);
  const answers = merged.results[Symbol.iterator]();
  const results = items.map((item, index): ImportEntryResult => {
    if (!repeated[index]) return answers.next().value as ImportEntryResult;
    const { title, platform } = item as { title?: string | null; platform: string };
    return { title: title ?? '', platform, status: 'existing', message: 'Steht in der Datei mehrfach.' };
  });
  merged.counts.existing += repeated.filter(Boolean).length;
  return { counts: merged.counts, results };
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
