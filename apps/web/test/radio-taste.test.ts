import { describe, expect, it } from 'vitest';
import type { PublicTrack, Track } from '../src/lib/api.ts';
import { rankRadio, radioIdentity, tasteSeeds } from '../src/lib/radio-taste.ts';
const tune = { mood: 'normal', diversity: 'balanced', mode: 'normal' } as const;
const track = (title: string, artist: string, patch: Partial<Track> = {}) => ({ id: title, title, artist, reaction: 0, status: 'ok', addedAt: 1, playCount: 0, skipCount: 0, analysis: {}, ...patch }) as Track;
const candidate = (title: string, artist: string, patch: Partial<PublicTrack> = {}) => ({ externalId: title, title, artist, playable: true, audioProvider: 'youtube', ...patch }) as PublicTrack;
describe('personal online radio ranking', () => {
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
