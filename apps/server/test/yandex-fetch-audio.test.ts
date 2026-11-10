import { expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config.ts';
import type { Library, SourceRow, TrackRow } from '../src/library.ts';
import type { ProbeResult } from '../src/ffmpeg.ts';
import { YandexProvider } from '../src/providers/yandex.ts';

const HASH = 'd'.repeat(64);
const PROBE: ProbeResult = { duration: 3, sampleRate: 44100, channels: 2, codec: 'mp3', bitrate: 320000, hasAudio: true };

/** A provider whose audio layer is stubbed: these tests describe decisions, not ffmpeg. */
function setup(row: Partial<TrackRow>, prepare: (id: string, duration: number, hash?: string) => Promise<unknown>) {
  const lib = { get: () => row as TrackRow, rebindContent: vi.fn() };
  const provider = new YandexProvider({} as never, lib as unknown as Library, { dataDir: 'unused', ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' } as AppConfig);
  (provider as unknown as { audio: unknown }).audio = { prepare };
  return { provider, lib };
}

const source = (hash: string | undefined, meta: string): SourceRow =>
  ({ id: 7, track_id: 'track', provider: 'yandex', kind: 'remote', external_id: '100:10', path: null, size: null, mtime: null, meta }) as unknown as SourceRow;

it('verifies a row imported without audio instead of asking to re-add the track', async () => {
  const prepare = vi.fn(async () => ({ file: '/tmp/audio.mp3', hash: HASH, size: 42, probe: PROBE, bitrate: 320 }));
  const { provider, lib } = setup({ id: 'track', content_hash: 'remote:yandex:100:10', duration: 3 }, prepare);
  await expect(provider.fetchAudio(source(undefined, '{"audioHash":"stale"}'))).resolves.toBe('/tmp/audio.mp3');
  expect(prepare).toHaveBeenCalledWith('100:10', 3);
  expect(lib.rebindContent).toHaveBeenCalledWith('track', HASH, 42, PROBE, { id: 7, meta: { audioHash: HASH, bitrate: 320 } });
});

it('plays a verified row against its hash without rewriting the library row', async () => {
  const prepare = vi.fn(async () => ({ file: '/tmp/audio.mp3', hash: HASH, size: 42, probe: PROBE, bitrate: 320 }));
  const { provider, lib } = setup({ id: 'track', content_hash: HASH, duration: 3 }, prepare);
  await provider.fetchAudio(source(HASH, '{}'));
  expect(prepare).toHaveBeenCalledWith('100:10', 3, HASH, { signal: undefined, priority: 0 });
  expect(lib.rebindContent).not.toHaveBeenCalled();
});

it('still refuses bytes that disagree with the remembered source hash', async () => {
  const prepare = vi.fn(async () => ({ file: '/tmp/audio.mp3', hash: HASH, size: 42, probe: PROBE, bitrate: 320 }));
  const { provider, lib } = setup({ id: 'track', content_hash: HASH, duration: 3 }, prepare);
  const meta = JSON.stringify({ audioHash: 'e'.repeat(64) });
  await expect(provider.fetchAudio(source('e'.repeat(64), meta))).rejects.toThrow('не совпадает');
  expect(prepare).not.toHaveBeenCalled();
  expect(lib.rebindContent).not.toHaveBeenCalled();
});
