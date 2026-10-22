import { describe, expect, it, vi } from 'vitest';
import type { CatalogTrack } from '@automix/core';
import { CatalogPlayer } from '../src/lib/catalog-player.ts';

const song = (id: string): CatalogTrack => ({ externalId: id, title: id, artist: 'Artist', album: 'Album', duration: 180, coverUrl: null, pageUrl: null, license: null, playable: true, libraryTrackId: null, artists: [], albumId: null, explicit: false });
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { resolve, promise }; }
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function setup(prepare?: (t: CatalogTrack) => Promise<string>, allow?: (t: CatalogTrack) => boolean) {
  const listeners = new Set<() => void>();
  const transport = {
    intentVersion: 0, queueVersion: 0, state: { queue: [] as { trackId: string }[], index: 0 },
    unlockAudio: vi.fn(async () => {}),
    playTracks: vi.fn(async (ids: string[]) => { transport.intentVersion++; transport.queueVersion++; transport.state.queue = ids.map((trackId) => ({ trackId })); transport.state.index = 0; listeners.forEach((f) => f()); }),
    addToQueue: vi.fn((ids: string[]) => { transport.state.queue.push(...ids.map((trackId) => ({ trackId }))); listeners.forEach((f) => f()); }),
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
  const load = vi.fn(prepare ?? (async (t: CatalogTrack) => t.externalId));
  const notify = vi.fn();
  const player = new CatalogPlayer({ transport, prepare: load, known: () => null, exists: () => true, notify, allow });
  return { player, transport, load, notify, emit: () => listeners.forEach((f) => f()) };
}
describe('catalog listening queue', () => {
  it('does not notify listeners on transport ticks that change nothing', async () => {
    const x = setup(); await x.player.play('ab'.split('').map(song), 0, { type: 'online-radio' }); await tick();
    const seen = vi.fn(); x.player.subscribe(seen);
    for (let i = 0; i < 20; i++) { x.emit(); await tick(); }
    expect(seen).not.toHaveBeenCalled();
  });
  it('keeps an endless station to recent history while it continues in order', async () => {
    const x = setup(); await x.player.play([song('s0'), song('s1')], 0, { type: 'online-radio' }); await tick();
    const owner = x.player.sessionVersion!;
    for (let i = 2; i < 400; i++) {
      expect(x.player.extend([song(`s${i}`)], owner)).toBe(true); await tick();
      x.transport.state.index = x.transport.state.queue.length - 1; x.emit(); await tick();
    }
    expect(x.transport.state.queue.map(t => t.trackId)).toEqual(Array.from({ length: 400 }, (_, i) => `s${i}`));
    expect(x.player.sessionItems.length).toBeLessThanOrEqual(102);
    expect(x.player.remaining).toBe(0);
  });
  it('continues a station after an upcoming song is removed', async () => {
    const x = setup(); await x.player.play('abcde'.split('').map(song), 0, { type: 'online-radio' }); await tick();
    const owner = x.player.sessionVersion;
    x.transport.state.queue.splice(1, 1); x.emit(); await tick();
    expect(x.player.sessionVersion).toBe(owner);
    expect(x.transport.state.queue.map(t => t.trackId)).toEqual(['a', 'c', 'd']);
  });
  it('keeps the station when upcoming songs are cleared and accepts further recommendations', async () => {
    const x = setup(); await x.player.play('abc'.split('').map(song), 0, { type: 'online-radio' }); await tick();
    const owner = x.player.sessionVersion!;
    x.transport.state.queue = x.transport.state.queue.slice(0, 1); x.emit(); await tick();
    expect(x.player.sessionVersion).toBe(owner);
    expect(x.player.extend([song('d'), song('e')], owner)).toBe(true); await tick();
    expect(x.transport.state.queue.map(t => t.trackId)).toEqual(['a', 'd', 'e']);
  });
  it('does not show an old enqueue error over a newer successful playback', async () => {
    let reject!: (e: Error) => void;
    const old = new Promise<string>((_, fail) => { reject = fail; });
    const x = setup(async t => t.externalId === 'old' ? old : t.externalId);
    const pending = x.player.enqueue(song('old'));
    await x.player.play([song('new')], 0, { type: 'search' });
    reject(new Error('old download failed')); await pending;
    expect(x.player.state.error).toBeNull();
    expect(x.transport.state.queue.map(t => t.trackId)).toEqual(['new']);
  });
  it('does not queue a recommendation disliked while its audio was preparing', async () => {
    const slow=deferred<string>(); let allowed=true;
    const x=setup(async t=>t.externalId==='b'?slow.promise:t.externalId,t=>t.externalId!=='b'||allowed);
    await x.player.play([song('a'),song('b'),song('c')],0,{type:'online-radio',label:'Радио'});
    allowed=false;slow.resolve('b');await tick();
    expect(x.transport.state.queue.map(t=>t.trackId)).toEqual(['a','c']);
  });
  it('rejects late radio refills after a new playback session, even with identical first tracks', async () => {
    const x = setup();
    await x.player.play([song('a')], 0, { type: 'search' });
    const old = x.player.sessionVersion!;
    await x.player.play([song('a')], 0, { type: 'search' });
    expect(x.player.extend([song('late')], old)).toBe(false);
    expect(x.player.sessionItems.map((s) => s.externalId)).toEqual(['a']);
  });

  it('uses recording provider identity instead of colliding external IDs', async () => {
    const x = setup();
    const key = (t: CatalogTrack) => `${(t as CatalogTrack & { audioProvider: string }).audioProvider}:${t.externalId}`;
    const load = vi.fn(async (t: CatalogTrack) => key(t));
    const player = new CatalogPlayer({ transport: x.transport, key, prepare: load, known: () => null, exists: () => true, notify: () => {} });
    const youtube = Object.assign(song('12345678901'), { audioProvider: 'youtube' });
    const soundcloud = Object.assign(song('12345678901'), { audioProvider: 'soundcloud' });
    expect(await player.ensure(youtube)).toBe('youtube:12345678901');
    expect(await player.ensure(soundcloud)).toBe('soundcloud:12345678901');
    expect(player.known(youtube)).toBe('youtube:12345678901');
    expect(load).toHaveBeenCalledTimes(2);
  });
  it('unlocks audio in the click gesture and starts without waiting for the next download', async () => {
    const slow = deferred<string>(); const x = setup(async (t) => t.externalId === 'b' ? slow.promise : t.externalId);
    const playing = x.player.play([song('a'), song('b')], 0, { type: 'album' });
    expect(x.transport.unlockAudio).toHaveBeenCalledOnce();
    await playing; expect(x.transport.state.queue.map((t) => t.trackId)).toEqual(['a']);
    slow.resolve('b'); await tick(); expect(x.transport.state.queue.map((t) => t.trackId)).toEqual(['a', 'b']);
  });
  it('keeps only two songs ahead and refills in album order after advancing or seeking', async () => {
    const x = setup(); await x.player.play('abcdef'.split('').map(song), 0, { type: 'album' }); await tick();
    expect(x.load.mock.calls.map(([t]) => t.externalId)).toEqual(['b', 'a', 'c']);
    expect(x.transport.state.queue.map((t) => t.trackId)).toEqual(['a', 'b', 'c']);
    x.transport.intentVersion++; x.transport.state.index = 1; x.emit(); await tick();
    expect(x.transport.state.queue.map((t) => t.trackId)).toEqual(['a', 'b', 'c', 'd']);
  });
  it('lets the latest play command win over a slow earlier import', async () => {
    const old = deferred<string>(); const x = setup(async (t) => t.externalId === 'a' ? old.promise : t.externalId);
    const a = x.player.play([song('a')], 0, { type: 'search' }); await tick();
    await x.player.play([song('z')], 0, { type: 'search' }); old.resolve('a'); await a;
    expect(x.transport.state.queue.map((t) => t.trackId)).toEqual(['z']);
  });
  it('never appends stale downloads to a queue replaced by the user', async () => {
    const slow = deferred<string>(); const x = setup(async (t) => t.externalId === 'b' ? slow.promise : t.externalId);
    await x.player.play([song('a'), song('b')], 0, { type: 'album' });
    await x.transport.playTracks(['manual']); slow.resolve('b'); await tick();
    expect(x.transport.state.queue.map((t) => t.trackId)).toEqual(['manual']);
  });
  it('deduplicates concurrent imports and skips an unavailable next song', async () => {
    const x = setup(async (t) => { if (t.externalId === 'b') throw new Error('unavailable'); return t.externalId; });
    await Promise.all([x.player.ensure(song('a')), x.player.ensure(song('a'))]);
    expect(x.load).toHaveBeenCalledOnce();
    await x.player.play([song('a'), song('b'), song('c')], 0, { type: 'album' }); await tick();
    expect(x.transport.state.queue.map((t) => t.trackId)).toEqual(['a', 'c']);
    expect(x.notify).toHaveBeenCalledWith(expect.stringContaining('b'));
  });
});
