import { expect, it, vi } from 'vitest';
import { YandexProvider } from '../src/providers/yandex.ts';
import type { ProviderStore } from '../src/providers/base.ts';
import { Library, type TrackRow, type SourceRow } from '../src/library.ts';
import type { AppConfig } from '../src/config.ts';

it('gives an old Yandex track without a saved cover a recoverable player URL', () => {
  const library = Object.assign(Object.create(Library.prototype), { mixingPolicy: new Map([['yandex', true]]) }) as Library;
  const track = { id: 'local-yandex', provider: 'yandex', cover_id: null } as TrackRow;
  const source = { kind: 'remote', provider: 'yandex', meta: '{}' } as SourceRow;
  expect(library.dto(track, 0, { status: 'none' }, source).coverUrl).toBe('/api/tracks/local-yandex/cover');
});

it('retries a failed Yandex cover and shares concurrent recovery without downloading the recording', async () => {
  const row = { id: 'local-yandex', provider: 'yandex', cover_id: null as string | null };
  let saved = false;
  const saveCover = vi.fn(async () => { saved = true; return 'cover.jpg'; });
  const library = { get: () => row, coverPath: () => saved ? '/cached/cover.jpg' : null,
    sources: () => [{ kind: 'remote', provider: 'yandex', external_id: '123:10', meta: '{}' }], saveCover,
    setCover: vi.fn((_id: string, coverId: string) => { row.cover_id = coverId; }) } as unknown as Library;
  const provider = new YandexProvider({ load: () => ({ secret: { token: 'fixture-token' } }) } as unknown as ProviderStore,
    library, { dataDir: 'unused', ffmpeg: '', ffprobe: '' } as AppConfig);
  const internals = provider as unknown as { call: (...args: any[]) => Promise<unknown>;
    audio: { cover(url: string): Promise<{ data: Buffer; type: string } | null>; prepare: (...args: any[]) => Promise<unknown> } };
  const metadata = vi.spyOn(internals, 'call').mockResolvedValue([{ id: '123', title: 'Вечно в Дороге', durationMs: 180000,
    available: true, artists: [{ name: 'Fixture' }], coverUri: 'avatars.yandex.net/get-music-content/fixture/%%', albums: [{ id: 10, coverUri: '' }] }]);
  const image = { data: Buffer.from('fixture image'), type: 'image/jpeg' };
  const cover = vi.spyOn(internals.audio, 'cover').mockResolvedValueOnce(null).mockResolvedValue(image);
  const audio = vi.spyOn(internals.audio, 'prepare');
  expect(await provider.ensureCover(row.id)).toBeNull();
  expect(await Promise.all([provider.ensureCover(row.id), provider.ensureCover(row.id)])).toEqual(['/cached/cover.jpg', '/cached/cover.jpg']);
  expect(cover).toHaveBeenCalledTimes(2);
  expect(cover).toHaveBeenLastCalledWith('https://avatars.yandex.net/get-music-content/fixture/400x400');
  expect(metadata).toHaveBeenCalledTimes(2);
  expect(saveCover).toHaveBeenCalledWith(image.data, image.type);
  expect(await provider.ensureCover(row.id)).toBe('/cached/cover.jpg');
  expect(cover).toHaveBeenCalledTimes(2);
  expect(audio).not.toHaveBeenCalled();
});
