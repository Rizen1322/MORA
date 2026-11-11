import { expect, it, vi } from 'vitest';
import { createNativeMix, prepareNativeMixArtwork } from '../src/bridge/native-mix.ts';
import { DEFAULT_AUTOMIX_SETTINGS } from '@automix/core';
const state = { active: true, playing: true, index: 0, position: 0, duration: 3 };
const track = (i: number) => ({ title: String(i), artist: '', totalFrames: 100, gainDb: 0, file: i });
const port = (order: string[] = []) => ({
  nativeMixBegin: async () => { order.push('begin'); return { id: 'test' }; },
  nativeMixAppend: async ({ track }: { track: number }) => { order.push(`append ${track}`); },
  nativeMixStart: async () => { order.push('start'); return state; },
  nativeMixUpdate: async ({ from }: { from: number }) => { order.push(`update ${from}`); return state; },
  nativeMixStop: async () => { order.push('stop'); },
  nativeMixState: async () => state, nativeMixCommand: async () => state,
});
const sourceHooks = () => ({ prepare: vi.fn(async () => {}), restore: vi.fn(), sources: vi.fn(async entries => ({
  items: entries.map(e => ({ ...e, title: e.trackId, artist: '', duration: 180, mixingAllowed: true,
    source: { kind: 'direct' as const, url: 'https://audio.test/song.mp3' } })),
  previous: { trackId: 'a', duration: 180, mixingAllowed: true }, settings: DEFAULT_AUTOMIX_SETTINGS,
})) });
const reserve = async ({ count }: { count: number }) => ({ keys: Array.from({ length: count }, (_, i) => i) });
it('reuses completed background audio without uploading it from WebKit', async () => {
  const hooks = sourceHooks(), prepare = vi.fn(async () => state), read = vi.fn();
  hooks.sources.mockImplementation(async entries => ({ items: entries.map(e => ({ ...e, title: e.trackId, artist: '', duration: 180,
    mixingAllowed: true, source: { kind: 'upload', trackId: e.trackId } })), previous: { trackId: 'a', duration: 180, mixingAllowed: true }, settings: DEFAULT_AUTOMIX_SETTINGS } as any));
  const mix = createNativeMix({ ...port(), nativePrepareStart: prepare, nativeSourceReserve: reserve, nativeSourceAppend: vi.fn(),
    nativeSourceFromDownload: async () => ({ found: true }) }, { ...hooks, sourceFile: read });
  await mix.startSource!({ trackId: 'a', entryId: 'e' }, { sampleRate: 48000, position: 0 });
  expect(read).not.toHaveBeenCalled();
  expect(prepare.mock.calls[0][0].item.source).toEqual({ kind: 'local', file: 0 });
});
it('hands the first source to Swift without asking the page for decoded PCM', async () => {
  const prepare = vi.fn(async () => state), append = vi.fn(), start = vi.fn(), hooks = sourceHooks();
  const mix = createNativeMix({ ...port(), nativeMixStart: start, nativeMixAppend: append,
    nativePrepareStart: prepare, nativeSourceReserve: reserve, nativeSourceAppend: vi.fn() }, hooks);
  expect(await mix.startSource!({ trackId: 'a', entryId: 'e' }, { sampleRate: 48000, position: 7, gainDb: -3 })).toBe(state);
  expect(prepare).toHaveBeenCalledWith({ id: 'test', item: expect.objectContaining({ trackId: 'a', entryId: 'e', source: { kind: 'direct', url: 'https://audio.test/song.mp3' } }),
    config: { sampleRate: 48000, position: 7, gainDb: -3 } });
  expect(append).not.toHaveBeenCalled();expect(start).not.toHaveBeenCalled();
});
it('preserves Pause and settings changes while the first source is being resolved', async () => {
  const hooks = sourceHooks(), prepare = vi.fn(async () => state);
  let resolved!: (manifest: Awaited<ReturnType<typeof hooks.sources>>) => void;
  const original = hooks.sources;
  hooks.sources = vi.fn(() => new Promise(resolve => { resolved = resolve; }));
  const mix = createNativeMix({ ...port(), nativeMixSettings: vi.fn(), nativePrepareStart: prepare, nativeSourceReserve: reserve, nativeSourceAppend: vi.fn() }, hooks);
  const starting = mix.startSource!({ trackId: 'a', entryId: 'e' }, { sampleRate: 48000, position: 0 });
  await vi.waitFor(() => expect(resolved).toBeDefined());
  await mix.command('pause');await mix.settings({ volume: .2, gainDb: -6 });
  resolved(await original([{ trackId: 'a', entryId: 'e', file: 0 }]));
  await starting;
  expect(prepare.mock.calls[0][0].config).toMatchObject({ paused: true, volume: .2, gainDb: -6 });
});
it('interrupts native source preparation on abort without waiting behind its start promise', async () => {
  let reject!: (error: Error) => void;
  const stop = vi.fn(async () => { reject?.(new Error('cancelled')); });
  const prepare = vi.fn(() => new Promise<typeof state>((_resolve, no) => { reject = no; }));
  const hooks = sourceHooks(), abort = new AbortController();
  const mix = createNativeMix({ ...port(), nativeMixStop: stop, nativePrepareStart: prepare, nativeSourceReserve: reserve, nativeSourceAppend: vi.fn() }, hooks);
  const starting = mix.startSource!({ trackId: 'a', entryId: 'e' }, { sampleRate: 48000, position: 0 }, abort.signal);
  const rejected = expect(starting).rejects.toThrow('cancelled');
  await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());abort.abort();await rejected;
  expect(stop).toHaveBeenCalled();expect(hooks.restore).toHaveBeenCalledOnce();
});
it('uploads the compressed local source once for a native first start', async () => {
  const hooks = sourceHooks(), append = vi.fn(), pcm = vi.fn(), prepare = vi.fn(async () => state);
  hooks.sources.mockImplementation(async entries => ({ items: entries.map(e => ({ ...e, title: '', artist: '', duration: 3, mixingAllowed: true,
    source: { kind: 'upload', trackId: e.trackId } })), previous: { trackId: 'a', duration: 3, mixingAllowed: true }, settings: DEFAULT_AUTOMIX_SETTINGS } as any));
  const mix = createNativeMix({ ...port(), nativeMixAppend: pcm, nativePrepareStart: prepare, nativeSourceReserve: reserve, nativeSourceAppend: append }, {
    ...hooks, sourceFile: async () => new Response(Uint8Array.of(1, 2, 3), { headers: { 'X-Native-Length': '3' } }),
  });
  await mix.startSource!({ trackId: 'a', entryId: 'e' }, { sampleRate: 48000, position: 0 });
  expect(append).toHaveBeenCalledWith({ id: 'test', key: 0, offset: 0, base64: 'AQID' });
  expect(prepare.mock.calls[0][0].item.source).toEqual({ kind: 'local', file: 0 });expect(pcm).not.toHaveBeenCalled();
});
it('keeps a recovered native queue if replacement source preparation fails', async () => {
  const stop = vi.fn(), hooks = sourceHooks();
  const mix = createNativeMix({ ...port(), nativeMixBegin: async () => ({ id: 'recovered', hasQueue: true }), nativeMixStop: stop,
    nativePrepareStart: async () => { throw Error('download failed'); }, nativeSourceReserve: reserve, nativeSourceAppend: vi.fn() }, hooks);
  await expect(mix.startSource!({ trackId: 'a', entryId: 'e' }, { sampleRate: 48000, position: 0 })).rejects.toThrow('download failed');
  expect(stop).not.toHaveBeenCalled();expect(hooks.restore).not.toHaveBeenCalled();
});
it('does not stop an existing owner for a source request cancelled before acquiring a session', async () => {
  const stop = vi.fn(), hooks = sourceHooks(), begin = vi.fn();
  const mix = createNativeMix({ ...port(), nativeMixBegin: begin, nativeMixStop: stop,
    nativePrepareStart: vi.fn(), nativeSourceReserve: reserve, nativeSourceAppend: vi.fn() }, hooks);
  await expect(mix.startSource!({ trackId: 'a', entryId: 'e' }, { sampleRate: 48000, position: 0 }, AbortSignal.abort())).rejects.toThrow();
  expect(begin).not.toHaveBeenCalled();expect(stop).not.toHaveBeenCalled();expect(hooks.restore).not.toHaveBeenCalled();
});
it('rejects a mismatched first recording before native playback', async () => {
  const hooks = sourceHooks(), prepare = vi.fn();
  hooks.sources.mockImplementation(async entries => ({ items: entries.map(e => ({ ...e, entryId: 'changed', title: '', artist: '', duration: 3, mixingAllowed: true,
    source: { kind: 'direct' as const, url: 'https://audio.test/song.mp3' } })), previous: { trackId: 'a', duration: 3, mixingAllowed: true }, settings: DEFAULT_AUTOMIX_SETTINGS }));
  const mix = createNativeMix({ ...port(), nativePrepareStart: prepare, nativeSourceReserve: reserve, nativeSourceAppend: vi.fn() }, hooks);
  await expect(mix.startSource!({ trackId: 'a', entryId: 'e' }, { sampleRate: 48000, position: 0 })).rejects.toThrow('Изменилась запись');
  expect(prepare).not.toHaveBeenCalled();
});
it('hands off more than two upcoming sources and preserves repeat order', async () => {
  const handoff = vi.fn(async () => state);
  const mix = createNativeMix({ ...port(), nativeSourceReserve: async ({ count }) => ({ keys: Array.from({ length: count }, (_, i) => i) }),
    nativeSourceAppend: vi.fn(), nativePrepareQueue: handoff }, {
    prepare: async () => {}, restore: () => {}, sources: async entries => ({
      items: entries.map(e => ({ ...e, title: e.trackId, artist: '', duration: 180, mixingAllowed: true,
        source: { kind: 'direct' as const, url: 'https://audio.test/song.mp3' } })),
      previous: { trackId: 'seed', duration: 180, mixingAllowed: true }, settings: DEFAULT_AUTOMIX_SETTINGS,
    }),
  });
  await mix.start({ sampleRate: 48000, position: 0, tracks: [track(0)] });
  const entries = Array.from({ length: 7 }, (_, i) => ({ trackId: `track${i}`, entryId: `entry${i}` }));
  await mix.prepareQueue!(1, entries, 'seed', entries.slice().reverse());
  expect(handoff.mock.calls.at(-1)![0].manifest.items.map(t => t.entryId)).toEqual(entries.map(e => e.entryId));
  expect(handoff.mock.calls.at(-1)![0].manifest.loopItems!.map(t => t.entryId)).toEqual(entries.map(e => e.entryId).reverse());
});
it('rebinds a running session before editing its manifest after WebContent reload', async () => {
  const begin = vi.fn(async () => ({ id: 'existing-owner' })), handoff = vi.fn(async () => state), stop = vi.fn();
  const mix = createNativeMix({ ...port(), nativeMixBegin: begin, nativeMixStop: stop,
    nativeSourceReserve: async () => ({ keys: [] }), nativeSourceAppend: vi.fn(), nativePrepareQueue: handoff }, {
    prepare: async () => {}, restore: vi.fn(), sources: async () => ({ items: [],
      previous: { trackId: 'seed', duration: 180, mixingAllowed: true }, settings: DEFAULT_AUTOMIX_SETTINGS }),
  });
  await mix.prepareQueue!(1, [], 'seed');
  expect(begin).toHaveBeenCalledOnce(); expect(stop).not.toHaveBeenCalled();
  expect(handoff.mock.calls[0][0].id).toBe('existing-owner');
});
it('deduplicates local source copies and forgets leases removed by a replacement', async () => {
  const append = vi.fn(), handoff = vi.fn(async () => state), read = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'X-Native-Length': '3' } }));
  let seq = 0;
  const mix = createNativeMix({ ...port(), nativeSourceReserve: async ({ count }) => ({ keys: Array.from({ length: count }, () => ++seq) }),
    nativeSourceAppend: append, nativePrepareQueue: handoff }, {
    prepare: async () => {}, restore: () => {}, sourceFile: read, sources: async entries => ({
      items: entries.map(e => ({ ...e, title: '', artist: '', duration: 180, mixingAllowed: true,
        source: { kind: 'upload' as const, trackId: 'local-same-file' } })),
      previous: { trackId: 'seed', duration: 180, mixingAllowed: true }, settings: DEFAULT_AUTOMIX_SETTINGS,
    }),
  });
  await mix.start({ sampleRate: 48000, position: 0, tracks: [track(0)] });
  const entries = [{ trackId: 'same', entryId: 'a' }, { trackId: 'same', entryId: 'b' }];
  await mix.prepareQueue!(1, entries, 'seed'); expect(append).toHaveBeenCalledOnce();
  const items = handoff.mock.calls[0][0].manifest.items;
  expect(items[0].source).toEqual(items[1].source);
  await mix.prepareQueue!(1, [], 'seed');
  await mix.prepareQueue!(1, entries, 'seed'); expect(append).toHaveBeenCalledTimes(2);
});
it('prefetches both covers, strips URLs, and preserves the corresponding track artwork', async () => {
  const tracks = [0, 1].map(i => ({ ...track(i), coverUrl: `https://covers.test/${i}` }));
  const result = await prepareNativeMixArtwork(tracks, async url => ({ base64: url.endsWith('/0') ? 'AAAA' : 'BBBB', mime: 'image/png' }));
  expect(result.map(t => t.artwork?.base64)).toEqual(['AAAA', 'BBBB']);
  expect(result.every(t => !('coverUrl' in t))).toBe(true);
});
it('allows playback without a missing, failed or oversized cover', async () => {
  const tracks = [0, 1, 2].map(i => ({ ...track(i), ...(i ? { coverUrl: `https://covers.test/${i}` } : {}) }));
  const result = await prepareNativeMixArtwork(tracks, async url => {
    if (url.endsWith('/1')) throw Error('unavailable');
    return { base64: 'A'.repeat(2800001), mime: 'image/png' };
  });
  expect(result.every(t => !t.artwork && !('coverUrl' in t))).toBe(true);
});
it('isolates WebKit once, keeps the session for later tracks and releases it on stop', async () => {
  const order: string[] = [];
  const mix = createNativeMix(port(order), { prepare: async () => { order.push('isolate'); }, restore: () => { order.push('restore'); } });
  await mix.upload(0, 0, new ArrayBuffer(8));
  await mix.start({ sampleRate: 48000, position: 0, tracks: [track(0)] });
  await mix.upload(1, 0, new ArrayBuffer(8));
  await mix.update(1, [track(1)]);
  await mix.start({ sampleRate: 48000, position: 0, tracks: [track(1)] });
  expect(order).toEqual(['isolate', 'begin', 'append 0', 'start', 'append 1', 'update 1', 'start']);
  await mix.stop(); expect(order.slice(-2)).toEqual(['stop', 'restore']);
});
it('keeps WebKit isolated if native release fails after an upload failure', async () => {
  const restore = vi.fn();
  const mix = createNativeMix({ ...port(), nativeMixAppend: async () => { throw Error('upload'); },
    nativeMixStart: async () => { throw Error('start'); }, nativeMixStop: async () => { throw Error('release'); },
  }, { prepare: async () => {}, restore });
  await expect(mix.upload(0, 0, new ArrayBuffer(8))).rejects.toThrow('upload');
  await expect(mix.start({ sampleRate: 48000, position: 0, tracks: [track(0)] })).rejects.toThrow('release');
  expect(restore).not.toHaveBeenCalled();
});
it('does not start audio after cancellation while covers were being loaded', async () => {
  const abort = new AbortController(), start = vi.fn(), stop = vi.fn(), restore = vi.fn();
  const mix = createNativeMix({ ...port(), nativeMixStart: start, nativeMixStop: stop },
    { prepare: async () => {}, restore, artwork: async () => { abort.abort(); return undefined; } });
  await expect(mix.start({ sampleRate: 48000, position: 0,
    tracks: [0, 1].map(i => ({ ...track(i), coverUrl: 'https://cover.test/x' })) }, abort.signal)).rejects.toThrow();
  expect(start).not.toHaveBeenCalled(); expect(stop).toHaveBeenCalledOnce(); expect(restore).toHaveBeenCalledOnce();
});
it('keeps the playing queue when a replacement start fails', async () => {
  const stop = vi.fn();
  let fail = false;
  const mix = createNativeMix({ ...port(), nativeMixStop: stop,
    nativeMixStart: async () => { if (fail) throw Error('invalid'); return state; } }, { prepare: async () => {}, restore: vi.fn() });
  await mix.start({ sampleRate: 48000, position: 0, tracks: [track(0)] });
  fail = true;
  await expect(mix.start({ sampleRate: 48000, position: 0, tracks: [track(1)] })).rejects.toThrow('invalid');
  expect(stop).not.toHaveBeenCalled();
});

it('hands over only the entries the server kept and reports the dropped ones', async () => {
  const handoff = vi.fn(async () => state);
  const mix = createNativeMix({ ...port(), nativeSourceReserve: reserve, nativeSourceAppend: vi.fn(), nativePrepareQueue: handoff }, {
    prepare: async () => {}, restore: () => {}, sources: async entries => ({
      items: entries.filter(e => e.entryId !== 'entry1').map(e => ({ ...e, title: e.trackId, artist: '', duration: 180, mixingAllowed: true,
        source: { kind: 'direct' as const, url: 'https://audio.test/song.mp3' } })),
      previous: { trackId: 'seed', duration: 180, mixingAllowed: true }, settings: DEFAULT_AUTOMIX_SETTINGS }),
  });
  await mix.start({ sampleRate: 48000, position: 0, tracks: [track(0)] });
  const entries = Array.from({ length: 3 }, (_, i) => ({ trackId: `track${i}`, entryId: `entry${i}` }));
  const result = await mix.prepareQueue!(1, entries, 'seed');
  expect(handoff.mock.calls.at(-1)![0].manifest.items.map(t => t.entryId)).toEqual(['entry0', 'entry2']);
  expect(result.dropped).toEqual(['entry1']);
});
it('rejects a manifest with reordered or foreign items', async () => {
  const hooks = sourceHooks();
  hooks.sources.mockImplementation(async entries => ({ items: entries.slice().reverse().map(e => ({ ...e, title: '', artist: '', duration: 3, mixingAllowed: true,
    source: { kind: 'direct' as const, url: 'https://audio.test/song.mp3' } })), previous: { trackId: 'a', duration: 3, mixingAllowed: true }, settings: DEFAULT_AUTOMIX_SETTINGS }));
  const mix = createNativeMix({ ...port(), nativeSourceReserve: reserve, nativeSourceAppend: vi.fn(), nativePrepareQueue: vi.fn(async () => state) }, hooks);
  await mix.start({ sampleRate: 48000, position: 0, tracks: [track(0)] });
  const entries = [0, 1].map(i => ({ trackId: `track${i}`, entryId: `entry${i}` }));
  await expect(mix.prepareQueue!(1, entries, 'seed')).rejects.toThrow('Изменилась запись');
});
it('shares one levels listener and tells Swift to compute only while subscribed', async () => {
  const remove = vi.fn(async () => {}), levels = vi.fn(async () => {});
  let emit!: (e: { rms: number; bands: number[] }) => void;
  const addListener = vi.fn(async (_ev: 'levels', fn: typeof emit) => { emit = fn; return { remove }; });
  const mix = createNativeMix({ ...port(), nativeLevels: levels, addListener }, sourceHooks());
  const a = vi.fn(), b = vi.fn(), stopA = mix.onLevels!(a), stopB = mix.onLevels!(b);
  expect(addListener).toHaveBeenCalledTimes(1); expect(levels).toHaveBeenCalledWith({ on: true });
  emit({ rms: .5, bands: [1] }); expect(a).toHaveBeenCalledWith({ rms: .5, bands: [1] }); expect(b).toHaveBeenCalledTimes(1);
  stopA(); expect(levels).toHaveBeenCalledTimes(1);
  stopB(); await vi.waitFor(() => expect(remove).toHaveBeenCalled()); expect(levels).toHaveBeenLastCalledWith({ on: false });
});

it('hands the first songs over before resolving the tail, including lists larger than 1000', async () => {
  const handoff = vi.fn(async () => state);
  let release!: () => void, calls = 0, file = 0;
  const tail = new Promise<void>(resolve => { release = resolve; });
  const mix = createNativeMix({ ...port(), nativeSourceReserve: async ({ count }) => ({ keys: Array.from({ length: count }, () => file++) }),
    nativeSourceAppend: vi.fn(), nativePrepareQueue: handoff }, {
    prepare: async () => {}, restore: () => {}, sources: async entries => {
      if (++calls === 2) await tail;
      expect(entries.length).toBeLessThanOrEqual(32);
      return { items: entries.map(e => ({ ...e, title: '', artist: '', duration: 180, mixingAllowed: true,
        source: { kind: 'direct' as const, url: 'https://audio.test/song.mp3' } })),
        previous: { trackId: 'seed', duration: 180, mixingAllowed: true }, settings: DEFAULT_AUTOMIX_SETTINGS };
    },
  });
  await mix.start({ sampleRate: 48000, position: 0, tracks: [track(0)] });
  const entries = Array.from({ length: 1005 }, (_, i) => ({ trackId: 't' + i, entryId: 'e' + i }));
  const job = mix.prepareQueue!(1, entries, 'seed');
  await vi.waitFor(() => expect(handoff).toHaveBeenCalledOnce());
  expect(handoff.mock.calls[0][0].manifest.items.map(t => t.entryId)).toEqual(['e0', 'e1']);
  release(); await job;
  expect(handoff.mock.calls.at(-1)![0].manifest.items.map(t => t.entryId)).toEqual(entries.map(e => e.entryId));
});

it('keeps earlier uploads alive during queue edits and bounds metadata over all batches', async () => {
  let key = 0;
  const handoff = vi.fn(async () => state);
  const mix = createNativeMix({ ...port(), nativeSourceReserve: async ({ count }) => ({ keys: Array.from({ length: count }, () => key++) }),
    nativeSourceAppend: vi.fn(), nativePrepareQueue: handoff }, {
    prepare: async () => {}, restore: () => {},
    sourceFile: async () => new Response(new Uint8Array([1, 2, 3]), { status: 206, headers: { 'Content-Range': 'bytes 0-2/3', 'X-Native-Length': '3' } }),
    sources: async entries => ({ items: entries.map(e => ({ ...e, title: e.trackId, artist: '', duration: 180, mixingAllowed: true,
      source: { kind: 'upload' as const, trackId: e.trackId }, analysis: { data: 'x'.repeat(750000) } as any,
      artwork: { base64: 'A'.repeat(500000), mime: 'image/png' } })), previous: { trackId: 'seed', duration: 180, mixingAllowed: true }, settings: DEFAULT_AUTOMIX_SETTINGS }),
  });
  await mix.start({ sampleRate: 48000, position: 0, tracks: [track(0)] });
  const entries = Array.from({ length: 6 }, (_, i) => ({ trackId: 't' + i, entryId: 'e' + i }));
  await mix.prepareQueue!(1, entries, 'seed');
  const final = handoff.mock.calls.at(-1)![0].manifest;
  const metadata = final.items.reduce((sum, item) => sum + (item.analysis ? JSON.stringify(item.analysis).length : 0) + (item.artwork?.base64.length ?? 0), 0);
  expect(metadata).toBeLessThanOrEqual(4 * 1024 * 1024);
  expect(final.items).toHaveLength(6);
  handoff.mockClear();
  await mix.prepareQueue!(1, entries.slice().reverse(), 'seed', [], undefined, true);
  expect(handoff.mock.calls[0][0].manifest.retainedSources).toHaveLength(6);
  expect(handoff.mock.calls.at(-1)![0].manifest.retainedSources).toEqual([]);
  expect(handoff.mock.calls.at(-1)![0].manifest.items.map(item => item.entryId)).toEqual(entries.map(e => e.entryId).reverse());
});
