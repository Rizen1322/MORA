import { DatabaseSync, type StatementSync } from 'node:sqlite';
import path from 'node:path';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  title TEXT NOT NULL,
  artist TEXT NOT NULL DEFAULT '',
  album TEXT NOT NULL DEFAULT '',
  album_artist TEXT NOT NULL DEFAULT '',
  track_no INTEGER,
  disc_no INTEGER,
  year INTEGER,
  genre TEXT NOT NULL DEFAULT '',
  duration REAL NOT NULL DEFAULT 0,
  sample_rate INTEGER,
  channels INTEGER,
  codec TEXT,
  bitrate INTEGER,
  size INTEGER,
  cover_id TEXT,
  provider TEXT NOT NULL DEFAULT 'local',
  status TEXT NOT NULL DEFAULT 'ok',
  error TEXT,
  added_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  play_count INTEGER NOT NULL DEFAULT 0,
  skip_count INTEGER NOT NULL DEFAULT 0,
  last_played_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tracks_hash ON tracks(content_hash);
CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist);

CREATE TABLE IF NOT EXISTS track_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL,
  path TEXT,
  external_id TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  size INTEGER,
  mtime INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sources_track ON track_sources(track_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_unique ON track_sources(provider, kind, IFNULL(path, ''), IFNULL(external_id, ''));
-- idx_sources_unique stops at (provider, kind) for external_id = ?: IFNULL(path) comes first and IFNULL(external_id) is an expression
CREATE INDEX IF NOT EXISTS idx_sources_external ON track_sources(provider, kind, external_id);

CREATE TABLE IF NOT EXISTS analysis (
  content_hash TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL,
  data TEXT,
  summary TEXT,
  error TEXT,
  elapsed_ms INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (content_hash, version)
);

CREATE TABLE IF NOT EXISTS reactions (
  track_id TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  value INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS yandex_reaction_sync (
  external_id TEXT PRIMARY KEY,
  track_id TEXT REFERENCES tracks(id) ON DELETE SET NULL,
  value INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  account_key TEXT,
  account_uid TEXT,
  error TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS plays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  context TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  played_ms INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  end_reason TEXT,
  transition_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_plays_started ON plays(started_at);

CREATE TABLE IF NOT EXISTS playlists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS playlist_tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  added_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pl_tracks ON playlist_tracks(playlist_id, position);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS transition_cache (
  key TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  from_hash TEXT NOT NULL,
  to_hash TEXT NOT NULL,
  plan TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  used_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tc_plan ON transition_cache(plan_id);

CREATE TABLE IF NOT EXISTS transition_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id TEXT NOT NULL,
  from_track TEXT,
  to_track TEXT,
  method TEXT,
  executed_at INTEGER NOT NULL,
  outcome TEXT NOT NULL DEFAULT '{}',
  plan TEXT NOT NULL,
  rating TEXT,
  rating_reason TEXT,
  rated_at INTEGER
);

CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  config TEXT NOT NULL DEFAULT '{}',
  secret TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- A logical track (likes, playlists, history) may play another recording chosen
-- by the listener. Analysis, stems and PCM follow the asset's content hash.
CREATE TABLE IF NOT EXISTS track_bindings (
  track_id TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  chosen_at INTEGER NOT NULL
);
`;

export type Db = DatabaseSync;

export function openDb(dataDir: string): Db {
  const db = new DatabaseSync(path.join(dataDir, 'automix.sqlite'));
  db.exec(SCHEMA);
  // Additive columns for databases created before listener ratings existed.
  const logCols = new Set((db.prepare('PRAGMA table_info(transition_log)').all() as { name: string }[]).map((c) => c.name));
  for (const [col, type] of [['rating', 'TEXT'], ['rating_reason', 'TEXT'], ['rated_at', 'INTEGER']])
    if (!logCols.has(col)) db.exec(`ALTER TABLE transition_log ADD COLUMN ${col} ${type}`);
  // saved = the listener added it to the collection; 0 = a technical row created to play a search result.
  // pinned = an explicit offline download, never removed by cache eviction.
  const trackCols = new Set((db.prepare('PRAGMA table_info(tracks)').all() as { name: string }[]).map((c) => c.name));
  for (const [col, type] of [['saved', 'INTEGER NOT NULL DEFAULT 1'], ['pinned', 'INTEGER NOT NULL DEFAULT 0']])
    if (!trackCols.has(col)) db.exec(`ALTER TABLE tracks ADD COLUMN ${col} ${type}`);
  db.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES ('schema', '1')").run();
  return db;
}

/** Tiny statement cache so hot queries are prepared once. */
const cache = new WeakMap<Db, Map<string, StatementSync>>();
export function q(db: Db, sql: string): StatementSync {
  let m = cache.get(db);
  if (!m) {
    m = new Map();
    cache.set(db, m);
  }
  let s = m.get(sql);
  if (!s) {
    s = db.prepare(sql);
    m.set(sql, s);
  }
  return s;
}

export function tx<T>(db: Db, fn: () => T): T {
  // Nested calls join the outer transaction (SQLite has no nested BEGIN).
  if ((db as Db & { isTransaction?: boolean }).isTransaction) return fn();
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function kvGet<T>(db: Db, key: string, fallback: T): T {
  const row = q(db, 'SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function kvSet(db: Db, key: string, value: unknown): void {
  q(db, 'INSERT INTO kv(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(
    key,
    JSON.stringify(value),
    Date.now(),
  );
}
