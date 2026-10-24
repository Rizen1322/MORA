import { describe, expect, it } from 'vitest';
import type { PlayerSnapshot, QueueEntry } from '../src/audio/controller.ts';
import type { PublicTrack, Track } from '../src/lib/api.ts';
import { CONTINUE_LEAD_SECONDS, artistSeeds, continuationFilter, continuationLabel, continuationSeeds, wantsContinuation } from '../src/lib/continue-radio.ts';

const song = (id: string, artist = `artist ${id}`, reaction = 0) => ({ id, title: `song ${id}`, artist, reaction, status: 'ok', playCount: 0, addedAt: 1, analysis: {} } as unknown as Track);
const entries = (ids: string[]): QueueEntry[] => ids.map((id) => ({ entryId: `${id}-entry`, trackId: id, origin: 'context' }));
const candidate = (id: string, artist: string) => ({ externalId: id, title: id, artist, playable: true, audioProvider: 'youtube' } as PublicTrack);
const transport = (patch: Partial<PlayerSnapshot> = {}) => ({ status: 'playing', queue: entries(['a', 'b', 'c']), index: 2, repeat: 'off',
  context: { type: 'playlist', id: 'p1', label: 'Летний' }, position: 200, duration: 240, ...patch } as PlayerSnapshot);

describe('queue-end radio: when to continue', () => {
  it('picks the continuation ahead of time on the last song of a finite queue', () => {
    expect(wantsContinuation(transport(), true)).toBe(true);
    expect(wantsContinuation(transport({ position: 240 - CONTINUE_LEAD_SECONDS - 5 }), true)).toBe(false);
    expect(wantsContinuation(transport({ index: 1 }), true)).toBe(false);
  });
  it('never continues with repeat, while paused, when switched off, inside a station or a transition check', () => {
    expect(wantsContinuation(transport({ repeat: 'all' }), true)).toBe(false);
    expect(wantsContinuation(transport({ repeat: 'one' }), true)).toBe(false);
    expect(wantsContinuation(transport({ status: 'paused' }), true)).toBe(false);
    expect(wantsContinuation(transport(), false)).toBe(false);
    for (const type of ['wave', 'yandex-wave', 'online-radio'] as const) expect(wantsContinuation(transport({ context: { type, label: 'x' } }), true)).toBe(false);
    expect(wantsContinuation(transport({ context: { type: 'queue', id: 'preview', label: 'Прослушивание перехода' } }), true)).toBe(false);
  });
});

describe('queue-end radio: seeds and exclusions', () => {
  it('seeds from songs heard to the end and the playing one, never skipped or disliked, liked first', () => {
    const lib = new Map([song('a', 'A', 1), song('b'), song('c', 'C', -1), song('d'), song('e')].map((t) => [t.id, t]));
    const queue = entries(['a', 'b', 'c', 'd', 'e']);
    // b was skipped, c disliked; e plays now
    const seeds = continuationSeeds(queue, 4, new Set(['a-entry', 'c-entry', 'd-entry']), (id) => lib.get(id));
    expect(seeds.map((t) => t.id)).toEqual(['a', 'e', 'd']);
  });
  it('falls back to the playing song when everything before it was skipped', () => {
    const lib = new Map([song('a'), song('b')].map((t) => [t.id, t]));
    expect(continuationSeeds(entries(['a', 'b']), 1, new Set(), (id) => lib.get(id)).map((t) => t.id)).toEqual(['b']);
  });
  it('excludes songs of this session and artists turned down repeatedly', () => {
    const queue = entries(['a']);
    const lib = [song('a', 'Heard'), song('x1', 'Nope', -1), song('x2', 'Nope', -1), song('y', 'Once', -1), song('m1', 'Mixed', -1), song('m2', 'Mixed', -1), song('m3', 'Mixed', 1)];
    const { seen, allow } = continuationFilter(queue, (id) => lib.find((t) => t.id === id), lib);
    expect(seen.has('heard|song a')).toBe(true);
    expect(allow(candidate('1', 'Nope feat. Someone'))).toBe(false);
    expect(allow(candidate('2', 'Once'))).toBe(true);
    expect(allow(candidate('3', 'Mixed'))).toBe(true);
  });
  it('seeds an artist station from their library songs, liked first, then the catalog, or the bare name', () => {
    const lib = [{ ...song('p', 'Zeta'), playCount: 5 }, song('l', 'Zeta', 1), song('d', 'Zeta', -1), song('o', 'Other', 1)];
    expect(artistSeeds('Zeta', lib, [{ title: 'hit', artist: 'Zeta' }, { title: 'song l', artist: 'Zeta' }])).toEqual([
      { title: 'song l', artist: 'Zeta' }, { title: 'song p', artist: 'Zeta' }, { title: 'hit', artist: 'Zeta' }]);
    expect(artistSeeds('Nobody', lib)).toEqual([{ title: '', artist: 'Nobody' }]);
  });
  it('names the station after the playlist, or after the artist for an ad-hoc queue', () => {
    expect(continuationLabel({ type: 'album', label: 'Abbey Road' }, song('a'))).toBe('Радио по мотивам «Abbey Road»');
    expect(continuationLabel({ type: 'queue', label: 'Очередь' }, song('a', 'Björk'))).toBe('Радио по мотивам «Björk»');
  });
});
