import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ music: vi.fn(), youtube: vi.fn() }));
vi.mock('../src/public/ytmusic.ts', async original => ({ ...await original<typeof import('../src/public/ytmusic.ts')>(), radioYtm: h.music, requestYtm: h.youtube }));
const song = (id = 'abcdefghijk', title = 'Песня', artist = 'Исполнитель', duration = 180) => ({ videoId: id, title, artist, duration, thumbnail: null, artistId: null, album: '', albumId: null, explicit: false, kind: 'song' as const });
const panel = (rows: unknown[]) => ({ contents: { twoColumnWatchNextResults: { playlist: { playlist: { contents: rows } } } } });
const row = (id = 'lmnopqrstuv', duration = '3:05') => ({ playlistPanelVideoRenderer: { videoId: id, title: { simpleText: 'Новая песня' }, longBylineText: { runs: [{ text: 'Новый артист - Topic' }] }, lengthText: { simpleText: duration } } });
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); h.music.mockResolvedValue([]); h.youtube.mockResolvedValue(panel([])); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('bounded radio candidates', () => {
  it('uses the independent YouTube Mix when Music fails, and caches a successful pool', async () => {
    h.music.mockRejectedValue(new Error('Music down')); h.youtube.mockResolvedValue(panel([row(), row(), row('abcdefghijk')]));
    const { radioCandidates } = await import('../src/public/radio-candidates.ts');
    const items = await radioCandidates('abcdefghijk');
    expect(items.map(t => t.videoId)).toEqual(['lmnopqrstuv']);
    expect(h.youtube).toHaveBeenCalledWith('next', { videoId: 'abcdefghijk', playlistId: 'RDabcdefghijk' }, expect.any(AbortSignal), 'youtube');
    expect(await radioCandidates('abcdefghijk')).toEqual(items); expect(h.music).toHaveBeenCalledOnce();
  });
  it('keeps Music results when the optional YouTube Mix fails', async () => {
    h.music.mockResolvedValue([song('lmnopqrstuv')]); h.youtube.mockRejectedValue(new Error('YouTube down'));
    const { radioCandidates } = await import('../src/public/radio-candidates.ts');
    expect((await radioCandidates('abcdefghijk')).map(t => t.videoId)).toEqual(['lmnopqrstuv']);
  });
  it('does not cache upstream failures and does not request a second pool for a full Music response', async () => {
    h.music.mockRejectedValueOnce(new Error('down')); h.youtube.mockRejectedValueOnce(new Error('down'));
    const { radioCandidates } = await import('../src/public/radio-candidates.ts');
    await expect(radioCandidates('abcdefghijk')).rejects.toThrow('down');
    h.music.mockResolvedValue(Array.from({ length: 12 }, (_, i) => song(`recording${i.toString().padStart(2, '0')}`)));
    expect(await radioCandidates('abcdefghijk')).toHaveLength(12); expect(h.youtube).toHaveBeenCalledOnce();
  });
  it('does not cancel another listener when one caller leaves', async () => {
    let finish!: (items: ReturnType<typeof song>[]) => void;
    h.music.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { radioCandidates } = await import('../src/public/radio-candidates.ts');
    const ctl = new AbortController(), a = radioCandidates('abcdefghijk', ctl.signal), b = radioCandidates('abcdefghijk');
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const rejected = expect(a).rejects.toThrow(); ctl.abort(); await rejected;
    finish([song('lmnopqrstuv')]); expect(await b).toHaveLength(1); expect(h.music).toHaveBeenCalledOnce();
  });
  it('aborts both paths within the total deadline', async () => {
    vi.useFakeTimers();
    h.music.mockImplementation((_id, signal: AbortSignal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
    const { radioCandidates } = await import('../src/public/radio-candidates.ts');
    const pending = expect(radioCandidates('abcdefghijk')).rejects.toThrow('время');
    await vi.advanceTimersByTimeAsync(14_001); await pending; expect(h.youtube).not.toHaveBeenCalled();
  });
  it('keeps an available Music pool when the optional enrichment exhausts the deadline', async () => {
    vi.useFakeTimers(); h.music.mockResolvedValue([song('lmnopqrstuv')]);
    h.youtube.mockImplementation((_endpoint, _body, signal: AbortSignal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
    const { radioCandidates } = await import('../src/public/radio-candidates.ts');
    const pending = radioCandidates('abcdefghijk');
    await vi.advanceTimersByTimeAsync(14_001);
    expect((await pending).map(t => t.videoId)).toEqual(['lmnopqrstuv']);
  });
  it('stops the worker after all listeners cancel without starting another upstream', async () => {
    let workerSignal!:AbortSignal;
    h.music.mockImplementation((_id, signal: AbortSignal) => new Promise((_, reject) => {
      workerSignal=signal;signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
    }));
    const { radioCandidates } = await import('../src/public/radio-candidates.ts');
    const ctl = new AbortController(), rejected=expect(radioCandidates('abcdefghijk',ctl.signal)).rejects.toThrow();
    await vi.waitFor(()=>expect(workerSignal).toBeInstanceOf(AbortSignal));ctl.abort();await rejected;
    expect(workerSignal.aborted).toBe(true);expect(h.youtube).not.toHaveBeenCalled();
  });
  it('rejects malformed, unavailable, live, short and excessively long Mix entries', async () => {
    const { parseYoutubeMix } = await import('../src/public/radio-candidates.ts');
    const unavailable = row(); (unavailable.playlistPanelVideoRenderer as any).isPlayable = false;
    expect(parseYoutubeMix(panel([{}, row('bad'), row('lmnopqrstuv', ''), row('lmnopqrstuv', '0:10'), row('lmnopqrstuv', '1:30:00'), unavailable, row()]))).toMatchObject([{ videoId: 'lmnopqrstuv', artist: 'Новый артист', kind: 'video' }]);
  });
  it('accepts only the same title/artist and a close duration from external metadata', async () => {
    const { matchRadioMetadata } = await import('../src/public/radio-candidates.ts');
    const target = { title: 'Песня', artist: 'Исполнитель', duration: 180 };
    expect(matchRadioMetadata(target, [song('abcdefghijk', 'Песня remix'), song('lmnopqrstuv', 'Песня', 'Другой'), song('00000000000', 'Песня', 'Исполнитель', 230)])).toBeUndefined();
    expect(matchRadioMetadata(target, [song('abcdefghijk', 'ПЕСНЯ', 'исполнитель', 182)])?.videoId).toBe('abcdefghijk');
  });
  it('tries at most three Deezer metadata recordings, after both YouTube pools are empty', async () => {
    const fetcher = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('search/artist') ? { data: [{ id: 12, name: 'Исполнитель' }] } :
      { data: Array.from({ length: 8 }, (_, i) => ({ title: `Песня ${i}`, artist: { name: 'Артист' }, duration: 180 })) })));
    vi.stubGlobal('fetch', fetcher);
    const resolve = vi.fn(async (q: string) => [song('lmnopqrstuv', q.replace('Артист ', ''), 'Артист')]);
    const { radioCandidates } = await import('../src/public/radio-candidates.ts');
    const result = await radioCandidates('abcdefghijk', undefined, { seed: { title: 'Основа', artist: 'Исполнитель', duration: 180 }, resolve });
    expect(fetcher).toHaveBeenCalledTimes(2); expect(resolve).toHaveBeenCalledTimes(3); expect(result).toHaveLength(1);
  });
  it('does not borrow a different Deezer artist just because it is the first search result', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 1, name: 'Другой' }] })));
    vi.stubGlobal('fetch', fetcher);
    const resolve = vi.fn();
    const { radioCandidates } = await import('../src/public/radio-candidates.ts');
    expect(await radioCandidates('abcdefghijk', undefined, { seed: { title: 'Основа', artist: 'Исполнитель', duration: 180 }, resolve })).toEqual([]);
    expect(fetcher).toHaveBeenCalledOnce(); expect(resolve).not.toHaveBeenCalled();
  });
});
