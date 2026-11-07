import { expect, it, vi } from 'vitest';
import { Downloads, type DownloadJob } from '../src/public/downloads.ts';
import type { Library } from '../src/library.ts';
import type { Db } from '../src/db.ts';
import type { PublicMusic } from '../src/public/provider.ts';
import type { EventHub } from '../src/events.ts';
import type { AppConfig } from '../src/config.ts';

const h = vi.hoisted(() => ({ jobs: [] as DownloadJob[] }));
vi.mock('../src/db.ts', () => ({
  kvGet: (_db: unknown, key: string, fallback: unknown) => (key === 'downloads.jobs' ? h.jobs : fallback),
  kvSet: vi.fn(),
  q: vi.fn(),
}));

const done = (trackId: string, key: string): DownloadJob => ({
  id: `job-${key}`, key, provider: 'youtube', externalId: key.split(':')[1] ?? null, trackId,
  title: 'Песня', state: 'done', progress: 1, error: null, attempts: 1, retryAt: 0, createdAt: 1,
});

const SOURCES: Record<string, { kind: string; provider: string; external_id: string }[]> = {
  track: [{ kind: 'remote', provider: 'youtube', external_id: 'own' }],
  next: [{ kind: 'remote', provider: 'soundcloud', external_id: 'next' }],
  file: [{ kind: 'managed', provider: 'local', external_id: '' }],
};

/** A pinned track whose chosen recording is `bound`. */
function setup(options: { pinned: boolean; bound: string }) {
  const PROVIDER: Record<string, string> = { track: 'youtube', next: 'soundcloud', file: 'local' };
  const lib = {
    get: (id: string) => ({ id, title: 'Песня', pinned: id === 'track' && options.pinned ? 1 : 0, provider: PROVIDER[id] ?? 'local' }),
    mediaId: () => options.bound,
    sources: (id: string) => SOURCES[id] ?? [],
    resolveMediaPath: vi.fn(async () => 'audio.mp3'),
    setPinned: vi.fn(),
    setSaved: vi.fn(),
  };
  const downloads = new Downloads({} as Db, lib as unknown as Library, { known: () => new Map() } as unknown as PublicMusic,
    { emit: vi.fn() } as unknown as EventHub, {} as AppConfig);
  return { downloads, lib };
}

it('downloads the chosen version instead of the old recording', async () => {
  h.jobs = [done('track', 'youtube:own')];
  const { downloads } = setup({ pinned: true, bound: 'next' });
  downloads.follow('track');
  expect(downloads.list().map((j) => [j.key, j.trackId])).toEqual([['soundcloud:next', 'track']]);
  await downloads.stop();
});

it('a chosen file on this disk needs no new download', async () => {
  h.jobs = [done('track', 'youtube:own')];
  const { downloads } = setup({ pinned: true, bound: 'file' });
  downloads.follow('track');
  expect(downloads.list()).toEqual([]);
  await downloads.stop();
});

it('leaves tracks without an offline copy alone', async () => {
  h.jobs = [];
  const { downloads } = setup({ pinned: false, bound: 'next' });
  downloads.follow('track');
  expect(downloads.list()).toEqual([]);
  await downloads.stop();
});

it('restoring the original recording fetches it again', async () => {
  h.jobs = [done('track', 'soundcloud:next')];
  const { downloads } = setup({ pinned: true, bound: 'track' });
  downloads.follow('track');
  expect(downloads.list().map((j) => j.key)).toEqual(['youtube:own']);
  await downloads.stop();
});
