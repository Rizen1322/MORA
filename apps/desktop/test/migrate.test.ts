import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../src/migrate.mjs', import.meta.url));
let root = '';
afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

function library(files: string[], rows: string[]) {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-migrate-'));
  const source = path.join(root, 'source'), staging = path.join(root, 'data.importing'), finalDir = path.join(root, 'data');
  for (const f of files) { fs.mkdirSync(path.dirname(path.join(source, f)), { recursive: true }); fs.writeFileSync(path.join(source, f), f); }
  const db = new DatabaseSync(path.join(source, 'automix.sqlite'));
  db.exec("CREATE TABLE track_sources (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, path TEXT)");
  for (const r of rows) db.prepare("INSERT INTO track_sources(kind, path) VALUES ('managed', ?)").run(path.join(source, r));
  db.close();
  const run = spawnSync(process.execPath, [script, source, staging, finalDir], { encoding: 'utf8' });
  return { run, staging, finalDir };
}

it('publishes a copy whose managed paths point at copied files', () => {
  const { run, staging, finalDir } = library(['library/a.mp3'], ['library/a.mp3']);
  expect(run.status, run.stderr).toBe(0);
  expect(fs.existsSync(path.join(staging, '.import-complete'))).toBe(true);
  const db = new DatabaseSync(path.join(staging, 'automix.sqlite'));
  expect(db.prepare('SELECT path FROM track_sources').get()).toEqual({ path: path.join(finalDir, 'library', 'a.mp3') });
  db.close();
});

it('fails, without marking success, when the database names a managed file that was not copied', () => {
  const { run, staging } = library(['library/a.mp3'], ['library/a.mp3', 'library/added-later.mp3']);
  expect(run.status).toBe(1);
  expect(fs.existsSync(path.join(staging, '.import-complete'))).toBe(false);
});
