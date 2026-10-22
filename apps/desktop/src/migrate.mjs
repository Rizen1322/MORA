// Copies an existing AutoMix library (for example the browser version's data-dev)
// into a staging folder. Runs in a utility process; main publishes the result.
// The source is only read: SQLite is snapshotted with VACUUM INTO, which is
// consistent even while another AutoMix server is still using that database.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const [source, staging, finalDir] = process.argv.slice(-3);
const send = (m) => process.parentPort?.postMessage(m);
// Regenerable caches (PCM, reports, renders) stay behind; separated vocals are costly to rebuild.
const COPY = ['library', 'remote', 'covers', path.join('cache', 'stems')];

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && !e.name.endsWith('.partial') && !e.name.endsWith('.tmp')) out.push({ p, size: fs.statSync(p).size });
  }
  return out;
}

try {
  fs.mkdirSync(staging, { recursive: true });
  // Snapshot first: every file the snapshot names already exists, so the copy below can include it.
  // A track added while copying is simply not in this snapshot.
  const dbFile = path.join(staging, 'automix.sqlite');
  const src = new DatabaseSync(path.join(source, 'automix.sqlite'), { readOnly: true });
  src.exec(`VACUUM INTO '${dbFile.replaceAll("'", "''")}'`);
  src.close();

  const files = COPY.filter((d) => fs.existsSync(path.join(source, d))).flatMap((d) => walk(path.join(source, d), []));
  const total = files.reduce((n, f) => n + f.size, 0);
  let done = 0;
  let last = 0;
  for (const f of files) {
    const to = path.join(staging, path.relative(source, f.p));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(f.p, to);
    done += f.size;
    if (Date.now() - last > 250) { last = Date.now(); send({ type: 'progress', done, total }); }
  }

  // Library files copied by AutoMix are stored with absolute paths: point them at the new folder.
  const db = new DatabaseSync(dbFile);
  const prefix = path.resolve(source) + path.sep;
  const rows = db.prepare("SELECT id, path FROM track_sources WHERE kind = 'managed' AND path IS NOT NULL").all();
  const update = db.prepare('UPDATE track_sources SET path = ? WHERE id = ?');
  db.exec('BEGIN');
  let moved = 0;
  for (const r of rows) {
    if (!r.path.toLowerCase().startsWith(prefix.toLowerCase())) continue;
    const rel = r.path.slice(prefix.length);
    if (!fs.existsSync(path.join(staging, rel))) { db.exec('ROLLBACK'); db.close(); throw new Error(`файл медиатеки не скопирован: ${rel}`); }
    update.run(path.join(finalDir, rel), r.id);
    moved++;
  }
  db.exec('COMMIT');
  const integrity = db.prepare('PRAGMA integrity_check').get();
  db.close();
  if (Object.values(integrity)[0] !== 'ok') throw new Error('проверка копии базы не пройдена');

  fs.writeFileSync(path.join(staging, '.import-complete'), JSON.stringify({ source, files: files.length, bytes: total, managedPaths: moved, at: new Date().toISOString() }));
  send({ type: 'progress', done: total, total });
  send({ type: 'done', files: files.length, bytes: total, managedPaths: moved });
  process.exit(0);
} catch (e) {
  send({ type: 'error', message: e.message });
  process.exit(1);
}
