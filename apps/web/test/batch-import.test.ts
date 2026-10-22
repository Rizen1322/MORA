import { describe, expect, it, vi } from 'vitest';
import { addBatch, type BatchDeps } from '../src/lib/batchImport.ts';

const deps = (over: Partial<BatchDeps> = {}): BatchDeps => ({
  importOne: async (item) => `t-${item.key}`,
  isLiked: () => false,
  like: async () => {},
  onProgress: () => {},
  cancelled: () => false,
  ...over,
});

describe('batch add of provider tracks', () => {
  it('returns source order despite reversed download completion and excludes failed likes', async () => {
    let release!: () => void;
    const first = new Promise<void>((resolve) => { release = resolve; });
    const result = await addBatch(['new', 'middle', 'old', 'failed'].map((key) => ({ key })), true, deps({
      importOne: async ({ key }) => { if (key === 'new') await first; if (key === 'old') release(); return key; },
      like: async (id) => { if (id === 'failed') throw new Error('reaction failed'); },
    }));
    expect(result.added).toEqual(['new', 'middle', 'old']);
    expect(result.failed).toBe(1);
  });
  it('keeps at most two downloads in flight and imports each track once', async () => {
    let active = 0, peak = 0;
    const importOne = vi.fn(async (item: { key: string }) => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); active--; return `t-${item.key}`; });
    const r = await addBatch(['a', 'b', 'c', 'd', 'e'].map((key) => ({ key })), false, deps({ importOne }));
    expect(peak).toBe(2);
    expect(importOne).toHaveBeenCalledTimes(5);
    expect(r.added.sort()).toEqual(['t-a', 't-b', 't-c', 't-d', 't-e']);
  });

  it('does not download tracks already in the library and likes only tracks not liked yet', async () => {
    const importOne = vi.fn(async (item: { key: string }) => `t-${item.key}`);
    const like = vi.fn(async () => {});
    const liked = new Set(['t-b', 'lib-1']);
    const r = await addBatch([{ key: 'a' }, { key: 'b' }, { key: 'c', trackId: 'lib-1' }], true, deps({ importOne, like, isLiked: (id) => liked.has(id) }));
    expect(importOne.mock.calls.map(([i]) => i.key)).toEqual(['a', 'b']);
    expect(like.mock.calls.map(([id]) => id)).toEqual(['t-a']);
    expect(r.liked).toBe(1);
  });

  it('counts failures, keeps going and stops starting new work after cancel', async () => {
    let stop = false;
    const importOne = vi.fn(async (item: { key: string }) => { if (item.key === 'b') throw new Error('нет полной записи'); if (item.key === 'c') stop = true; return `t-${item.key}`; });
    const r = await addBatch(['a', 'b', 'c', 'd', 'e', 'f'].map((key) => ({ key })), false, deps({ importOne, cancelled: () => stop }), 1);
    expect(r.failed).toBe(1);
    expect(importOne.mock.calls.map(([i]) => i.key)).toEqual(['a', 'b', 'c']);
  });
});
