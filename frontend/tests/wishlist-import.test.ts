import test from 'node:test';
import assert from 'node:assert/strict';
import { IMPORT_CHUNK, IMPORT_MAX_ENTRIES, importInChunks, importSummary, mergeReports, parseWishlistFile } from '../src/features/wishlist-import.ts';
import type { ImportEntryResult, ImportReport } from '../src/features/wishlist-import.ts';

const report = (counts: Partial<ImportReport['counts']>, title = 'x'): ImportReport => ({
  counts: { added: 0, existing: 0, library: 0, unknown: 0, invalid: 0, ...counts },
  results: [{ title, platform: 'Xbox One', status: 'added' }],
});

test('the file the export writes is accepted as it is', () => {
  // The shape wishlistExport() writes.
  const item = { title: 'Forza Horizon 5', platform: 'Xbox Series X|S', igdb_id: 141503, kind: 'base_game', verification: 'catalog' };
  const file = JSON.stringify({ version: 1, exported_at: '2026-11-23T00:00:00.000Z', items: [item] });
  assert.deepEqual(parseWishlistFile(file), { items: [item] });
});

test('other files are refused with a reason: no JSON, other format, other version, too many entries', () => {
  for (const text of ['no json', '[]', 'null', '{"version":2,"items":[]}', '{"version":1}', '{"version":1,"items":{}}']) {
    assert.ok('error' in parseWishlistFile(text), text);
  }
  const many = JSON.stringify({ version: 1, items: new Array(IMPORT_MAX_ENTRIES + 1).fill({}) });
  assert.match((parseWishlistFile(many) as { error: string }).error, /mehr als/);
});

test('reports of several requests add up', () => {
  const merged = mergeReports([report({ added: 2, existing: 1 }, 'a'), report({ added: 1, invalid: 3 }, 'b')]);
  assert.deepEqual(merged.counts, { added: 3, existing: 1, library: 0, unknown: 0, invalid: 3 });
  assert.deepEqual(
    merged.results.map(r => r.title),
    ['a', 'b'],
  );
});

test('the summary names what was added and what was skipped', () => {
  assert.equal(importSummary(report({ added: 1 })), '1 Spiel hinzugefügt');
  assert.equal(
    importSummary(report({ added: 3, existing: 2, library: 1, unknown: 1, invalid: 1 })),
    '3 Spiele hinzugefügt, 2 schon auf der Liste, 1 in der Bibliothek, 2 übersprungen',
  );
});

const PLATFORM_NAMES = ['Xbox Series X|S', 'Xbox One', 'Xbox 360', 'Xbox'];

/** The import endpoint as the server runs it: repeats are found within one request only, a dry run adds nothing. */
function server(list: Set<string>, dryRun: boolean) {
  return async (chunk: unknown[]): Promise<ImportReport> => {
    assert.ok(chunk.length <= IMPORT_CHUNK, 'at most one chunk per request');
    const seen = new Set<string>();
    const results = chunk.map((raw): ImportEntryResult => {
      const entry = raw as { title?: string | null; platform: string; igdb_id?: number | null };
      const base = { title: entry.title ?? '', platform: entry.platform };
      if (!PLATFORM_NAMES.includes(entry.platform)) return { ...base, status: 'unknown' };
      const key = `${entry.platform}|${entry.igdb_id ?? entry.title?.trim().split(/\s+/).join(' ').toLowerCase()}`;
      if (seen.has(key)) return { ...base, status: 'existing', message: 'Steht in der Datei mehrfach.' };
      seen.add(key);
      if (list.has(key)) return { ...base, status: 'existing' };
      if (!dryRun) list.add(key);
      return { ...base, status: 'added' };
    });
    const counts = { added: 0, existing: 0, library: 0, unknown: 0, invalid: 0 };
    for (const r of results) counts[r.status] += 1;
    return { counts, results };
  };
}

test('P3: the preview agrees with the import when a repeat lands in another request', async () => {
  const entry = (title: string, igdb_id: number | null, platform = 'Xbox One') => ({ title, platform, igdb_id, kind: null, verification: 'catalog' });
  const items: unknown[] = Array.from({ length: 230 }, (_, i) => entry(`Game ${i}`, i + 1));
  items[150] = entry('Game 0 again', 1); // the IGDB id decides
  items[160] = entry('  manual   GAME ', null);
  items[5] = entry('Manual Game', null);
  items[170] = entry('Game 1', 2, 'Xbox 360'); // another system is another wish
  items[180] = entry('PC only', 900, 'PC');
  items[220] = entry('PC only', 900, 'PC'); // the server refuses these before it compares
  const list = new Set<string>();
  const preview = await importInChunks(items, PLATFORM_NAMES, server(list, true));
  assert.equal(list.size, 0);
  const done = await importInChunks(items, PLATFORM_NAMES, server(list, false));
  assert.deepEqual(preview, done);
  assert.deepEqual(done.counts, { added: 226, existing: 2, library: 0, unknown: 2, invalid: 0 });
  assert.equal(list.size, 226);
  assert.equal(done.results.length, items.length, 'one result per entry, in the order of the file');
  assert.deepEqual(done.results[150], { title: 'Game 0 again', platform: 'Xbox One', status: 'existing', message: 'Steht in der Datei mehrfach.' });
  assert.equal(done.results[160].status, 'existing');
  assert.equal(done.results[220].status, 'unknown');
  const again = await importInChunks(items, PLATFORM_NAMES, server(list, false));
  assert.equal(again.counts.added, 0, 'a second import adds nothing');
});
