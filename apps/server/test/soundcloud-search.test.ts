import { afterEach, expect, it, vi } from 'vitest';
import { getSoundCloudArtist, parseSoundCloudSearch, searchSoundCloud, setSoundCloudTransport } from '../src/public/soundcloud.ts';

const ID = 'a'.repeat(32);
const entry = { id: 123, kind: 'track', title: 'Верить', duration: 208738, streamable: true,
  user: { username: 'Yanix', avatar_url: 'https://i1.sndcdn.com/avatars-a-large.jpg' },
  permalink_url: 'https://soundcloud.com/yanix/verit', artwork_url: 'https://i1.sndcdn.com/artworks-a-large.jpg' };
function fakeApi() {
  return vi.fn<typeof fetch>(async (url) => {
    const u = String(url);
    if (u === 'https://soundcloud.com/') return new Response('<script src="https://evil.example/asset.js"></script><script src="https://a-v2.sndcdn.com/assets/55-ab.js"></script>');
    if (u.includes('/assets/')) return new Response(`client_id:"${ID}"`);
    return Response.json({ collection: [entry] });
  });
}
afterEach(() => { setSoundCloudTransport((...args) => fetch(...args)); vi.useRealTimers(); });

it('discovers the current public client once and returns complete metadata without resolving audio', async () => {
  const fetcher = fakeApi(); setSoundCloudTransport(fetcher);
  const result = await searchSoundCloud('Yanix Верить');
  expect(result[0]).toMatchObject({ id: '123', title: 'Верить', uploader: 'Yanix', artist: 'Yanix', duration: 208.738,
    thumbnail: 'https://i1.sndcdn.com/artworks-a-t500x500.jpg', webpage_url: entry.permalink_url });
  await searchSoundCloud('FACE');
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(String(fetcher.mock.calls[3][0])).toContain(`client_id=${ID}`);
  expect(fetcher.mock.calls.some(([url]) => String(url).includes('evil.example'))).toBe(false);
});

it('keeps only valid, full-length public tracks and bounds output', () => {
  expect(parseSoundCloudSearch({ collection: [null, entry, entry, { ...entry, id: 124, policy: 'SNIP' },
    { ...entry, id: 125, duration: 'NaN' }, { ...entry, id: 126, streamable: false }, { ...entry, id: 127, artwork_url: 'https://evil.example/a.jpg' }] }, 15))
    .toMatchObject([{ id: '123' }, { id: '127', thumbnail: 'https://i1.sndcdn.com/avatars-a-t500x500.jpg' }]);
  expect(() => parseSoundCloudSearch({ broken: [] }, 15)).toThrow('формат');
});

it('drops records whose every transcoding is DRM-encrypted', () => {
  const tc = (protocol: string) => ({ url: 'https://api-v2.soundcloud.com/media/x', format: { protocol, mime_type: 'audio/mp4; codecs="mp4a.40.2"' } });
  expect(parseSoundCloudSearch({ collection: [
    { ...entry, id: 1, media: { transcodings: [tc('cbc-encrypted-hls'), tc('ctr-encrypted-hls')] } },
    { ...entry, id: 2, media: { transcodings: [tc('ctr-encrypted-hls'), tc('hls')] } },
    { ...entry, id: 3 },
    { ...entry, id: 4, media: { transcodings: [] } },
  ] }, 15).map((t) => t.id)).toEqual(['2', '3']);
});

it('exposes only numeric SoundCloud user IDs paired with a valid permalink slug', () => {
  const valid = { ...entry, user: { ...entry.user, id: 456, permalink: 'yanix-official' } };
  const invalid = { ...entry, id: 124, user: { ...entry.user, id: 'bad', permalink: '../yanix' } };
  expect(parseSoundCloudSearch({ collection: [valid, invalid] }, 15)).toMatchObject([
    { artist_id: '456', artist_permalink: 'yanix-official' }, { artist_id: null, artist_permalink: '' },
  ]);
});

it('honors pre-cancel and abort during discovery without blocking the next query', async () => {
  const before = new AbortController(); before.abort(); const fetcher = fakeApi(); setSoundCloudTransport(fetcher);
  await expect(searchSoundCloud('x', 15, before.signal)).rejects.toThrow('Отменено');
  expect(fetcher).not.toHaveBeenCalled();
  const abort = new AbortController();
  const cancelling = vi.fn<typeof fetch>((_, init) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })));
  setSoundCloudTransport(cancelling);
  const pending = searchSoundCloud('x', 15, abort.signal); abort.abort();
  await expect(pending).rejects.toThrow('Отменено');
  cancelling.mockImplementation(fetcher);
  await expect(searchSoundCloud('x')).resolves.toHaveLength(1);
});

it('bounds the total fast path at four seconds and avoids repeating it while unavailable', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn<typeof fetch>((_, init) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })));
  setSoundCloudTransport(fetcher);
  const pending = expect(searchSoundCloud('x')).rejects.toThrow('aborted');
  await vi.advanceTimersByTimeAsync(4000); await pending;
  await expect(searchSoundCloud('y')).rejects.toThrow('временно');
  expect(fetcher).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(30_000);
  setSoundCloudTransport(fakeApi());
  await expect(searchSoundCloud('z')).resolves.toHaveLength(1);
});

it('invalidates a rejected client and rejects oversized streamed bodies', async () => {
  const fetcher = fakeApi(); setSoundCloudTransport(fetcher);
  await searchSoundCloud('a');
  fetcher.mockResolvedValueOnce(new Response('', { status: 403 }));
  await expect(searchSoundCloud('b')).rejects.toThrow('403');
  setSoundCloudTransport(async () => new Response('x'.repeat((1 << 20) + 1)));
  await expect(searchSoundCloud('c')).rejects.toThrow('большой');
});

it('loads a public artist shelf only when profile id and canonical permalink agree', async () => {
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    const u = String(url);
    if (u === 'https://soundcloud.com/') return new Response('<script src="https://a-v2.sndcdn.com/assets/55-ab.js"></script>');
    if (u.includes('/assets/')) return new Response(`client_id:"${ID}"`);
    if (u.includes('/users/123/tracks?')) return Response.json({ collection: [{ ...entry, id: 124, user: { ...entry.user, id: 123, permalink: 'yanix' } }] });
    if (u.includes('/users/123?')) return Response.json({ kind: 'user', id: 123, permalink: 'yanix', permalink_url: 'https://soundcloud.com/yanix', username: 'Yanix', avatar_url: 'https://i1.sndcdn.com/avatars-a-large.jpg' });
    throw new Error(`unexpected request ${u}`);
  });
  setSoundCloudTransport(fetcher);
  const result = await getSoundCloudArtist('123');
  expect(result).toMatchObject({ id: '123', permalink: 'yanix', title: 'Yanix', coverUrl: 'https://i1.sndcdn.com/avatars-a-t500x500.jpg', tracks: [{ id: '124', artist_id: '123' }] });
  fetcher.mockImplementation(async (url) => String(url).includes('/users/123?')
    ? Response.json({ kind: 'user', id: 999, permalink: 'fake', permalink_url: 'https://soundcloud.com/fake', username: 'Fake' })
    : new Response('<script src="https://a-v2.sndcdn.com/assets/55-ab.js"></script>'));
  await expect(getSoundCloudArtist('123')).rejects.toThrow('не подтверждён');
  fetcher.mockImplementation(fakeApi());
  await expect(searchSoundCloud('Yanix')).resolves.toHaveLength(1);
});
