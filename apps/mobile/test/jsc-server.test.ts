import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import nodeFs from 'node:fs';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

/**
 * Runs www/server-jsc.js the way NativeServer.swift does: in a context with only ECMAScript built-ins
 * plus `moraHost`, here implemented on node:fs and node:sqlite. A missing browser global, a WebView
 * module that leaked into the bundle or a broken host contract fails boot or a request here.
 */

const mobile = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
type Msg = { t: string; id?: number; [k: string]: unknown };

function startServer(root: string) {
  const posted: Msg[] = [];
  const logs: string[] = [];
  const listeners = new Set<(m: Msg) => void>();
  const timers = new Map<number, NodeJS.Timeout>();
  const ctx = vm.createContext({});
  const realm = vm.runInContext('globalThis', ctx) as typeof globalThis & { __moraReceive(m: unknown): void; __moraTimer(id: number): void };
  const bytes = (b: Uint8Array) => { const u = new realm.Uint8Array(b.byteLength); u.set(b); return u; };
  const fail = (e: unknown): never => {
    const n = e as NodeJS.ErrnoException;
    throw Object.assign(new realm.Error(n.message), { code: n.code });
  };
  const at = (p: string) => {
    const full = resolve(root, `.${p}`);
    if (!full.startsWith(root)) throw Object.assign(new realm.Error(`EACCES ${p}`), { code: 'EACCES' });
    return full;
  };
  const guard = <A extends unknown[], R>(fn: (...a: A) => R) => (...a: A): R => { try { return fn(...a); } catch (e) { return fail(e); } };
  const dbs = new Map<number, { db: DatabaseSync; stmts: Map<string, ReturnType<DatabaseSync['prepare']>> }>();
  let nextDb = 1;
  const row = (r: Record<string, unknown> | undefined) => {
    if (!r) return null;
    const out = new realm.Object() as Record<string, unknown>;
    for (const [k, v] of Object.entries(r)) out[k] = v instanceof Uint8Array ? bytes(v) : v;
    return out;
  };
  const stmt = (h: number, sql: string) => {
    const d = dbs.get(h)!;
    let s = d.stmts.get(sql);
    if (!s) { s = d.db.prepare(sql); d.stmts.set(sql, s); }
    return s;
  };
  const args = (p: unknown) => (Array.isArray(p) ? p : [p]) as never[];

  realm.moraHost = {
    log: (level: string, text: string) => logs.push(`${level}: ${text}`),
    post: (m: Msg) => { posted.push(m); for (const l of listeners) l(m); },
    timer: (id: number, ms: number, repeat: boolean) => {
      timers.set(id, (repeat ? setInterval : setTimeout)(() => { if (!repeat) timers.delete(id); realm.__moraTimer(id); }, ms));
    },
    clearTimer: (id: number) => { clearTimeout(timers.get(id)); timers.delete(id); },
    now: () => performance.now(),
    random: (n: number) => bytes(randomBytes(n)),
    fs: {
      stat: (p: string) => { const s = nodeFs.statSync(at(p), { throwIfNoEntry: false }); return s ? { dir: s.isDirectory(), size: s.size, mtimeMs: s.mtimeMs } : null; },
      readdir: guard((p: string) => nodeFs.readdirSync(at(p), { withFileTypes: true }).map((d) => ({ name: d.name, dir: d.isDirectory() }))),
      mkdir: guard((p: string, recursive: boolean) => { const first = nodeFs.mkdirSync(at(p), { recursive }); return first ? `/${first.slice(root.length + 1).replace(/\\/g, '/')}` : undefined; }),
      open: guard((p: string, flags: string) => nodeFs.openSync(at(p), flags)),
      read: guard((fd: number, length: number, position: number) => { const b = Buffer.alloc(length); const n = nodeFs.readSync(fd, b, 0, length, position); return bytes(b.subarray(0, n)); }),
      write: guard((fd: number, data: Uint8Array, position: number) => nodeFs.writeSync(fd, data, 0, data.byteLength, position)),
      size: guard((fd: number) => nodeFs.fstatSync(fd).size),
      truncate: guard((fd: number, len: number) => nodeFs.ftruncateSync(fd, len)),
      sync: guard((fd: number) => nodeFs.fsyncSync(fd)),
      close: guard((fd: number) => nodeFs.closeSync(fd)),
      rm: guard((p: string, recursive: boolean, force: boolean) => nodeFs.rmSync(at(p), { recursive, force })),
      rename: guard((a: string, b: string) => nodeFs.renameSync(at(a), at(b))),
      copy: guard((a: string, b: string) => nodeFs.copyFileSync(at(a), at(b))),
      utimes: guard((p: string, m: number) => nodeFs.utimesSync(at(p), m / 1000, m / 1000)),
    },
    db: {
      open: guard((p: string) => { const id = nextDb++; dbs.set(id, { db: new DatabaseSync(at(p)), stmts: new Map() }); return id; }),
      exec: guard((h: number, sql: string) => dbs.get(h)!.db.exec(sql)),
      run: guard((h: number, sql: string, p: unknown) => { const r = stmt(h, sql).run(...args(p)); return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }; }),
      get: guard((h: number, sql: string, p: unknown) => row(stmt(h, sql).get(...args(p)) as Record<string, unknown> | undefined)),
      all: guard((h: number, sql: string, p: unknown) => realm.Array.from(stmt(h, sql).all(...args(p)).map((r) => row(r as Record<string, unknown>)))),
      inTransaction: (h: number) => dbs.get(h)!.db.isTransaction,
      close: (h: number) => { dbs.get(h)?.db.close(); dbs.delete(h); },
    },
    analyze: (_p: string, _d: number, _v: string, done: (e: string | null, a: unknown) => void) => { setTimeout(() => done('нет анализатора в тесте', null)); return 1; },
    cancelAnalysis: () => {},
  };

  vm.runInContext(readFileSync(join(mobile, 'www/server-jsc.js'), 'utf8'), ctx, { filename: 'server-jsc.js' });
  const send = (m: Msg) => realm.__moraReceive(m);
  const ready = new Promise<void>((ok, no) => listeners.add((m) => {
    if (m.t === 'ready') ok();
    if (m.t === 'boot-error') no(new Error(String(m.error)));
  }));
  // outbound HTTP is native in the app: here every request fails as if offline
  listeners.add((m) => { if (m.t === 'rpc') send({ t: 'rpc-res', id: m.id, ok: false, error: 'offline' }); });
  let nextReq = 1;
  const request = (method: string, url: string, body: string | null = null, headers: Record<string, string> = {}) => new Promise<{ status: number; text: string }>((ok, no) => {
    const id = nextReq++;
    let status = 0;
    const parts: string[] = [];
    const on = (m: Msg) => {
      if (m.id !== id) return;
      if (m.t === 'head') status = m.status as number;
      if (m.t === 'chunk') parts.push(typeof m.data === 'string' ? m.data : Buffer.from(m.data as ArrayBuffer).toString('utf8'));
      if (m.t === 'end') { listeners.delete(on); ok({ status, text: parts.join('') }); }
      if (m.t === 'fail') { listeners.delete(on); no(new Error(String(m.error))); }
    };
    listeners.add(on);
    send({ t: 'req', id, method, url, headers, body });
  });
  send({ t: 'secret-key', key: null });
  const stop = () => { for (const t of timers.values()) clearTimeout(t); for (const d of dbs.values()) d.db.close(); };
  return { ready, request, posted, logs, stop };
}

describe('server in JavaScriptCore (server-jsc.js)', () => {
  let root: string;
  let server: ReturnType<typeof startServer>;
  beforeAll(async () => {
    const built = spawnSync(process.execPath, ['build.mjs', '--no-web'], { cwd: mobile, encoding: 'utf8' });
    if (built.status !== 0) throw new Error(built.stderr || built.stdout);
    root = mkdtempSync(join(tmpdir(), 'mora-jsc-'));
    server = startServer(root);
    await Promise.race([server.ready, new Promise((_, no) => setTimeout(() => no(new Error(`boot timeout:\n${server.logs.join('\n')}`)), 20000))]);
  }, 120000);
  afterAll(() => { server?.stop(); rmSync(root, { recursive: true, force: true }); });

  it('boots on bare ECMAScript built-ins and answers /api', async () => {
    const health = await server.request('GET', '/api/health');
    expect(health.status).toBe(200);
    const lib = await server.request('GET', '/api/library');
    expect(lib.status).toBe(200);
    expect(JSON.parse(lib.text)).toEqual({ tracks: [] });
  });

  it('keeps settings in a real SQLite file at once, without an image flush', async () => {
    const before = JSON.parse((await server.request('GET', '/api/settings')).text) as { ui?: Record<string, unknown> };
    const put = await server.request('PUT', '/api/settings', JSON.stringify({ ui: { ...before.ui, motion: 'full' } }), { 'content-type': 'application/json' });
    expect(put.status).toBeLessThan(300);
    const db = new DatabaseSync(join(root, 'data/automix.sqlite'), { readOnly: true });
    try {
      const row = db.prepare("SELECT value FROM kv WHERE key = 'settings'").get() as { value: string } | undefined;
      expect(JSON.parse(row!.value).ui.motion).toBe('full');
    } finally { db.close(); }
  });

  it('logs no uncaught errors while booting', () => {
    expect(server.logs.filter((l) => l.startsWith('error:'))).toEqual([]);
  });
  it('imports playlist metadata directly and keeps repeated positions in the report', async () => {
    const response = await server.request('POST', '/api/imports', JSON.stringify({ file: { name: 'Native.csv', text: 'Track Name,Artist Name(s)\nSong,Artist\nSong,Artist\n' } }), { 'content-type': 'application/json' });
    expect(response.status).toBe(200);
    const job = JSON.parse(response.text);
    const report = JSON.parse((await server.request('GET', '/api/imports/' + job.id)).text);
    expect(report.rows.map((row: { position: number; title: string }) => [row.position, row.title])).toEqual([[0, 'Song'], [1, 'Song']]);
  });
  it('consumes staged file names inside JSC and cleans a rejected audio copy', async () => {
    const file = '00000000-0000-4000-8000-000000000000.wav';
    const folder = join(root, 'data/incoming/native'); nodeFs.mkdirSync(folder, { recursive: true });
    const staged = join(folder, file); nodeFs.writeFileSync(staged, 'fixture');
    const result = await server.request('POST', '/api/mobile/import-file', JSON.stringify({ file, name: 'unsupported.txt' }), { 'content-type': 'application/json' });
    expect(result.status).toBe(422);
    expect(nodeFs.existsSync(staged)).toBe(false);
    const invalid = await server.request('POST', '/api/mobile/import-file', JSON.stringify({ file: '../automix.sqlite', name: 'x.wav' }), { 'content-type': 'application/json' });
    expect(invalid.status).toBe(422);
    expect(nodeFs.existsSync(join(root, 'data/automix.sqlite'))).toBe(true);
  });
  it('returns an object for native account imports even when no import exists', async () => {
    const sources = await server.request('GET', '/api/providers');
    expect(sources.status).toBe(200);
    expect(JSON.parse(sources.text).providers).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'yandex', hasSecret: false })]));
    const status = await server.request('GET', '/api/providers/yandex/likes/import?envelope=1');
    expect(status.status).toBe(200);
    expect(JSON.parse(status.text)).toEqual({ job: null });
  });
});
