import { describe, expect, it } from 'vitest';
import { likeAllSummary, likeEach, toLike } from '../src/lib/like-all.ts';

describe('like a whole playlist', () => {
  it('likes only songs without a reaction: a dislike stays', () => {
    expect(toLike([{ id: 'a', r: 0 }, { id: 'b', r: 1 }, { id: 'c', r: -1 }, { id: 'd', r: 0 }], (t) => t.r).map((t) => t.id)).toEqual(['a', 'd']);
  });
  it('sends a few requests at a time and counts failures without stopping', async () => {
    let inFlight = 0, peak = 0;
    const result = await likeEach(Array.from({ length: 10 }, (_, i) => i), async (i) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      if (i === 4) throw new Error('network');
    });
    expect(result).toEqual({ liked: 9, failed: 1 });
    expect(peak).toBe(3);
  });
  it('keeps online sources to two downloads at a time', async () => {
    let inFlight = 0, peak = 0;
    await likeEach(Array.from({ length: 6 }, (_, i) => i), async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
    }, 2);
    expect(peak).toBe(2);
  });
  it('reports what changed', () => {
    expect(likeAllSummary(5, 0, 2)).toBe('В любимое добавлено: 5 · с дизлайком оставлено как есть: 2');
    expect(likeAllSummary(0, 0, 0)).toContain('всё уже в любимом');
  });
});
