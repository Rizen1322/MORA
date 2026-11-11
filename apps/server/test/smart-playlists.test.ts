import { expect, it } from 'vitest';
import { duplicateValues, matchesSmartRules, validateSmartRules } from '../src/smart-playlists.ts';

const track = { genre: 'Джаз', year: 2000, reaction: 1, playCount: 4, lastPlayedAt: null };
it('combines genre, year, like, play count and recency rules, including never played tracks', () => {
  const rules = validateSmartRules({ genre: 'джаз', yearFrom: 1999, yearTo: 2001, liked: true, minPlays: 4, notPlayedDays: 30 });
  expect(matchesSmartRules(track, rules)).toBe(true);
  expect(matchesSmartRules({ ...track, year: null }, rules)).toBe(false);
  expect(matchesSmartRules({ ...track, lastPlayedAt: 900 }, rules, 1000)).toBe(false);
  expect(matchesSmartRules({ ...track, reaction: -1 }, { liked: false })).toBe(true);
  expect(() => validateSmartRules({ yearFrom: 2020, yearTo: 2000 })).toThrow();
  expect(() => validateSmartRules({ minPlays: NaN })).toThrow();
  expect(() => validateSmartRules({ sql: 'DROP TABLE tracks' })).toThrow();
});
it('keeps the most played duplicate, sums counters and lets a like win', () => {
  expect(duplicateValues([{ id: 'a', play_count: 2, skip_count: 3, last_played_at: 10, reaction: 1 },
    { id: 'b', play_count: 6, skip_count: 1, last_played_at: 20, reaction: -1 }])).toEqual({ keep: 'b', playCount: 8, skipCount: 4, lastPlayedAt: 20, reaction: 1 });
});
