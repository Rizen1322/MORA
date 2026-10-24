import { expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { SoundCloudCatalog, SoundCloudCatalogError, validSoundCloudArtistId } from '../src/public/soundcloud-catalog.ts';
import { registerSoundCloudCatalogRoutes } from '../src/routes/soundcloud-catalog.ts';
import type { Services } from '../src/app.ts';

it('accepts numeric upstream user IDs and rejects path-like identifiers', () => {
  expect(validSoundCloudArtistId('123')).toBe(true);
  for (const id of ['../123', '-1', 'https://soundcloud.com/a', '']) expect(validSoundCloudArtistId(id)).toBe(false);
});

it('returns remembered playable tracks and known local identities', async () => {
  const catalog = new SoundCloudCatalog();
  vi.spyOn(catalog, 'get').mockImplementation(async id => {
    if (!validSoundCloudArtistId(id)) throw new SoundCloudCatalogError('Некорректный ID исполнителя', 400);
    return { id, permalink: 'artist', title: 'Artist', description: '', coverUrl: null, tracks: [{ id: '456' }] };
  });
  const rememberSoundCloud = vi.fn(() => [{ externalId: '456', title: 'Song', source: 'soundcloud' }]);
  const known = vi.fn(() => new Map([['456', 'track-local']]));
  const app = Fastify();
  registerSoundCloudCatalogRoutes(app, { publicMusic: { rememberSoundCloud, known } } as unknown as Services, catalog);
  try {
    const result = await app.inject('/api/catalog/soundcloud/artists/123');
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ userId: '123', permalink: 'artist', tracks: [{ externalId: '456', libraryTrackId: 'track-local' }] });
    expect(rememberSoundCloud).toHaveBeenCalledOnce();
    expect(known).toHaveBeenCalledWith('soundcloud', ['456']);
    expect((await app.inject('/api/catalog/soundcloud/artists/invalid')).statusCode).toBe(400);
  } finally { await app.close(); }
});
