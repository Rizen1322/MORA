import { expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { q } from '../src/db.ts';
import { Downloads } from '../src/public/downloads.ts';
import type { Library } from '../src/library.ts';
import type { Db } from '../src/db.ts';
import type { PublicMusic } from '../src/public/provider.ts';
import type { EventHub } from '../src/events.ts';
import type { AppConfig } from '../src/config.ts';

vi.mock('../src/db.ts', () => ({ kvGet: (_db: unknown, _key: string, fallback: unknown) => fallback, kvSet: vi.fn(), q: vi.fn() }));

it('counts protected recent audio in the budget and preserves offline downloads', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automix-download-budget-'));
  const folder = path.join(dataDir, 'remote/youtube'); fs.mkdirSync(folder, { recursive: true });
  const hashes = ['a', 'b', 'c', 'd'].map(c => c.repeat(64));
  for (const hash of hashes) fs.writeFileSync(path.join(folder, `${hash}.mp3`), Buffer.alloc(40));
  const old = new Date(Date.now() - 3 * 3600_000);
  for (const hash of hashes.slice(0, 2)) fs.utimesSync(path.join(folder, `${hash}.mp3`), old, old);
  vi.mocked(q).mockReturnValue({ all: () => [{ content_hash: hashes[3] }], get: (hash: string) => hash === hashes[3] ? { pinned: 1 } : undefined } as unknown as ReturnType<typeof q>);
  const downloads = new Downloads({} as Db, {} as Library, {} as PublicMusic, {} as EventHub, { dataDir } as AppConfig);
  try {
    expect(await downloads.evict(64)).toBe(2);
    expect(fs.readdirSync(folder).sort()).toEqual(hashes.slice(2).map(h => `${h}.mp3`));
    const first = downloads.evict(64), clear = downloads.evict(0);
    expect(first).toBe(clear); await clear;
    expect(fs.readdirSync(folder)).toHaveLength(2);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); vi.mocked(q).mockReset(); }
});

it('waits for an aborted download to release its slot before a rapid resume', async () => {
  const attempts: { fail: (e: Error) => void; signal: AbortSignal; progress: (n: number) => void }[] = [];
  const prepare = vi.fn((_p: string, _id: string, _priority: number, opts: { signal: AbortSignal; onProgress: (n: number) => void }) =>
    new Promise<string>((_resolve, fail) => attempts.push({ fail, signal: opts.signal, progress: opts.onProgress })));
  const downloads = new Downloads({} as Db, { get: () => null } as unknown as Library,
    { known: () => new Map(), prepare } as unknown as PublicMusic, { emit: vi.fn() } as unknown as EventHub, {} as AppConfig);
  const job = downloads.add({ provider: 'youtube', externalId: 'aaaaaaaaaaa' });
  expect(prepare).toHaveBeenCalledTimes(1);
  downloads.pause(job.id); downloads.resume(job.id);
  expect(attempts[0].signal.aborted).toBe(true);
  expect(prepare).toHaveBeenCalledTimes(1);
  attempts[0].progress(.9);
  expect(job.progress).toBe(0);
  attempts[0].fail(new Error('aborted attempt settled'));
  await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(2));
  expect(job.state).toBe('downloading');
  downloads.cancel(job.id); attempts[1].fail(new Error('cancelled'));
  await downloads.stop();
  expect(job.state).toBe('cancelled');
});
