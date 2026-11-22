import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
const [db, qfile] = process.argv.slice(2);
const d = new DatabaseSync(db, { readOnly: true });
const Q = JSON.parse(readFileSync(qfile, 'utf8'));
console.log('sqlite', d.prepare('select sqlite_version() v').get().v);
for (const [name, [sql, args]] of Object.entries(Q)) {
  const st = d.prepare(sql); const ts = [];
  for (let i = 0; i < 5; i++) { const a = performance.now(); st.all(...args); ts.push(performance.now() - a); }
  ts.sort((a, b) => a - b);
  console.log(`### ${name}: median ${ts[2].toFixed(1)} ms`);
  if (ts[2] > 20) for (const r of d.prepare('EXPLAIN QUERY PLAN ' + sql).all(...args)) console.log('   ', r.detail);
}
