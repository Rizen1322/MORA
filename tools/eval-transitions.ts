/**
 * Objective checks of AutoMix transitions on real decoded files.
 * Renders every ordered pair through the engine (same MixerCore as the
 * browser) and measures:
 *   - loudness continuity: short-term loudness (3 s K-weighted) across the
 *     transition compared with the level of A before and B after (bump / dip, LU)
 *   - bass clash: seconds where both decks contribute low band at > -6 dB
 *   - limiter: maximum gain reduction (dB)
 *   - cut: seconds of A's audible music skipped after the transition ends
 *
 *   npx tsx tools/eval-transitions.ts [folder] [--pairs N]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  ANALYZER_VERSION,
  PLANNER_VERSION,
  analyzePcm,
  DEFAULT_AUTOMIX_SETTINGS,
  planTransition,
  renderTransitionOffline,
  kWeighting,
  Biquad,
  evalPoints,
  type PlannerTrack,
  type TrackAnalysis,
} from '../packages/core/src/index.ts';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const dir = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : path.resolve('examples/library');

export function decode(file: string): { L: Float32Array; R: Float32Array } {
  const buf = execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-ac', '2', '-ar', '44100', '-f', 'f32le', 'pipe:1'], { maxBuffer: 1 << 30 });
  const f = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
  const n = f.length / 2;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = f[2 * i];
    R[i] = f[2 * i + 1];
  }
  return { L, R };
}

/** EBU short-term loudness (3 s window) per 100 ms hop. */
export function shortTermLoudness(L: Float32Array, R: Float32Array, sr = 44100): number[] {
  const [a, b] = kWeighting(sr);
  const fl = [new Biquad(a), new Biquad(b)];
  const fr = [new Biquad(a), new Biquad(b)];
  const hop = sr / 10;
  const win = sr * 3; // EBU short-term window
  const sq = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) {
    const l = fl[1].process(fl[0].process(L[i]));
    const r = fr[1].process(fr[0].process(R[i]));
    sq[i] = l * l + r * r;
  }
  const out: number[] = [];
  let s = 0;
  for (let i = 0; i < L.length; i++) {
    s += sq[i];
    if (i >= win) s -= sq[i - win];
    if (i >= win && i % hop === 0) out.push(-0.691 + 10 * Math.log10(Math.max(1e-10, s / win)));
  }
  return out;
}

export function runEval(): void {
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)).map((x) => path.join(e.name, x)) : [e.name]));
  const files = walk(dir).filter((f) => /\.(mp3|flac|wav|ogg|m4a|opus)$/i.test(f));
  const tracks = files.map((f) => {
    const pcm = decode(path.join(dir, f));
    const analysis: TrackAnalysis = analyzePcm(pcm.L, pcm.R);
    return { name: path.basename(f).replace(/\.[^.]+$/, ''), pcm, analysis };
  });

  const pairsArg = process.argv.indexOf('--pairs');
  const maxPairs = pairsArg > 0 ? Number(process.argv[pairsArg + 1]) : Infinity;
  const rows: Record<string, string | number>[] = [];
  let n = 0;
  for (const A of tracks) {
    for (const B of tracks) {
      if (A === B || n++ >= maxPairs) continue;
      const pt = (t: typeof A, id: string): PlannerTrack => ({ id, duration: t.pcm.L.length / 44100, mixingAllowed: true, analysis: t.analysis });
      const plan = planTransition(pt(A, 'a'), pt(B, 'b'), DEFAULT_AUTOMIX_SETTINGS);
      const pre = 8;
      const post = 14;
      const r = renderTransitionOffline({ ...A.pcm, sampleRate: 44100 }, { ...B.pcm, sampleRate: 44100 }, plan, pre, post);
      const st = shortTermLoudness(r.L, r.R);
      // st[0] describes the window ending at 3 s, not the first 100 ms.
      const t0 = Math.max(1, Math.round((r.transitionStartFrame / 44100) * 10) - 30);
      const t1 = Math.min(st.length - 1, t0 + Math.round((plan.duration + plan.gap) * 10) + 30);
      const before = st.slice(Math.max(0, t0 - 40), t0 - 5);
      const after = st.slice(Math.min(st.length - 1, t1), st.length);
      const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);
      const lvA = med(before);
      const lvB = med(after);
      const during = st.slice(t0, t1);
      let bump = 0;
      let dip = 0;
      during.forEach((v) => {
        // a bump is louder than both sides, a hole is quieter than both sides
        bump = Math.max(bump, v - Math.max(lvA, lvB));
        dip = Math.min(dip, v - Math.min(lvA, lvB));
      });
      // bass clash from the plan lanes (both low bands audible at the same time)
      let clash = 0;
      const lane = (deck: 'A' | 'B', l: string) => plan.automation.find((x) => x.deck === deck && x.lane === l)?.points ?? null;
      for (let t = 0; t < plan.duration; t += 0.05) {
        const aG = evalPoints(lane('A', 'gain') ?? [[0, 1]], t) * evalPoints(lane('A', 'low') ?? [[0, 1]], t);
        const bG = evalPoints(lane('B', 'gain') ?? [[0, 1]], t) * evalPoints(lane('B', 'low') ?? [[0, 1]], t);
        if (aG > 0.5 && bG > 0.5) clash += 0.05;
      }
      const map = plan.tempoA ?? [[0, 1]] as [number, number][];
      const knots = [0, ...map.map(([t]) => t).filter((t) => t > 0 && t < plan.duration), plan.duration];
      let consumedA = 0;
      for (let i = 1; i < knots.length; i++) consumedA += (knots[i] - knots[i - 1]) * (evalPoints(map, knots[i]) + evalPoints(map, knots[i - 1])) / 2;
      const cut = Math.max(0, A.analysis.audibleEnd - (plan.aExit + consumedA));
      let nonFinite = 0;
      for (let i = 0; i < r.L.length; i++) if (!Number.isFinite(r.L[i]) || !Number.isFinite(r.R[i])) nonFinite++;
      const completed = r.events.filter((e) => e.type === 'transitionEnd').length === 1;
      rows.push({
        pair: `${A.name.slice(0, 18)} → ${B.name.slice(0, 18)}`,
        method: plan.method,
        conf: plan.confidence.toFixed(2),
        dur: plan.duration.toFixed(1),
        stretch: plan.beatAlign ? `${plan.beatAlign.stretchPercent.toFixed(1)}%` : '-',
        bumpLU: bump.toFixed(1),
        dipLU: dip.toFixed(1),
        bassClashS: clash.toFixed(1),
        cutS: cut.toFixed(1),
        entryS: plan.bEntry.toFixed(2),
        peakDbFS: (20 * Math.log10(Math.max(1e-10, r.metrics.peak))).toFixed(2),
        limiterReductionDb: r.metrics.maxLimiterReductionDb.toFixed(2),
        underruns: r.metrics.underruns,
        nonFinite,
        completed: completed ? 1 : 0,
      });
    }
  }
  if (process.argv.includes('--all')) console.table(rows);
  const by = (k: string, dir: number) => [...rows].sort((a, b) => (Number(a[k]) - Number(b[k])) * dir).slice(0, 6);
  console.log('worst bumps'); console.table(by('bumpLU', -1));
  console.log('worst dips'); console.table(by('dipLU', 1));
  console.log('largest cuts'); console.table(by('cutS', -1));
  const num = (k: string) => rows.map((r) => Number(r[k]));
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  const summary = {
    pairs: rows.length,
    methods: rows.reduce<Record<string, number>>((m, r) => ((m[r.method as string] = (m[r.method as string] ?? 0) + 1), m), {}),
    meanBump: avg(num('bumpLU')).toFixed(2),
    maxBump: Math.max(...num('bumpLU')).toFixed(1),
    meanDip: avg(num('dipLU')).toFixed(2),
    minDip: Math.min(...num('dipLU')).toFixed(1),
    meanBassClash: avg(num('bassClashS')).toFixed(2),
    meanCut: avg(num('cutS')).toFixed(1),
    maxCut: Math.max(...num('cutS')).toFixed(1),
    internalEntries: rows.filter((r) => Number(r.entryS) >= 15).length,
    maxPeakDbFS: Math.max(...num('peakDbFS')).toFixed(2),
    maxLimiterReductionDb: Math.max(...num('limiterReductionDb')).toFixed(2),
    underruns: num('underruns').reduce((a, b) => a + b, 0),
    nonFiniteSamples: num('nonFinite').reduce((a, b) => a + b, 0),
    incompleteTransitions: rows.filter((r) => !r.completed).length,
  };
  console.log(summary);
  const jsonArg = process.argv.indexOf('--json');
  if (jsonArg > 0 && process.argv[jsonArg + 1]) {
    const destination = path.resolve(process.argv[jsonArg + 1]);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, JSON.stringify({ date: new Date().toISOString(), analyzer: ANALYZER_VERSION, planner: PLANNER_VERSION, source: dir, summary, rows }, null, 2));
  }
  if (summary.nonFiniteSamples || summary.incompleteTransitions || Number(summary.maxPeakDbFS) > -0.9) process.exitCode = 1;

}

if (process.argv[1]?.includes('eval-transitions')) runEval();
