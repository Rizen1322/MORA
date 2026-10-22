import { camelotCompatibility } from '../mir/key.ts';
import { tempoRelation } from '../plan/planner.ts';

export interface MixSetItem {
  entryId: number;
  artist: string;
  bpm?: number | null;
  camelot?: string;
  energy?: number;
  mixingAllowed?: boolean;
}
const folded = (bpm: number) => { while (bpm < 90) bpm *= 2; while (bpm >= 180) bpm /= 2; return bpm; };
export function mixSetScore(a: MixSetItem, b: MixSetItem): number {
  const tempo = a.bpm && b.bpm ? Math.exp(-tempoRelation(a.bpm, b.bpm).stretchPercent / 5) : .3;
  const key = a.camelot && b.camelot ? camelotCompatibility(a.camelot, b.camelot).score : .5;
  const energy = a.energy !== undefined && b.energy !== undefined ? Math.max(0, 1 - Math.abs(a.energy - b.energy) * 2) : .5;
  return tempo * .6 + key * .25 + energy * .15;
}

/** Measured metadata only. Bounded 96-candidate search; preserves every playlist occurrence. */
export function orderMixSet<T extends MixSetItem>(items: T[], mode: 'smooth' | 'build' = 'smooth'): T[] {
  if (items.length > 10_000) throw new RangeError('Для одного микса поддерживается до 10 000 позиций');
  if (items.length < 3) return items.slice();
  const usable = (t: T) => t.mixingAllowed !== false && Number.isFinite(t.bpm) && t.bpm! >= 20 && t.bpm! <= 400;
  if (!items.some(usable)) return items.slice();
  const first = items[0], out = [first];
  const unknown = items.slice(1).filter(t => !usable(t));
  const pool = items.slice(1).filter(usable).sort((a, b) => folded(a.bpm!) - folded(b.bpm!));
  while (pool.length) {
    const previous = out[out.length - 1], targetBpm = usable(previous) ? folded(previous.bpm!) : folded(pool[0].bpm!);
    let lo = 0, hi = pool.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (folded(pool[mid].bpm!) < targetBpm) lo = mid + 1; else hi = mid; }
    const from = Math.max(0, Math.min(lo - 48, pool.length - 96)), to = Math.min(pool.length, from + 96);
    let best = from, bestScore = -Infinity;
    for (let i = from; i < to; i++) {
      const t = pool[i];
      let score = mixSetScore(previous, t);
      if (t.artist && out.slice(-3).some(x => x.artist.toLocaleLowerCase() === t.artist.toLocaleLowerCase())) score -= .12;
      if (mode === 'build' && t.energy !== undefined) score -= Math.abs(t.energy - (.2 + .65 * out.length / items.length)) * .4;
      if (score > bestScore) { best = i; bestScore = score; }
    }
    out.push(pool.splice(best, 1)[0]);
  }
  return [...out, ...unknown];
}
