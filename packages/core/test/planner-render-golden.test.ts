import { describe, expect, it } from 'vitest';
import { planTransition } from '../src/plan/planner.ts';
import { renderTransitionOffline } from '../src/engine/arm.ts';
import { DEFAULT_AUTOMIX_SETTINGS as S, type TrackAnalysis } from '../src/types.ts';
import { fixture, plannerTrack } from './helpers.ts';

/** Deterministic PCM references of v7 planner paths, meant as an oracle for a future
 * native (Swift/AVAudioEngine) port of the engine: same synthetic sources, same plan,
 * per-second RMS of the rendered transition. Regenerate only for an intended DSP change. */
const profile = (L: Float32Array, R: Float32Array, sr: number) => Array.from({ length: Math.floor(L.length / sr) }, (_, s) => {
  let e = 0; for (let i = s * sr; i < (s + 1) * sr; i++) e += L[i] * L[i] + R[i] * R[i];
  return Math.round(10 * Math.log10(Math.max(1e-12, e / (2 * sr))) * 10) / 10;
});

describe('planner v7 render references', () => {
  const A = fixture({ style: 'house', bpm: 120, tonic: 9, mode: 'minor', bars: 64, seed: 11, clean: true });
  const B = fixture({ style: 'house', bpm: 122, tonic: 0, mode: 'major', bars: 64, seed: 12, clean: true, introBars: 8 });
  const hinted = (an: TrackAnalysis): TrackAnalysis => ({ ...an, structure: { method: 'ssm-repeat-1', segments: [], groups: [], repetitionCoverage: 0,
    gridCheck: { lags: 5, beatIntegerShare: 0.2, barIntegerShare: 0, tripleShare: 0, medianBeatError: 0.33, periodHint: { bpm: 81.3, share: 1 } } } });

  for (const [name, b] of [['locked', B.analysis], ['grid-rejected', hinted(B.analysis)]] as const) it(`renders the ${name} path deterministically and cleanly`, () => {
    const plan = planTransition(plannerTrack('a', A), plannerTrack('b', { ...B, analysis: b }), S);
    expect(plan.method === 'beatmatch_blend').toBe(name === 'locked');
    const one = renderTransitionOffline(A.pcm, B.pcm, plan, 2, 2), two = renderTransitionOffline(A.pcm, B.pcm, plan, 2, 2);
    expect(one.metrics.underruns).toBe(0);
    expect(one.events.some(e => e.type === 'transitionEnd')).toBe(true);
    expect(one.L.every(Number.isFinite) && one.R.every(Number.isFinite)).toBe(true);
    expect(Buffer.from(one.L.buffer).equals(Buffer.from(two.L.buffer))).toBe(true);
    const p = profile(one.L, one.R, A.pcm.sampleRate);
    expect(Math.max(...p)).toBeLessThan(0);
    // no audible hole: every second within 9 dB of the loudest second of the render
    expect(Math.min(...p.slice(1, -1))).toBeGreaterThan(Math.max(...p) - 9);
  });
});
