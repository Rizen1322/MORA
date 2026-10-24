import { Biquad, BUTTERWORTH_Q, lowpass } from '../dsp/biquad.ts';
import { kWeighting } from '../dsp/loudness.ts';
import { drain, integrateTempo } from '../plan/timing.ts';
import type { TransitionPlan } from '../types.ts';
import { renderTransitionSteps, type StereoPcm } from './arm.ts';

/**
 * P10: a technical filter over 2-5 full-mix finalists, rendered through the same MixerCore on the
 * same PCM, outside any audio callback. It catches bass holes, level dips/bumps, limiter strain and
 * flams (double kicks). It is not a judge of musicality: the planner's choice stays unless it fails
 * clearly where another finalist does not. The flattest RMS is never the goal by itself.
 */

/** A source span: `pcm` frame 0 is `start` seconds into the recording. */
export interface PcmSpan { pcm: StereoPcm; start: number }

// level references need several seconds of each song outside the overlap
const PRE = 6, POST = 6;

/** Source spans that cover every finalist's render window. */
export function finalistSpans(finalists: TransitionPlan[]): { a: [number, number]; b: [number, number] } {
  const endA = (p: TransitionPlan) => p.aExit + integrateTempo(p.tempoA, p.duration) + 1;
  const endB = (p: TransitionPlan) => p.bEntry + integrateTempo(p.tempoB, p.duration + p.gap - (p.bDelay ?? 0)) + POST + 1;
  return {
    a: [Math.max(0, Math.min(...finalists.map(p => p.aExit)) - PRE - 0.5), Math.max(...finalists.map(endA))],
    b: [Math.max(0, Math.min(...finalists.map(p => p.bEntry)) - 0.5), Math.max(...finalists.map(endB))],
  };
}

export interface RenderMetrics { dipLU: number; bumpLU: number; limiterDb: number; lowHoleSeconds: number; flams: number; underruns: number; cost: number }

const r2 = (x: number) => Math.round(x * 100) / 100;

/** Drives a step generator, yielding to the event loop at every step. */
export async function stepAsync<T>(g: Generator<void, T>): Promise<T> {
  for (;;) { const r = g.next(); if (r.done) return r.value; await new Promise(res => setTimeout(res, 0)); }
}

/** Renders one finalist from the spans and measures technical faults on 100 ms windows. */
export function renderMetrics(plan: TransitionPlan, a: PcmSpan, b: PcmSpan): RenderMetrics | null {
  return drain(renderMetricsSteps(plan, a, b));
}

function* renderMetricsSteps(plan: TransitionPlan, a: PcmSpan, b: PcmSpan): Generator<void, RenderMetrics | null> {
  if (plan.loopA || plan.tapeStopA || plan.vocalA || plan.vocalB || plan.aExit - PRE < a.start || plan.bEntry < b.start) return null;
  const sr = a.pcm.sampleRate;
  const shifted = { ...plan, aExit: plan.aExit - a.start, bEntry: plan.bEntry - b.start };
  const r = yield* renderTransitionSteps(a.pcm, b.pcm, shifted, PRE, POST);
  yield;
  if (r.transitionStartFrame < 0) return null;
  const n = r.L.length, weighted = new Float32Array(n);
  // K-weighted level (BS.1770 pre-filter), like the short-term loudness the evaluation tools report
  const [k1, k2] = kWeighting(sr), kl = [new Biquad(k1), new Biquad(k2)], kr = [new Biquad(k1), new Biquad(k2)];
  for (let i = 0; i < n; i++) { const l = kl[1].process(kl[0].process(r.L[i])), rr = kr[1].process(kr[0].process(r.R[i])); weighted[i] = Math.sqrt((l * l + rr * rr) / 2); }
  // low band per channel, then their energy: a side (L = -R) bass is still bass in stereo (B3)
  const low = Float32Array.from(r.L), lowR = Float32Array.from(r.R);
  for (const x of [low, lowR]) for (let k = 0; k < 2; k++) new Biquad(lowpass(sr, 150, BUTTERWORTH_Q)).processBuffer(x);
  for (let i = 0; i < n; i++) low[i] = Math.sqrt((low[i] * low[i] + lowR[i] * lowR[i]) / 2);
  const hop = Math.round(sr / 10), db = (x: Float32Array, i: number) => {
    let s = 0; for (let j = i; j < Math.min(n, i + hop); j++) s += x[j] * x[j];
    return 10 * Math.log10(Math.max(1e-12, s / hop));
  };
  const level: number[] = [], lowLevel: number[] = [];
  for (let i = 0; i + hop <= n; i += hop) { level.push(db(weighted, i)); lowLevel.push(db(low, i)); }
  const t0 = Math.floor(r.transitionStartFrame / hop), t1 = Math.min(level.length, t0 + Math.ceil((plan.duration + plan.gap) * 10));
  const med = (x: number[]) => { const s = [...x].sort((p, q) => p - q); return s.length ? s[s.length >> 1] : -90; };
  // a 3 s moving mean (the EBU short-term window): a dip a listener hears, not gaps between beats.
  // The references outside the overlap use the same window (B4): 100 ms medians of sparse drums are
  // mostly silence and made a steady groove look like a bump.
  const short = (i: number, lo = 0, hi = level.length) => { const w = level.slice(Math.max(lo, i - 15), Math.min(hi, i + 15)); return 10 * Math.log10(w.reduce((s, x) => s + 10 ** (x / 10), 0) / w.length); };
  const before = med(level.slice(0, t0).map((_, i) => short(i, 0, t0))), after = med(level.slice(t1).map((_, i) => short(t1 + i, t1)));
  const lowBefore = med(lowLevel.slice(0, t0)), lowAfter = med(lowLevel.slice(t1));
  let dip = 0, bump = 0, hole = 0;
  for (let i = t0; i < t1; i++) {
    const m = short(i);
    dip = Math.min(dip, m - Math.min(before, after));
    bump = Math.max(bump, m - Math.max(before, after));
    const lw = lowLevel.slice(Math.max(t0, i - 5), Math.min(t1, i + 5)), lm = 10 * Math.log10(lw.reduce((s, x) => s + 10 ** (x / 10), 0) / lw.length);
    // both songs carry bass outside the overlap; a missing low end in between is a hole, an intended
    // breath of one song without bass is not (then one side is already quiet down there)
    if (lowBefore > -45 && lowAfter > -45 && lm < Math.min(lowBefore, lowAfter) - 10) hole += 0.1;
  }
  // flams: two strong low-band attacks 25-90 ms apart (two kicks almost together). Attacks are rises
  // of a 15 ms RMS envelope, so a sustained 808 or bass tone does not count.
  const ms = sr / 1000, env = new Float32Array(Math.ceil(n / ms));
  // sliding 15 ms sum: the window moves by 1 ms, so add the new samples and drop the old ones
  let e = 0, in0 = 0, in1 = 0;
  for (let j = 0; j < env.length; j++) {
    const a0 = Math.max(0, Math.round((j - 15) * ms)), a1 = Math.min(n, Math.round(j * ms));
    for (; in1 < a1; in1++) e += low[in1] * low[in1];
    for (; in0 < a0; in0++) e -= low[in0] * low[in0];
    env[j] = Math.sqrt(Math.max(0, e) / Math.max(1, a1 - a0));
  }
  const from = Math.floor(r.transitionStartFrame / ms), to = Math.min(env.length - 1, from + Math.ceil((plan.duration + plan.gap) * 1000));
  const flux = (j: number) => Math.max(0, env[j] - env[Math.max(0, j - 10)]);
  const flamsIn = (a: number, b: number) => {
    let fluxMax = 0; for (let j = a; j < b; j++) fluxMax = Math.max(fluxMax, flux(j));
    const attacks: number[] = [];
    for (let j = a + 1; j < b - 1; j++) if (fluxMax > 0 && flux(j) >= 0.5 * fluxMax && flux(j) > flux(j - 1) && flux(j) >= flux(j + 1)
      && (!attacks.length || j - attacks[attacks.length - 1] >= 25)) attacks.push(j);
    let n = 0;
    for (let k = 1; k < attacks.length; k++) if (attacks[k] - attacks[k - 1] <= 90) n++;
    return n;
  };
  // 808 rolls and fast kick patterns flam within one song: count only what exceeds either song's own rate
  const ownRate = Math.max(from > 1000 ? flamsIn(0, from) / from : 0, env.length - to > 1000 ? flamsIn(to, env.length) / (env.length - to) : 0);
  const flams = Math.max(0, Math.round(flamsIn(from, to) - ownRate * (to - from)));
  const limiterDb = r.metrics.maxLimiterReductionDb;
  const cost = 0.3 * Math.max(0, -dip - 1.5) + 0.3 * Math.max(0, bump - 1) + 0.2 * Math.max(0, limiterDb - 2) + 0.3 * hole
    + 0.05 * flams + (r.metrics.underruns ? 1 : 0);
  return { dipLU: r2(dip), bumpLU: r2(bump), limiterDb: r2(limiterDb), lowHoleSeconds: r2(hole), flams, underruns: r.metrics.underruns, cost: r2(cost) };
}

/** Keeps the planner's choice unless its render fails clearly (0.3) where another finalist does not.
 * Async: it yields between renders so an in-process server (the iPhone app) keeps serving PCM.
 * A replacement keeps at least 3/4 of the overlap: short blends were rated "резко", and a shorter
 * overlap trivially has fewer measured faults. */
export async function chooseByRender(finalists: TransitionPlan[], a: PcmSpan, b: PcmSpan): Promise<TransitionPlan> {
  const rated: { plan: TransitionPlan; m: RenderMetrics | null }[] = [];
  for (const plan of finalists) rated.push({ plan, m: await stepAsync(renderMetricsSteps(plan, a, b)) });
  const base = rated[0];
  // nor a deeper dip than the planner's choice: trading double kicks for a -6.5 LU hole was measured in a render
  const valid = rated.filter(c => c.m && (c === base || c.plan.duration >= 0.75 * base.plan.duration && (!base.m || c.m.dipLU >= base.m.dipLU - 2)))
    .sort((x, y) => x.m!.cost - y.m!.cost);
  const winner = base.m && valid[0] && valid[0] !== base && valid[0].m!.cost < base.m.cost - 0.3 ? valid[0] : base;
  const label = (p: TransitionPlan) => p.debug.bassShift !== undefined ? `bass ${p.debug.bassShift}` : String((p.debug.fullMix as { this?: string } | undefined)?.this ?? p.id);
  const renderCheck = { policy: 'render-finalists-2', selected: label(winner.plan), margin: 0.3,
    candidates: rated.map(c => ({ name: label(c.plan), method: c.plan.method, duration: c.plan.duration, metrics: c.m })) };
  return { ...winner.plan, id: winner === base ? winner.plan.id : `${winner.plan.id}_render`,
    reasons: winner === base ? winner.plan.reasons : [...winner.plan.reasons, 'проверка рендером: у выбранного плана были технические провалы (бас, громкость, ограничитель или двойные удары), у этого варианта их нет'],
    debug: { ...winner.plan.debug, renderCheck } };
}
