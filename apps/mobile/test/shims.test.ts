import { describe, expect, it, vi } from 'vitest';
import initSqlJs from 'sql.js';
import fs from '../src/worker/opfs-fs.ts';
import Fastify, { type MiniFastify } from '../src/worker/shims/fastify.ts';
import { DatabaseSync, provideSqlite } from '../src/worker/shims/sqlite.ts';
import type { FromWorker } from '../src/shared/protocol.ts';

/** Collects one reply of the in-worker router as the page would receive it. */
async function call(app: MiniFastify, method: string, url: string, body: string | ArrayBuffer | null = null, headers: Record<string, string> = {}) {
  const out: FromWorker[] = [];
  const done = new Promise<void>((resolve) => {
    void app.dispatch({ t: 'req', id: 1, method, url, headers, body }, (m) => { out.push(m); if (m.t === 'end' || m.t === 'fail') resolve(); });
  });
  await done;
  const head = out.find((m) => m.t === 'head') as Extract<FromWorker, { t: 'head' }>;
  const text = out.filter((m) => m.t === 'chunk').map((m) => {
    const d = (m as Extract<FromWorker, { t: 'chunk' }>).data;
    return typeof d === 'string' ? d : new TextDecoder().decode(d);
  }).join('');
  return { status: head.status, headers: head.headers, text };
}

describe('in-worker Fastify replacement', () => {
  it('routes params, query and JSON bodies like Fastify', async () => {
    const app = Fastify();
    app.post('/api/tracks/:id/prepare', async (req: { params: { id: string }; query: Record<string, string>; body: { sampleRate: number } }) =>
      ({ id: req.params.id, q: req.query.x, sr: req.body.sampleRate }));
    const r = await call(app, 'POST', '/api/tracks/a%20b/prepare?x=1', JSON.stringify({ sampleRate: 48000 }), { 'Content-Type': 'application/json' });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('application/json');
    expect(JSON.parse(r.text)).toEqual({ id: 'a b', q: '1', sr: 48000 });
  });

  it('keeps reply.code().send() and maps thrown statusCode errors', async () => {
    const app = Fastify();
    app.get('/api/a', async (_req: unknown, reply: { code(n: number): { send(b: unknown): unknown } }) => reply.code(409).send({ error: 'занято' }));
    app.get('/api/b', async () => { throw Object.assign(new Error('нет'), { statusCode: 404 }); });
    expect(await call(app, 'GET', '/api/a')).toMatchObject({ status: 409, text: '{"error":"занято"}' });
    const b = await call(app, 'GET', '/api/b');
    expect(b.status).toBe(404);
    expect(JSON.parse(b.text).message).toBe('нет');
    expect((await call(app, 'GET', '/api/missing')).status).toBe(404);
  });

  it('streams raw bodies in and server-sent events out', async () => {
    const app = Fastify();
    app.post('/api/upload', async (req: { body: AsyncIterable<Uint8Array> }) => {
      let n = 0;
      for await (const c of req.body) n += c.byteLength;
      return { n };
    });
    app.get('/api/events', async (_req: unknown, reply: { raw: { writeHead(s: number, h: Record<string, string>): void; write(s: string): void; end(): void } }) => {
      reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream' });
      reply.raw.write('data: 1\n\n');
      reply.raw.end();
      return reply;
    });
    const up = await call(app, 'POST', '/api/upload', new Uint8Array(3_000_000).buffer, { 'content-type': 'application/octet-stream' });
    expect(JSON.parse(up.text)).toEqual({ n: 3_000_000 });
    const ev = await call(app, 'GET', '/api/events');
    expect(ev.headers['content-type']).toBe('text/event-stream');
    expect(ev.text).toBe('data: 1\n\n');
  });
});

describe('node:sqlite on sql.js', () => {
  it('runs the server schema style: pragmas, prepared statements, transactions', async () => {
    provideSqlite(await initSqlJs(), '/t.sqlite', null);
    const db = new DatabaseSync('/t.sqlite');
    db.exec('PRAGMA journal_mode = WAL;\nPRAGMA foreign_keys = ON;\nPRAGMA busy_timeout = 5000;\nCREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT);');
    const ins = db.prepare('INSERT INTO kv(key, value) VALUES (?, ?)');
    expect(ins.run('a', '1')).toMatchObject({ changes: 1, lastInsertRowid: 1 });
    db.exec('BEGIN');
    expect(db.isTransaction).toBe(true);
    ins.run('b', '2');
    db.exec('ROLLBACK');
    expect(db.isTransaction).toBe(false);
    expect(db.prepare('SELECT value FROM kv WHERE key = ?').get('a')).toEqual({ value: '1' });
    expect(db.prepare('SELECT key FROM kv').all()).toEqual([{ key: 'a' }]);
    expect(db.prepare('SELECT value FROM kv WHERE key = :k').get({ k: 'a' })).toEqual({ value: '1' });
    // export() (the save) frees statements: a cached statement must prepare itself again
    db.raw.export();
    db.generation++;
    expect(ins.run('c', '3').changes).toBe(1);
  });

  it('opens a preloaded image once and refuses to reopen it empty', async () => {
    provideSqlite(await initSqlJs(), '/once.sqlite', null);
    const db = new DatabaseSync('/once.sqlite');
    expect(() => new DatabaseSync('/once.sqlite')).toThrow();
    db.raw.close();
  });

  for (const step of ['writeFile', 'rename'] as const) {
    it(`keeps the image dirty when ${step} fails and writes it on the next save`, async () => {
      vi.useFakeTimers();
      const writes = vi.spyOn(fs.promises, 'writeFile').mockResolvedValue(undefined as never);
      const renames = vi.spyOn(fs.promises, 'rename').mockResolvedValue(undefined as never);
      const failing = step === 'writeFile' ? writes : renames;
      failing.mockRejectedValueOnce(new Error('I/O'));
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        provideSqlite(await initSqlJs(), `/fail-${step}.sqlite`, null);
        const db = new DatabaseSync(`/fail-${step}.sqlite`);
        db.exec('CREATE TABLE kv (k TEXT)');
        await expect(db.save()).rejects.toThrow('I/O');
        // no further mutation: the second save must still write
        await db.save();
        expect(failing).toHaveBeenCalledTimes(2);
        expect(renames).toHaveBeenCalledTimes(step === 'rename' ? 2 : 1);
        // already saved: the scheduled retry finds nothing to do
        await vi.runAllTimersAsync();
        expect(writes).toHaveBeenCalledTimes(2);
        db.raw.close();
      } finally {
        vi.restoreAllMocks();
        vi.useRealTimers();
      }
    });
  }

  it('retries an early background flush in five seconds even with the normal save pending', async () => {
    vi.useFakeTimers();
    const writes = vi.spyOn(fs.promises, 'writeFile').mockResolvedValue(undefined as never);
    vi.spyOn(fs.promises, 'rename').mockResolvedValue(undefined as never);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    writes.mockRejectedValueOnce(new Error('I/O'));
    try {
      provideSqlite(await initSqlJs(), '/early-retry.sqlite', null);
      const db = new DatabaseSync('/early-retry.sqlite');
      db.exec('CREATE TABLE kv (k TEXT)');
      await vi.advanceTimersByTimeAsync(1000);
      await expect(db.save()).rejects.toThrow('I/O');
      await vi.advanceTimersByTimeAsync(4999);
      expect(writes).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(writes).toHaveBeenCalledTimes(2);
      db.raw.close();
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it('retries a failed save on its own', async () => {
    vi.useFakeTimers();
    const writes = vi.spyOn(fs.promises, 'writeFile').mockResolvedValue(undefined as never);
    vi.spyOn(fs.promises, 'rename').mockResolvedValue(undefined as never);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    writes.mockRejectedValueOnce(new Error('I/O'));
    try {
      provideSqlite(await initSqlJs(), '/retry.sqlite', null);
      const db = new DatabaseSync('/retry.sqlite');
      db.exec('CREATE TABLE kv (k TEXT)');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(writes).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(writes).toHaveBeenCalledTimes(2);
      db.raw.close();
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });
});
