import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { AnalysisService, PRIORITY } from '../src/analysis.ts';
import { openDb } from '../src/db.ts';
import { EventHub } from '../src/events.ts';
import type { Library } from '../src/library.ts';

type Track = { id: string; content_hash: string; provider: string; status: string; duration: number };
type Pending = { resolve: (file: string) => void; reject: (e: Error) => void; signal?: AbortSignal };

/** Real AnalysisService and SQLite; only the workers and the media fetch are stand-ins. */
function fixture(durations: Record<string, number> = { a: 10, b: 10, c: 10 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-analysis-life-'));
  const db = openDb(dir);
  const tracks = new Map<string, Track>(Object.entries(durations).map(([id, duration]) => [id, { id, content_hash: `remote:${id}`, provider: 'local', status: 'ok', duration }]));
  const pending = new Map<string, Pending>();
  const lib = {
    get: (id: string) => tracks.get(id), mixingPolicy: new Map([['local', true]]),
    resolveMediaPath: (id: string, signal?: AbortSignal) => new Promise<string>((resolve, reject) => {
      pending.set(id, { resolve, reject, signal });
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  } as unknown as Library;
  const service = new AnalysisService(db, {} as never, lib, new EventHub());
  const workers = [0, 1].map(() => ({ w: { postMessage: vi.fn(), terminate: vi.fn(async () => 0) }, busy: false, cancel: new Int32Array(1) }));
  const s = service as unknown as { pool: typeof workers; running: Map<string, unknown>; onMessage(w: unknown, m: unknown): void };
  s.pool = workers;
  const jobs = () => workers.flatMap((w) => w.w.postMessage.mock.calls.filter(([m]) => m.type === 'job').map(([m]) => m.jobId as number));
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return { db, tracks, pending, service, s, workers, jobs, tick, clean: async () => { await service.stop(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

it('two ids that resolve to the same audio share one analysis and free both slots', async () => {
  const f = fixture();
  try {
    f.service.ensure(f.tracks.get('a') as never, 100);
    f.service.ensure(f.tracks.get('b') as never, 100);
    f.tracks.get('a')!.content_hash = 'same'; f.pending.get('a')!.resolve('a.wav'); await f.tick();
    f.tracks.get('b')!.content_hash = 'same'; f.pending.get('b')!.resolve('b.wav'); await f.tick();
    expect(f.jobs()).toEqual([1]);
    expect(f.workers.map((w) => w.busy)).toEqual([true, false]);
    f.s.onMessage(f.workers[0], { jobId: 1, type: 'error', error: 'synthetic' });
    expect(f.s.running.size).toBe(0);
    expect(f.workers.map((w) => w.busy)).toEqual([false, false]);
    // the next job still gets a worker
    f.service.ensure(f.tracks.get('c') as never, 100);
    expect(f.pending.has('c')).toBe(true);
  } finally { await f.clean(); }
});

it('stop() aborts media resolution and nothing is submitted after it returns', async () => {
  const f = fixture();
  try {
    f.service.ensure(f.tracks.get('a') as never, 100);
    await f.service.stop();
    expect(f.pending.get('a')!.signal?.aborted).toBe(true);
    f.pending.get('a')!.resolve('a.wav'); await f.tick();
    expect(f.jobs()).toEqual([]);
  } finally { f.db.close(); }
});

it('long recordings are analyzed one at a time, very long ones only on request', async () => {
  const f = fixture({ a: 3600, b: 3600, c: 10, d: 4 * 3600 });
  try {
    f.service.ensure(f.tracks.get('d') as never, PRIORITY.wave);
    expect(f.pending.has('d')).toBe(false);
    f.service.ensure(f.tracks.get('a') as never, 100);
    f.service.ensure(f.tracks.get('b') as never, 100);
    f.service.ensure(f.tracks.get('c') as never, 50);
    expect([...f.pending.keys()].sort()).toEqual(['a', 'c']);
  } finally { await f.clean(); }
});
