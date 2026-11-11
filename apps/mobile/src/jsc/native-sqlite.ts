import { host, type SqlParams, type SqlValue } from './host.ts';

/**
 * node:sqlite's DatabaseSync for the server in JavaScriptCore: a real SQLite file in the app's
 * container through moraHost.db. Every change is on disk when the call returns, so unlike the
 * sql.js shim (../worker/shims/sqlite.ts) there is no image to load or flush.
 */

type Param = SqlValue | bigint | boolean | undefined;
const conv = (v: Param): SqlValue => (v === undefined ? null : typeof v === 'bigint' ? Number(v) : typeof v === 'boolean' ? (v ? 1 : 0) : v);
const bind = (params: Param[]): SqlParams => {
  if (params.length === 1 && params[0] && typeof params[0] === 'object' && !(params[0] instanceof Uint8Array)) {
    const out: Record<string, SqlValue> = {};
    // node:sqlite accepts bare names; the host matches them against :name, @name and $name
    for (const [k, v] of Object.entries(params[0] as Record<string, Param>)) out[k.replace(/^[:@$]/, '')] = conv(v);
    return out;
  }
  return params.map(conv);
};

/** Kept for the shared boot code (../worker/main.ts); the host opens the file itself. */
export async function openDatabase(_file: string): Promise<void> {}
export async function flushAll(): Promise<void> {}

export class StatementSync {
  constructor(private db: DatabaseSync, readonly sourceSQL: string) {}
  run(...params: Param[]): { changes: number; lastInsertRowid: number } {
    return host.db.run(this.db.handle, this.sourceSQL, bind(params));
  }
  get(...params: Param[]): Record<string, SqlValue> | undefined {
    return host.db.get(this.db.handle, this.sourceSQL, bind(params)) ?? undefined;
  }
  all(...params: Param[]): Record<string, SqlValue>[] {
    return host.db.all(this.db.handle, this.sourceSQL, bind(params));
  }
  *iterate(...params: Param[]): IterableIterator<Record<string, SqlValue>> {
    yield* this.all(...params);
  }
  setReadBigInts(): void { /* numbers are enough for this app */ }
  setAllowBareNamedParameters(): void { /* always allowed */ }
}

export class DatabaseSync {
  readonly handle: number;
  private open = true;
  constructor(readonly location: string) {
    this.handle = host.db.open(location);
  }
  get isTransaction(): boolean { return host.db.inTransaction(this.handle); }
  get isOpen(): boolean { return this.open; }
  exec(sql: string): void { host.db.exec(this.handle, sql); }
  prepare(sql: string): StatementSync { return new StatementSync(this, sql); }
  close(): void {
    if (!this.open) return;
    this.open = false;
    host.db.close(this.handle);
  }
}

export default { DatabaseSync, StatementSync };
