import type { BeatGrid, RepeatGroup, SongStructure, StructureSegment } from '../types.ts';
import { ANALYSIS_RATE, FRAME, MEL_BANDS, type SpectralData } from './spectral.ts';

/** Structure frames, seconds. Fixed time frames keep the result independent of the beat grid. */
export const STRUCTURE_HOP = 0.5;
/** Self-similarity is n x n: long recordings get a coarser hop so each matrix stays ~23 MB. */
const MAX_FRAMES = 2400;
const MFCC = 12;

/** Time constants in frames of `hop` (at 0.5 s: smooth 16, lag 16, repeat 24, kernel 12, segment 12). */
function frameScale(hop: number) {
  const fr = (seconds: number) => Math.max(1, Math.round(seconds / hop));
  return {
    hop,
    SMOOTH: fr(8), // diagonal smoothing of repetition paths
    MIN_LAG: fr(8), // a repeat must come at least 8 s later
    MIN_REPEAT: fr(12), // shortest repeated passage
    KERNEL: fr(6), // checkerboard half width
    MIN_SEGMENT: fr(6),
    fr,
  };
}
type FrameScale = ReturnType<typeof frameScale>;

const clamp = (x: number, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export interface StructureInput {
  sp: SpectralData;
  /** RMS dBFS curve at `curveRate`. */
  rmsDb: number[];
  curveRate: number;
  start: number;
  end: number;
  /** Track body level, dBFS. */
  body: number;
  beat: BeatGrid | null;
  /** Acoustic novelty boundaries (seconds), used as weak extra evidence. */
  boundaries?: number[];
}

/** Per-frame unit vectors: centred chroma (harmony) and z-scored MFCC 1..12 (timbre); zero in silence. */
export function structureFeatures(sp: SpectralData, rmsDb: number[], curveRate: number, start: number, end: number, body: number, hop = STRUCTURE_HOP) {
  const n = Math.max(0, Math.floor((end - start) / hop));
  const centre = FRAME / 2 / ANALYSIS_RATE;
  const chroma = new Float32Array(n * 12);
  const timbre = new Float32Array(n * MFCC);
  const level = new Float32Array(n);
  const voiced = new Uint8Array(n);
  const logMel = new Float64Array(MEL_BANDS);
  for (let i = 0; i < n; i++) {
    const a = start + i * hop, b = a + hop;
    let s = 0, c = 0;
    for (let k = Math.floor(a * curveRate); k < Math.ceil(b * curveRate) && k < rmsDb.length; k++) { s += rmsDb[k]; c++; }
    level[i] = c ? s / c : -90;
    voiced[i] = level[i] > Math.max(-70, body - 25) ? 1 : 0;
    const c0 = Math.max(0, Math.ceil((a - centre) * sp.chromaFps)), c1 = Math.min(sp.chromaFrames, Math.ceil((b - centre) * sp.chromaFps));
    for (let f = c0; f < c1; f++) for (let k = 0; k < 12; k++) chroma[i * 12 + k] += sp.chroma[f * 12 + k];
    const f0 = Math.max(0, Math.ceil((a - centre) * sp.fps)), f1 = Math.min(sp.frames, Math.ceil((b - centre) * sp.fps));
    logMel.fill(0);
    for (let f = f0; f < f1; f++) for (let k = 0; k < MEL_BANDS; k++) logMel[k] += sp.mel[f * MEL_BANDS + k];
    for (let k = 0; k < MEL_BANDS; k++) logMel[k] = Math.log10(logMel[k] / Math.max(1, f1 - f0) + 1e-10);
    for (let q = 1; q <= MFCC; q++) {
      let v = 0;
      for (let k = 0; k < MEL_BANDS; k++) v += logMel[k] * Math.cos((Math.PI * q * (k + 0.5)) / MEL_BANDS);
      timbre[i * MFCC + q - 1] = v;
    }
  }
  normalizeRows(chroma, 12, voiced);
  centreColumns(chroma, 12, voiced, false);
  normalizeRows(chroma, 12, voiced);
  centreColumns(timbre, MFCC, voiced, true);
  normalizeRows(timbre, MFCC, voiced);
  return { n, hop, start, chroma, timbre, level, voiced };
}

function normalizeRows(x: Float32Array, d: number, keep: Uint8Array) {
  for (let i = 0; i < keep.length; i++) {
    let s = 0;
    for (let k = 0; k < d; k++) s += x[i * d + k] ** 2;
    const inv = keep[i] && s > 1e-12 ? 1 / Math.sqrt(s) : 0;
    for (let k = 0; k < d; k++) x[i * d + k] *= inv;
  }
}

function centreColumns(x: Float32Array, d: number, keep: Uint8Array, scale: boolean) {
  let n = 0;
  for (const v of keep) n += v;
  if (!n) return;
  for (let k = 0; k < d; k++) {
    let m = 0, v = 0;
    for (let i = 0; i < keep.length; i++) if (keep[i]) m += x[i * d + k];
    m /= n;
    for (let i = 0; i < keep.length; i++) if (keep[i]) v += (x[i * d + k] - m) ** 2;
    const inv = scale ? 1 / Math.sqrt(v / n + 1e-12) : 1;
    for (let i = 0; i < keep.length; i++) x[i * d + k] = keep[i] ? (x[i * d + k] - m) * inv : 0;
  }
}

/** Features averaged over a centred `radius`-frame window: chord-level changes inside a section cancel out,
 * section-level changes remain for the checkerboard. */
function blurred(f: ReturnType<typeof structureFeatures>, radius: number): ReturnType<typeof structureFeatures> {
  const avg = (x: Float32Array, d: number) => {
    const out = new Float32Array(x.length);
    for (let i = 0; i < f.n; i++) {
      for (let j = Math.max(0, i - radius); j <= Math.min(f.n - 1, i + radius); j++) for (let k = 0; k < d; k++) out[i * d + k] += x[j * d + k];
    }
    normalizeRows(out, d, f.voiced);
    return out;
  };
  return { ...f, chroma: avg(f.chroma, 12), timbre: avg(f.timbre, MFCC) };
}

/** Self-similarity: 0.6 harmony + 0.4 timbre cosine, -1..1, symmetric n x n. */
export function selfSimilarity(f: ReturnType<typeof structureFeatures>): Float32Array {
  const { n, chroma, timbre } = f;
  const s = new Float32Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    let c = 0, t = 0;
    for (let k = 0; k < 12; k++) c += chroma[i * 12 + k] * chroma[j * 12 + k];
    for (let k = 0; k < MFCC; k++) t += timbre[i * MFCC + k] * timbre[j * MFCC + k];
    s[i * n + j] = s[j * n + i] = 0.6 * c + 0.4 * t;
  }
  return s;
}

/** Self-similarity inside the band |i - j| <= w only, row-major with stride 2w + 1; same values as selfSimilarity there. */
function bandSimilarity(f: ReturnType<typeof structureFeatures>, w: number): Float32Array {
  const { n, chroma, timbre } = f;
  const stride = 2 * w + 1;
  const s = new Float32Array(n * stride);
  for (let i = 0; i < n; i++) for (let j = Math.max(0, i - w); j <= i; j++) {
    let c = 0, t = 0;
    for (let k = 0; k < 12; k++) c += chroma[i * 12 + k] * chroma[j * 12 + k];
    for (let k = 0; k < MFCC; k++) t += timbre[i * MFCC + k] * timbre[j * MFCC + k];
    s[i * stride + j - i + w] = s[j * stride + i - j + w] = 0.6 * c + 0.4 * t;
  }
  return s;
}

/** Foote checkerboard novelty with a Gaussian taper, clipped to >= 0. Reads only |row - col| < 2 * KERNEL,
 * so `s` is a band of half width 2 * KERNEL - 1 (see bandSimilarity). */
function checkerboard(s: Float32Array, n: number, { KERNEL }: FrameScale): Float32Array {
  const out = new Float32Array(n);
  const w = 2 * KERNEL - 1, stride = 2 * w + 1;
  const g = Array.from({ length: 2 * KERNEL }, (_, a) => Math.exp(-0.5 * ((a - KERNEL + 0.5) / (KERNEL * 0.5)) ** 2));
  let wsum = 0;
  for (const a of g) for (const b of g) wsum += a * b;
  for (let i = KERNEL; i <= n - KERNEL; i++) {
    let v = 0;
    for (let a = 0; a < 2 * KERNEL; a++) {
      const row = (i - KERNEL + a) * stride + w - a;
      for (let b = 0; b < 2 * KERNEL; b++) v += (a < KERNEL === b < KERNEL ? 1 : -1) * g[a] * g[b] * s[row + b];
    }
    out[i] = Math.max(0, v / wsum);
  }
  return out;
}

interface Repeat { lag: number; from: number; to: number; score: number }

/** Diagonal repetition paths in time-lag form: later passage [from, to) repeats [from - lag, to - lag). */
export function repetitionPaths(s: Float32Array, n: number, { SMOOTH, MIN_LAG, MIN_REPEAT }: FrameScale = frameScale(STRUCTURE_HOP)): { paths: Repeat[]; threshold: number } {
  // lag l only looks at rows l - 2 .. l + 2: pass 1 collects the threshold pool, pass 2 keeps five rows
  const fill = (l: number, row: Float32Array, pool?: Float32Array, at = 0) => {
    row.fill(-1);
    if (l >= MIN_LAG - 1 && l + SMOOTH <= n) {
      let acc = 0;
      for (let k = 0; k < SMOOTH; k++) acc += s[(l + k) * n + k];
      for (let i = l; i + SMOOTH <= n; i++) {
        row[i] = acc / SMOOTH;
        if (pool && (i & 3) === 0) pool[at++] = row[i];
        if (i + SMOOTH < n) acc += s[(i + SMOOTH) * n + i + SMOOTH - l] - s[i * n + i - l];
      }
    }
    return at;
  };
  // multiples of 4 in [l, n - SMOOTH] summed over the filled lags
  let size = 0;
  for (let l = Math.max(0, MIN_LAG - 1); l + SMOOTH <= n; l++) size += Math.floor((n - SMOOTH) / 4) - Math.ceil(l / 4) + 1;
  const pool = new Float32Array(size), scratch = new Float32Array(n);
  for (let l = 0, at = 0; l < n; l++) at = fill(l, scratch, pool, at);
  pool.sort();
  const threshold = Math.max(0.3, pool[Math.floor(pool.length * 0.9)] ?? 1);
  const ring = Array.from({ length: 5 }, () => ({ l: -1, row: new Float32Array(n) }));
  const row = (m: number): Float32Array | undefined => {
    if (m < 0 || m >= n) return undefined;
    const slot = ring[m % 5];
    if (slot.l !== m) { fill(m, slot.row); slot.l = m; }
    return slot.row;
  };
  const raw = (l: number, i: number) => {
    let v = 0, c = 0;
    for (let k = i - 1; k <= i + 1; k++) if (k - l >= 0 && k < n) { v += s[k * n + k - l]; c++; }
    return c ? v / c : -1;
  };
  const candidates: Repeat[] = [];
  for (let l = MIN_LAG; l + SMOOTH < n; l++) {
    const w = [l - 2, l - 1, l, l + 1, l + 2].map(row);
    const mark = (i: number) => [1, 2, 3].some((m) => w[m] && w[m]![i] >= threshold && w[m]![i] >= (w[m - 1]?.[i] ?? -1) && w[m]![i] >= (w[m + 1]?.[i] ?? -1));
    let i = l;
    while (i < n) {
      if (!mark(i)) { i++; continue; }
      let j = i, gap = 0, sum = 0, cnt = 0;
      for (let k = i; k < n && gap <= 3; k++) {
        if (mark(k)) { j = k; gap = 0; sum += Math.max(w[1]![k], w[2]![k], w[3]?.[k] ?? -1); cnt++; } else gap++;
      }
      // the window starting at j still matched: the passage ends somewhere in [j, j + SMOOTH);
      // trim weakly similar edges relative to the path's own strength
      const score = sum / cnt, edge = Math.max(threshold, 0.6 * score);
      let from = i, to = Math.min(n, j + SMOOTH);
      while (to - 1 > j && raw(l, to - 1) < edge) to--;
      while (from < j && raw(l, from) < edge) from++;
      if (to - from >= MIN_REPEAT && l >= (to - from) * 0.9) candidates.push({ lag: l, from, to, score });
      i = j + 1;
    }
  }
  // neighbouring lags see the same path; keep the strongest
  candidates.sort((a, b) => b.score * (b.to - b.from) - a.score * (a.to - a.from));
  const paths: Repeat[] = [];
  for (const c of candidates) {
    if (paths.some((p) => Math.abs(p.lag - c.lag) <= 2 && Math.min(p.to, c.to) - Math.max(p.from, c.from) > 0.5 * Math.min(p.to - p.from, c.to - c.from))) continue;
    paths.push(c);
  }
  return { paths, threshold };
}

/** Repetition structure of a track; null when there is too little audio for a 12 s repeat. */
export function analyzeStructure(input: StructureInput): SongStructure | null {
  const { start, end, beat } = input;
  const k = frameScale(Math.max(STRUCTURE_HOP, (end - start) / MAX_FRAMES));
  const { MIN_SEGMENT, fr } = k;
  const f = structureFeatures(input.sp, input.rmsDb, input.curveRate, start, end, input.body, k.hop);
  const n = f.n, hop = f.hop;
  if (n < k.MIN_LAG + k.MIN_REPEAT) return null;
  const s = selfSimilarity(f);
  const { paths } = repetitionPaths(s, n, k);
  const time = (i: number) => start + i * hop;
  const frameOf = (t: number) => Math.round((t - start) / hop);

  // ---- boundaries: checkerboard novelty, repeat endpoints, acoustic changes
  const nov = checkerboard(bandSimilarity(blurred(f, fr(4)), 2 * k.KERNEL - 1), n, k);
  const novSorted = Array.from(nov).sort((a, b) => a - b);
  const novNorm = Math.max(1e-6, novSorted[Math.floor(novSorted.length * 0.98)]);
  const ends = new Float32Array(n);
  const bump = (arr: Float32Array, at: number, weight: number) => {
    for (let i = Math.max(0, at - fr(2)); i < Math.min(n, at + fr(2) + 1); i++) arr[i] += weight * Math.exp(-0.5 * ((i - at) / (0.75 / hop)) ** 2);
  };
  for (const p of paths) for (const at of [p.from, p.to, p.from - p.lag, p.to - p.lag]) bump(ends, at, clamp(p.score));
  const acoustic = new Float32Array(n);
  for (const t of input.boundaries ?? []) bump(acoustic, frameOf(t), 1);
  // a repeat endpoint alone also appears halfway through sections built from two equal halves;
  // without a timbre/harmony change it needs two agreeing paths
  const evidence = Array.from({ length: n }, (_, i) => 0.5 * clamp(nov[i] / novNorm) + 0.35 * clamp(ends[i] / 2) + 0.15 * clamp(acoustic[i]));
  const peaks = evidence
    .map((v, i) => ({ i, v }))
    .filter(({ i, v }) => v >= 0.3 && i >= fr(4) && i <= n - fr(4) && evidence.slice(Math.max(0, i - fr(3)), i + fr(3) + 1).every((x) => x <= v));
  peaks.sort((a, b) => b.v - a.v);
  const cuts: { i: number; v: number }[] = [];
  for (const p of peaks) if (cuts.every((c) => Math.abs(c.i - p.i) >= MIN_SEGMENT)) cuts.push(p);
  cuts.sort((a, b) => a.i - b.i);
  const gridOk = !!beat && beat.stable && beat.downbeatConfidence >= 0.25 && beat.downbeats.length > 0;
  const snap = (t: number) => {
    if (!gridOk) return t;
    const d = beat!.downbeats.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a));
    return Math.abs(d - t) <= Math.min(1, beat!.period * 2) ? d : t;
  };
  let bounds = [{ t: start, i: 0, v: 0 }, ...cuts.map((c) => ({ t: snap(time(c.i)), i: c.i, v: c.v })), { t: end, i: n, v: 1 }];

  // ---- segment-to-segment repetition: share of p's frames whose path partner lies in q
  const link = (bounds: { i: number }[]) => {
    const nSeg = bounds.length - 1;
    const segOf = new Int16Array(n);
    for (let k = 0; k < nSeg; k++) for (let i = bounds[k].i; i < bounds[k + 1].i; i++) segOf[i] = k;
    const hits = Array.from({ length: nSeg }, () => new Map<number, Set<number>>());
    const simSum = Array.from({ length: nSeg }, () => new Map<number, number>());
    const addHit = (fr: number, partner: number) => {
      const p = segOf[fr], q = segOf[partner];
      if (p === q) return;
      let set = hits[p].get(q);
      if (!set) hits[p].set(q, (set = new Set()));
      if (set.has(fr)) return;
      set.add(fr);
      simSum[p].set(q, (simSum[p].get(q) ?? 0) + s[fr * n + partner]);
    };
    for (const p of paths) for (let i = p.from; i < p.to; i++) { addHit(i, i - p.lag); addHit(i - p.lag, i); }
    const len = (k: number) => bounds[k + 1].i - bounds[k].i;
    const cover = (p: number, q: number) => (hits[p].get(q)?.size ?? 0) / Math.max(1, len(p));
    const sim = (p: number, q: number) => (simSum[p].get(q) ?? 0) / Math.max(1, hits[p].get(q)?.size ?? 0);
    const parent = Array.from({ length: nSeg }, (_, i) => i);
    const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i])));
    const linked = (p: number, q: number) => Math.min(cover(p, q), cover(q, p)) >= 0.4 && Math.min(len(p), len(q)) >= 0.5 * Math.max(len(p), len(q));
    for (let p = 0; p < nSeg; p++) for (let q = p + 1; q < nSeg; q++) if (linked(p, q)) parent[root(q)] = root(p);
    return { nSeg, hits, len, sim, root, linked };
  };
  // adjacent pieces of one group that do not repeat each other are halves of one occurrence
  let linkage = link(bounds);
  for (let pass = 0; pass < 4; pass++) {
    const drop = new Set<number>();
    for (let k = 0; k + 1 < linkage.nSeg; k++) if (!drop.has(k) && linkage.root(k) === linkage.root(k + 1) && !linkage.linked(k, k + 1)) drop.add(k + 1);
    if (!drop.size) break;
    bounds = bounds.filter((_, b) => !drop.has(b));
    linkage = link(bounds);
  }
  const { nSeg, hits, len, sim, root } = linkage;

  // ---- per-segment level and trend
  const levelOf = (k: number) => {
    const a = bounds[k].i, b = bounds[k + 1].i;
    let m = 0, c = 0;
    for (let i = a; i < b; i++) if (f.voiced[i]) { m += f.level[i]; c++; }
    m = c ? m / c : -90;
    let sxy = 0, sxx = 0;
    const mid = (a + b - 1) / 2;
    for (let i = a; i < b; i++) if (f.voiced[i]) { sxy += (i - mid) * (f.level[i] - m); sxx += (i - mid) ** 2; }
    return { rmsDb: m, slope: sxx > 0 ? (sxy / sxx) * (10 / hop) : 0 };
  };
  const levels = Array.from({ length: nSeg }, (_, k) => levelOf(k));
  const audible = Math.max(1, end - start);
  const meanRel = levels.reduce((a, l, k) => a + (l.rmsDb - input.body) * len(k), 0) / Math.max(1, n);

  // ---- groups and the chorus heuristic
  const members = new Map<number, number[]>();
  for (let k = 0; k < nSeg; k++) members.set(root(k), [...(members.get(root(k)) ?? []), k]);
  const groups: RepeatGroup[] = [];
  const groupOf = new Int16Array(nSeg).fill(-1);
  for (const list of members.values()) {
    if (list.length < 2) continue;
    const id = groups.length;
    let simTotal = 0, pairs = 0, rel = 0, frames = 0;
    for (const p of list) {
      groupOf[p] = id;
      rel += (levels[p].rmsDb - input.body) * len(p);
      frames += len(p);
      for (const q of list) if (q > p && hits[p].has(q)) { simTotal += sim(p, q); pairs++; }
    }
    const similarity = pairs ? simTotal / pairs : 0;
    const relDb = rel / frames;
    const meanLen = (frames * hop) / list.length;
    const share = (frames * hop) / audible;
    const fRep = list.length >= 3 ? 1 : 0.7;
    const fEn = clamp(0.5 + (relDb - meanRel) / 4);
    const fSim = clamp((similarity - 0.3) / 0.4);
    const fLen = clamp(1 - Math.max(0, 10 - meanLen) / 6 - Math.max(0, meanLen - 45) / 30);
    const fPos = bounds[list[0]].t > start + 10 ? 1 : 0.4;
    const fCov = clamp((0.75 - share) / 0.15);
    const chorusLikelihood = r3(fRep * fCov * (0.35 * fEn + 0.25 * fSim + 0.2 * fLen + 0.2 * fPos));
    groups.push({
      id,
      occurrences: list.map((k) => ({ start: r3(bounds[k].t), end: r3(bounds[k + 1].t) })),
      similarity: r3(clamp(similarity)),
      relDb: Math.round(relDb * 10) / 10,
      chorusLikelihood,
    });
  }
  const ranked = [...groups].sort((a, b) => b.chorusLikelihood - a.chorusLikelihood);
  let likelyChorus: SongStructure['likelyChorus'];
  const best = ranked[0], second = ranked[1]?.chorusLikelihood ?? 0;
  if (best && best.chorusLikelihood >= 0.5 && best.chorusLikelihood - second >= 0.08) {
    const tags = [`repeats-${best.occurrences.length}x`];
    if (best.relDb - meanRel > 1) tags.push('louder-than-average');
    if (best.similarity > 0.6) tags.push('strong-repetition');
    likelyChorus = { group: best.id, confidence: r3(0.9 * best.chorusLikelihood * (0.6 + 0.4 * clamp((best.chorusLikelihood - second) / 0.25))), tags };
  }

  // ---- closure at each segment end: a repeat ends there, the boundary is strong, whole 4-bar units
  const bars = gridOk ? beat!.period * 4 : 0;
  const segments: StructureSegment[] = [];
  let repeated = 0;
  for (let k = 0; k < nSeg; k++) {
    const g = groupOf[k];
    const nextAt = bounds[k + 1].i;
    let barFit = 0.5;
    if (bars > 0) {
      const units = (bounds[k + 1].t - bounds[k].t) / bars;
      const off = (m: number) => Math.abs(units / m - Math.round(units / m));
      barFit = off(4) < 0.07 ? 1 : off(2) < 0.13 ? 0.7 : off(1) < 0.25 ? 0.4 : 0.1;
    }
    const endClosure = k === nSeg - 1 ? 1 : clamp(0.4 * clamp(ends[Math.min(n - 1, nextAt)]) + 0.35 * bounds[k + 1].v + 0.25 * barFit);
    let bestSim = 0;
    if (g >= 0) for (let q = 0; q < nSeg; q++) if (q !== k && groupOf[q] === g && hits[k].has(q)) bestSim = Math.max(bestSim, sim(k, q));
    if (g >= 0) repeated += bounds[k + 1].t - bounds[k].t;
    segments.push({
      start: r3(bounds[k].t),
      end: r3(bounds[k + 1].t),
      group: g,
      occurrence: g >= 0 ? groups[g].occurrences.findIndex((o) => Math.abs(o.start - r3(bounds[k].t)) < 1e-6) : -1,
      repeatSimilarity: r3(clamp(bestSim)),
      chorusLikelihood: g >= 0 ? groups[g].chorusLikelihood : 0,
      rmsDb: Math.round(levels[k].rmsDb * 10) / 10,
      relDb: Math.round((levels[k].rmsDb - input.body) * 10) / 10,
      slopeDb: Math.round(levels[k].slope * 10) / 10,
      novelty: r3(clamp(bounds[k].v)),
      endClosure: r3(endClosure),
    });
  }
  return {
    method: 'ssm-repeat-1',
    segments,
    groups,
    likelyChorus,
    repetitionCoverage: r3(repeated / audible),
    gridCheck: beat ? gridCheck(input.sp, paths, hop, start, beat) : undefined,
  };
}

/** Refines each repetition lag on raw chroma frames (~46 ms) and expresses it in beats of the grid.
 * A correct grid puts repeats a whole number of bars apart. */
function gridCheck(sp: SpectralData, paths: Repeat[], hop: number, start: number, beat: BeatGrid): SongStructure['gridCheck'] {
  const fps = sp.chromaFps, n = sp.chromaFrames, centre = FRAME / 2 / ANALYSIS_RATE;
  const c = new Float32Array(sp.chroma);
  const keep = new Uint8Array(n).fill(1);
  normalizeRows(c, 12, keep);
  centreColumns(c, 12, keep, false);
  normalizeRows(c, 12, keep);
  const errors: number[] = [];
  const lagBeats: number[] = [];
  let whole = 0, barWhole = 0, triple = 0;
  for (const p of paths.filter((x) => x.score >= 0.4).slice(0, 24)) {
    const base = Math.round(p.lag * hop * fps);
    const a = Math.max(base + 12, Math.ceil((start + p.from * hop - centre) * fps)), b = Math.min(n, Math.floor((start + p.to * hop - centre) * fps));
    if (b - a < fps * 6) continue;
    const score = (lag: number) => {
      let v = 0, m = 0;
      for (let t = a; t < b; t += 2) { for (let k = 0; k < 12; k++) v += c[t * 12 + k] * c[(t - lag) * 12 + k]; m++; }
      return v / Math.max(1, m);
    };
    const R = Math.ceil(fps * 0.6);
    let bestD = 0, bestV = -Infinity;
    const vals = new Map<number, number>();
    for (let d = -R; d <= R; d++) { const v = score(base + d); vals.set(d, v); if (v > bestV) { bestV = v; bestD = d; } }
    const l = vals.get(bestD - 1), r = vals.get(bestD + 1);
    const frac = l !== undefined && r !== undefined && l - 2 * bestV + r < 0 ? clamp((l - r) / (2 * (l - 2 * bestV + r)), -0.5, 0.5) : 0;
    const beats = (base + bestD + frac) / fps / beat.period;
    const err = Math.abs(beats - Math.round(beats));
    errors.push(err);
    lagBeats.push(Math.round(beats * 100) / 100);
    if (err < 0.15) {
      whole++;
      const k = Math.round(beats);
      if (k % 4 === 0) barWhole++;
      else if (k % 3 === 0) triple++;
    }
  }
  if (!errors.length) return undefined;
  // a 3:2 or 4:3 tempo error (syncopation, triplet feel) leaves every lag a whole number of *true* beats
  const wholeShare = (r: number) => lagBeats.filter((b) => Math.abs(b / r - Math.round(b / r)) < 0.15).length / lagBeats.length;
  let periodHint: { bpm: number; share: number } | undefined;
  if (lagBeats.length >= 4 && whole / lagBeats.length < 0.5) {
    for (const r of [2 / 3, 4 / 3, 3 / 2, 3 / 4]) {
      const share = wholeShare(r), bpm = 60 / (beat.period * r);
      if (share >= 0.8 && (!periodHint || Math.abs(Math.log(bpm / 120)) < Math.abs(Math.log(periodHint.bpm / 120)))) periodHint = { bpm: Math.round(bpm * 100) / 100, share: r3(share) };
    }
  }
  errors.sort((x, y) => x - y);
  return {
    lags: errors.length,
    beatIntegerShare: r3(whole / errors.length),
    barIntegerShare: r3(whole ? barWhole / whole : 0),
    tripleShare: r3(whole ? triple / whole : 0),
    medianBeatError: r3(errors[Math.floor(errors.length / 2)]),
    lagBeats,
    ...(periodHint ? { periodHint } : {}),
  };
}

/** 0..1 how well a musical unit closes at `t` (exit point quality); low inside a segment, lowest inside a likely chorus. */
export function closureAt(st: SongStructure, t: number, tolerance = 1.5): number {
  for (let k = 0; k < st.segments.length; k++) {
    const seg = st.segments[k];
    if (Math.abs(seg.end - t) <= tolerance) return seg.endClosure;
    if (k === 0 && Math.abs(seg.start - t) <= tolerance) return 0.5;
  }
  const inside = st.segments.find((seg) => t > seg.start && t < seg.end);
  return inside ? 0.15 * (1 - inside.chorusLikelihood) : 0;
}

/** Musical cost of skipping B from `from` to `to`, in weighted seconds: a likely chorus costs up to
 * 1 per second, other music 0.25, a quiet unique opening segment 0.1. */
export function skipCost(st: SongStructure, from: number, to: number): number {
  let cost = 0;
  st.segments.forEach((seg, k) => {
    const overlap = Math.min(to, seg.end) - Math.max(from, seg.start);
    if (overlap <= 0) return;
    const weight = k === 0 && seg.group < 0 && seg.relDb < -3 ? 0.1 : 0.25 + 0.75 * seg.chorusLikelihood;
    cost += overlap * weight;
  });
  return Math.round(cost * 100) / 100;
}
