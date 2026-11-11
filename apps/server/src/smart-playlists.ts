import type { TrackDTO } from './library.ts';

export interface SmartRules { genre?: string; yearFrom?: number; yearTo?: number; liked?: boolean; minPlays?: number; notPlayedDays?: number }
export function validateSmartRules(value: unknown): SmartRules {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Неверные правила плейлиста');
  const rules = value as SmartRules;
  if (Object.keys(rules).some(key => !['genre', 'yearFrom', 'yearTo', 'liked', 'minPlays', 'notPlayedDays'].includes(key))
    || (rules.genre !== undefined && (typeof rules.genre !== 'string' || rules.genre.length > 100))
    || (rules.liked !== undefined && typeof rules.liked !== 'boolean')
    || [rules.yearFrom, rules.yearTo, rules.minPlays, rules.notPlayedDays].some(n => n !== undefined && (!Number.isSafeInteger(n) || n < 0 || n > 1000000))
    || (rules.yearFrom !== undefined && rules.yearTo !== undefined && rules.yearFrom > rules.yearTo)) throw Error('Неверные правила плейлиста');
  return rules;
}
export function matchesSmartRules(track: Pick<TrackDTO, 'genre' | 'year' | 'reaction' | 'playCount' | 'lastPlayedAt'>, rules: SmartRules, now = Date.now()): boolean {
  return (!rules.genre || track.genre.toLocaleLowerCase('ru').includes(rules.genre.toLocaleLowerCase('ru')))
    && (rules.yearFrom === undefined || (track.year !== null && track.year >= rules.yearFrom))
    && (rules.yearTo === undefined || (track.year !== null && track.year <= rules.yearTo))
    && (rules.liked === undefined || (track.reaction > 0) === rules.liked)
    && (rules.minPlays === undefined || track.playCount >= rules.minPlays)
    && (rules.notPlayedDays === undefined || track.lastPlayedAt === null || now - track.lastPlayedAt >= rules.notPlayedDays * 86400000);
}

export function duplicateValues(rows: { id: string; play_count: number; skip_count: number; last_played_at: number | null; reaction: number }[]) {
  if (rows.length < 2) throw Error('Дубликаты не найдены');
  const keep = [...rows].sort((a, b) => b.play_count - a.play_count || a.id.localeCompare(b.id))[0].id;
  return { keep, playCount: rows.reduce((n, row) => n + row.play_count, 0), skipCount: rows.reduce((n, row) => n + row.skip_count, 0),
    lastPlayedAt: Math.max(0, ...rows.map(row => row.last_played_at ?? 0)) || null,
    reaction: rows.some(row => row.reaction > 0) ? 1 : rows.some(row => row.reaction < 0) ? -1 : 0 };
}
