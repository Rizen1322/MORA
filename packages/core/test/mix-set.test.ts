import { expect, it } from 'vitest';
import { orderMixSet, mixSetScore, type MixSetItem } from '../src/rec/mix-set.ts';
const item = (entryId: number, bpm?: number): MixSetItem => ({ entryId, bpm, artist: String(entryId), camelot: '8A', energy: .5 });
it('improves a disordered playlist while keeping its chosen first track', () => {
  const original = [item(1, 100), item(2, 145), item(3, 103), item(4, 148)];
  const ordered = orderMixSet(original);
  const quality = (xs: MixSetItem[]) => xs.slice(1).reduce((n, t, i) => n + mixSetScore(xs[i], t), 0);
  expect(ordered[0]).toBe(original[0]); expect(quality(ordered)).toBeGreaterThan(quality(original));
});
it('recognises half/double tempo and retains duplicates and unanalysed entries', () => {
  const input = [item(1, 70), item(2, 113), item(3, 140), item(4), item(5, 140), item(6)];
  const out = orderMixSet(input);
  expect(out[1].bpm).toBe(140); expect(out.map(x => x.entryId).sort()).toEqual(input.map(x => x.entryId).sort());
  expect(out.filter(x => !x.bpm).map(x => x.entryId)).toEqual([4, 6]);
});
it('does not invent analysis or mutate the source playlist', () => {
  const input = [item(1), item(2), item(3)]; expect(orderMixSet(input)).toEqual(input);
  expect(orderMixSet(input)).not.toBe(input);
});
