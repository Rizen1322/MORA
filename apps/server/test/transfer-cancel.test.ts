import { expect, it, vi } from 'vitest';
import os from 'node:os';
import { Downloads } from '../src/public/downloads.ts';
import { PublicMusic } from '../src/public/provider.ts';
import type { AppConfig } from '../src/config.ts';
import type { Db } from '../src/db.ts';
import type { EventHub } from '../src/events.ts';
import type { FfmpegTools } from '../src/ffmpeg.ts';
import type { Library, SourceRow } from '../src/library.ts';
import type { YtDlp } from '../src/public/ytdlp.ts';

vi.mock('../src/db.ts', () => ({ kvGet: (_db: unknown, _key: string, fallback: unknown) => fallback, kvSet: vi.fn(), q: vi.fn() }));

const src = { id: 1, track_id: 't1', provider: 'youtube', external_id: 'aaaaaaaaaaa', kind: 'remote', meta: '{}' } as unknown as SourceRow;

function music() {
  const signals: AbortSignal[] = [];
  const ytdlp = { download: (_url: string, _dir: string, opts: { signal: AbortSignal }) => new Promise((_r, fail) => {
    signals.push(opts.signal);
    opts.signal.addEventListener('abort', () => fail(new Error('aborted')));
  }) } as unknown as YtDlp;
  const lib = { get: () => ({ id: 't1', content_hash: 'remote:x' }) } as unknown as Library;
  return { signals, pm: new PublicMusic({} as Db, lib, {} as FfmpegTools, { dataDir: os.tmpdir() } as AppConfig, ytdlp) };
}

it('stops a transfer when its only subscriber cancels', async () => {
  const { pm, signals } = music();
  const pause = new AbortController();
  const job = pm.fetchAudio(src, pause.signal);
  await vi.waitFor(() => expect(signals).toHaveLength(1));
  pause.abort();
  await expect(job).rejects.toThrow();
  expect(signals[0].aborted).toBe(true);
});

it('keeps a transfer the player still listens to', async () => {
  const { pm, signals } = music();
  const pause = new AbortController();
  const player = pm.fetchAudio(src);
  const job = pm.fetchAudio(src, pause.signal);
  await vi.waitFor(() => expect(signals).toHaveLength(1));
  pause.abort();
  await expect(job).rejects.toThrow();
  expect(signals[0].aborted).toBe(false);
  player.catch(() => {});
  await pm.stop();
});

it('passes the download job cancellation to the audio fetch of a known track', async () => {
  const seen: (AbortSignal | undefined)[] = [];
  const lib = {
    get: () => ({ id: 't1', title: 'T' }), mediaId: (id: string) => id, sources: () => [],
    resolveMediaPath: (_id: string, signal?: AbortSignal) => { seen.push(signal); return new Promise((_r, fail) => signal?.addEventListener('abort', () => fail(new Error('aborted')))); },
  } as unknown as Library;
  const downloads = new Downloads({} as Db, lib, { known: () => new Map() } as unknown as PublicMusic, { emit: vi.fn() } as unknown as EventHub, {} as AppConfig);
  const job = downloads.add({ trackId: 't1' });
  await vi.waitFor(() => expect(seen).toHaveLength(1));
  downloads.pause(job.id);
  expect(seen[0]?.aborted).toBe(true);
  await downloads.stop();
});
