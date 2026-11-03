import type { Database, SqlJsStatic, Statement, SqlValue } from 'sql.js';
import fs from '../opfs-fs.ts';

/**
 * node:sqlite's DatabaseSync on sql.js (SQLite compiled to WASM, in memory).
 * The image is written back to OPFS shortly after changes and when the app goes to the background.
 */

let SQL: SqlJsStatic | null = null;
const preloaded = new Map<string, Uint8Array | null>();

/** Called before createApp(): the constructor below must be synchronous. */
export function provideSqlite(sql: SqlJsStatic, file: string, bytes: Uint8Array | null): void {
  SQL = sql;
  preloaded.set(file, bytes);
}

const live = new Set<DatabaseSync>();
/** shortcut: a crash in the foreground loses up to this much history; persist positions apart if that matters. */
const SAVE_DELAY_MS = 60_000;
/** A failed write is retried sooner, a few times, then at the normal rate. */
const RETRY_DELAY_MS = 5_000;
const FAST_RETRIES = 3;
/** Never rejects: a failed image stays dirty and is retried; callers only need to know the attempt ended. */
export async function flushAll(): Promise<void> {
  await Promise.allSettled([...live].map((d) => d.save()));
}

type Param = SqlValue | bigint | boolean | undefined;
const bind = (params: Param[]): SqlValue[] | Record<string, SqlValue> | undefined => {
  if (!params.length) return undefined;
  if (params.length === 1 && params[0] && typeof params[0] === 'object' && !(params[0] instanceof Uint8Array)) {
    // named parameters: node:sqlite accepts bare names, sql.js wants the prefix
    const out: Record<string, SqlValue> = {};
    for (const [k, v] of Object.entries(params[0] as Record<string, Param>)) out[/^[:@$]/.test(k) ? k : `:${k}`] = conv(v);
    return out;
  }
  return params.map(conv);
};
const conv = (v: Param): SqlValue => (v === undefined ? null : typeof v === 'bigint' ? Number(v) : typeof v === 'boolean' ? (v ? 1 : 0) : v);

export class StatementSync {
  private stmt: Statement | null = null;
  private gen = -1;
  constructor(private db: DatabaseSync, readonly sourceSQL: string) {
    this.prepare();
  }
  private prepare(): Statement {
    // export() frees every prepared statement: prepare again after a save
    if (!this.stmt || this.gen !== this.db.generation) {
      this.stmt = this.db.raw.prepare(this.sourceSQL);
      this.gen = this.db.generation;
    }
    return this.stmt;
  }
  run(...params: Param[]): { changes: number; lastInsertRowid: number } {
    const s = this.prepare();
    try {
      s.run(bind(params) as SqlValue[]);
    } finally { s.reset(); }
    const changes = this.db.raw.getRowsModified();
    const id = this.db.raw.exec('SELECT last_insert_rowid()')[0]?.values[0]?.[0];
    this.db.changed();
    return { changes, lastInsertRowid: Number(id ?? 0) };
  }
  get(...params: Param[]): Record<string, SqlValue> | undefined {
    const s = this.prepare();
    try {
      s.bind(bind(params) as SqlValue[]);
      return s.step() ? s.getAsObject() as Record<string, SqlValue> : undefined;
    } finally { s.reset(); }
  }
  all(...params: Param[]): Record<string, SqlValue>[] {
    const s = this.prepare();
    const rows: Record<string, SqlValue>[] = [];
    try {
      s.bind(bind(params) as SqlValue[]);
      while (s.step()) rows.push(s.getAsObject() as Record<string, SqlValue>);
    } finally { s.reset(); }
    return rows;
  }
  *iterate(...params: Param[]): IterableIterator<Record<string, SqlValue>> {
    yield* this.all(...params);
  }
  setReadBigInts(): void { /* numbers are enough for this app */ }
  setAllowBareNamedParameters(): void { /* always allowed */ }
}

export class DatabaseSync {
  readonly raw: Database;
  generation = 0;
  private depth = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private saving: Promise<void> | null = null;
  private failures = 0;

  constructor(readonly location: string) {
    if (!SQL) throw new Error('sql.js не загружен');
    // opening again without a fresh image would start empty and overwrite the file on the next save
    if (!preloaded.has(location)) throw new Error(`образ БД ${location} не передан в provideSqlite`);
    const bytes = preloaded.get(location) ?? null;
    // sql.js copies the image into WASM memory: drop ours (often tens of MB)
    preloaded.delete(location);
    this.raw = new SQL.Database(bytes ?? undefined);
    live.add(this);
  }

  get isTransaction(): boolean { return this.depth > 0; }
  get isOpen(): boolean { return live.has(this); }

  exec(sql: string): void {
    const t = sql.trim().toUpperCase();
    // sql.js keeps everything in memory: WAL/busy pragmas do not apply
    const body = sql.replace(/PRAGMA\s+(journal_mode|busy_timeout|synchronous|wal_\w+)\s*=\s*[^;]+;?/gi, '');
    if (body.trim()) this.raw.exec(body);
    if (/^BEGIN/.test(t)) this.depth++;
    else if (/^(COMMIT|END|ROLLBACK)(?!\s+TO)/.test(t)) this.depth = Math.max(0, this.depth - 1);
    this.changed();
  }

  prepare(sql: string): StatementSync {
    return new StatementSync(this, sql);
  }

  changed(delay = SAVE_DELAY_MS): void {
    this.dirty = true;
    if (this.timer) return;
    // Every save rewrites the whole image (analysis, plans: often tens of MB). While playing something
    // always changes (position, plays), so this delay is the write rate; going to the background flushes at once.
    this.timer = setTimeout(() => { this.timer = null; this.save().catch(() => {}); }, delay);
  }

  /** Writes the image atomically (temp file, then rename). Waits for open transactions.
   *  On failure the image stays dirty, a retry is scheduled and the error is rethrown. */
  async save(): Promise<void> {
    if (this.saving) return this.saving;
    if (!this.dirty) return;
    if (this.depth) { this.changed(); return; }
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.saving = (async () => {
      this.dirty = false;
      try {
        const image = this.raw.export();
        this.generation++;
        this.raw.exec('PRAGMA foreign_keys = ON');
        const tmp = `${this.location}.saving`;
        await fs.promises.writeFile(tmp, image);
        await fs.promises.rename(tmp, this.location);
        this.failures = 0;
      } catch (e) {
        this.failures++;
        console.warn(`[sqlite] сохранение ${this.location} не удалось (попытка ${this.failures}), повтор запланирован`, e);
        // A mutation during I/O may have scheduled the normal one-minute save.
        // An I/O failure needs the shorter retry instead.
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        this.changed(this.failures <= FAST_RETRIES ? RETRY_DELAY_MS : SAVE_DELAY_MS);
        throw e;
      }
    })().finally(() => { this.saving = null; });
    return this.saving;
  }

  close(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    void this.save().catch(() => {}).finally(() => {
      // a failed final save scheduled a retry on a database about to close
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      this.raw.close(); live.delete(this);
    });
  }
}

export default { DatabaseSync, StatementSync };
