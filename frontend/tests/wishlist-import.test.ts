import test from 'node:test';
import assert from 'node:assert/strict';
import { IMPORT_MAX_ENTRIES, importSummary, mergeReports, parseWishlistFile } from '../src/features/wishlist-import.ts';
import type { ImportReport } from '../src/features/wishlist-import.ts';

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
