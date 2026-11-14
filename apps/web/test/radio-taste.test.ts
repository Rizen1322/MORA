import { describe, expect, it } from 'vitest';
import type { PublicTrack, Track } from '../src/lib/api.ts';
import { rankRadio, radioIdentity, tasteSeeds } from '../src/lib/radio-taste.ts';
const tune = { mood: 'normal', diversity: 'balanced', mode: 'normal' } as const;
const track = (title: string, artist: string, patch: Partial<Track> = {}) => ({ id: title, title, artist, reaction: 0, status: 'ok', addedAt: 1, playCount: 0, skipCount: 0, analysis: {}, ...patch }) as Track;
const candidate = (title: string, artist: string, patch: Partial<PublicTrack> = {}) => ({ externalId: title, title, artist, playable: true, audioProvider: 'youtube', ...patch }) as PublicTrack;
describe('personal online radio ranking', () => {
  it('keeps artist stations mostly on the artist, including across refills', () => {
    const items = [candidate('other1', 'Other'), candidate('other2', 'Another'), ...Array.from({ length: 6 }, (_, i) => candidate(`main${i}`, 'Zeta'))];
    const ranked = rankRadio(items, [], new Set(), [], { ...tune, artist: 'Zeta' });
    expect(ranked.slice(0, 6).map(t => t.artist === 'Zeta')).toEqual([true, true, false, true, true, false]);
    const refill = rankRadio(items, [], new Set(), ['Zeta', 'Zeta'], { ...tune, artist: 'Zeta' });
    expect(refill[0].artist).not.toBe('Zeta');
    expect(refill.slice(1, 3).every(t => t.artist === 'Zeta')).toBe(true);
    expect(new Set(ranked.map(radioIdentity)).size).toBe(ranked.length);
  });
  it('does not stall an artist station when its preferred candidates are recent or disliked', () => {
    const library = [track('recent', 'Zeta', { lastPlayedAt: Date.now() }), track('blocked', 'Zeta', { reaction: -1 })];
    const ranked = rankRadio([candidate('recent', 'Zeta'), candidate('blocked', 'Zeta'), candidate('fresh', 'Related')], library, new Set(), [], { ...tune, artist: 'Zeta' });
    expect(ranked.map(t => t.title)).toEqual(['fresh']);
  });
  it('spaces all credited artists across batches even when one artist dominates likes', () => {
    const lib = Array.from({ length: 12 }, (_, i) => track(`liked-${i}`, 'PHARAOH', { reaction: 1, playCount: 20 }));
    const items = Array.from({ length: 3 }, (_, round) => ['PHARAOH', 'Boulevard Depo, PHARAOH', 'OG Buda', 'SABU', 'ROCKET', 'Heronwater'].map((artist, i) => candidate(`${round}-${i}`, artist))).flat();
    const ranked = rankRadio(items, lib, new Set(), ['PHARAOH'], tune);
    expect(ranked.slice(0, 4).every(t => !t.artist.includes('PHARAOH'))).toBe(true);
    expect(ranked[4].artist).toBe('PHARAOH');
    expect(ranked[5].artist).not.toContain('PHARAOH');
  });
  it('uses the least recent artist when the pool cannot fill a four-song gap', () => {
    const ranked = rankRadio([candidate('a', 'one'), candidate('b', 'two')], [], new Set(), ['one', 'two'], tune);
    expect(ranked.map(t => t.artist)).toEqual(['one', 'two']);
  });
  it('opens balanced radio with discoveries instead of the same block of liked songs', () => {
    const lib = Array.from({length:8}, (_,i) => track(`liked-${i}`,`artist-${i}`,{reaction:1,playCount:4}));
    const items = [...lib.map(t=>candidate(t.title,t.artist)),...Array.from({length:5},(_,i)=>candidate(`fresh-${i}`,`new-${i}`))];
    const opening = rankRadio(items,lib,new Set(),[],tune).slice(0,5);
    expect(opening[0].title).toMatch(/^fresh-/);
    expect(opening.filter(t=>t.title.startsWith('liked-')).length).toBeLessThanOrEqual(2);
    expect(rankRadio(items.slice(0,8),lib,new Set(),[],tune)).toHaveLength(8);
  });
  it('takes several liked artists and rotates the seed rather than always using the last playback', () => {
    const tracks = [track('a','one',{reaction:1,likedAt:4}),track('b','one',{reaction:1,likedAt:3}),track('c','two',{reaction:1,likedAt:2}),track('d','three',{reaction:-1}),track('e','four',{playCount:50,lastPlayedAt:99})];
    expect(tasteSeeds(tracks).map(t=>t.artist)).toEqual(['one','two']);
    expect(tasteSeeds(tracks,2)[0].artist).toBe('two');
  });
  it('uses likes from other sources and excludes disliked versions with spelling differences', () => {
    const lib = [track('Ёлка','Артист',{reaction:-1}),track('Любимое','Другой',{reaction:1})];
    const ranked = rankRadio([candidate('елка','артист'),candidate('новое','Другой'),candidate('прочее','Неизвестный')],lib,new Set(),[],tune);
    expect(ranked.map(t=>t.title)).toEqual(['новое','прочее']);
  });
  it('does not repeat a song from another provider and avoids recently played records', () => {
    const a = candidate('a','one'), b = candidate('b','two');
    const seen = new Set([radioIdentity(a)]);
    expect(rankRadio([{...a,audioProvider:'soundcloud'},b], [track('b','two',{lastPlayedAt:Date.now(),reaction:1})], seen, [], tune)).toEqual([]);
  });
  it('keeps an explicit library dislike blocked when provider metadata differs', () => {
    const lib = [track('original title', 'original artist', { id: 'recording', reaction: -1 })];
    expect(rankRadio([candidate('alternate title', 'other spelling', { libraryTrackId: 'recording' })], lib, new Set(), [], tune)).toEqual([]);
  });
  it('balances familiar favourites and discoveries', () => {
    const lib = [track('like','one',{reaction:1})], items=[candidate('new','new artist'),candidate('like','one')];
    expect(rankRadio(items,lib,new Set(),[],{...tune,diversity:'familiar'})[0].title).toBe('like');
    expect(rankRadio(items,lib,new Set(),[],{...tune,diversity:'discover'})[0].title).toBe('new');
  });
  it('prefers measured beat-compatible tracks in mix mode including half/double tempo', () => {
    const anchor=track('current','one',{analysis:{bpm:140} as Track['analysis']});
    const lib=[anchor,track('bad','two',{analysis:{bpm:102} as Track['analysis']}),track('good','three',{analysis:{bpm:70} as Track['analysis']})];
    const result=rankRadio([candidate('bad','two'),candidate('good','three')],lib,new Set(),[],{...tune,mode:'mix'},anchor);
    expect(result[0].title).toBe('good');
  });
  it('does not put three songs by the same artist in a row and stops if only that artist remains', () => {
    const result=rankRadio([candidate('a','one'),candidate('b','one'),candidate('c','two')],[],new Set(),['one','one'],tune);
    expect(result[0].artist).toBe('two');
    expect(rankRadio([candidate('a','one')],[],new Set(),['one','one'],tune)).toEqual([]);
  });
  it('applies energy only when actually measured and rereads dislikes on the next batch', () => {
    const lib=[track('quiet','one',{analysis:{energy:.1} as Track['analysis']}),track('loud','two',{analysis:{energy:.9} as Track['analysis']})];
    const items=[candidate('loud','two'),candidate('quiet','one')];
    expect(rankRadio(items,lib,new Set(),[],{...tune,mood:'calm'})[0].title).toBe('quiet');
    lib[0].reaction=-1;
    expect(rankRadio(items,lib,new Set(),[],tune).map(t=>t.title)).toEqual(['loud']);
  });
});
