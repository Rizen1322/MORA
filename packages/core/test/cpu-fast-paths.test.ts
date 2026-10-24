import { describe, expect, it } from 'vitest';
import { Limiter } from '../src/dsp/limiter.ts';
import { StereoIsolator } from '../src/dsp/crossover.ts';
import { Echo, MixerCore } from '../src/engine/mixer.ts';
import { CHUNK_FRAMES } from '../src/engine/chunks.ts';
import { planToArmed } from '../src/engine/arm.ts';
import { planTransition } from '../src/plan/planner.ts';
import { DEFAULT_AUTOMIX_SETTINGS as S } from '../src/types.ts';
import { Limiter as LimiterV1 } from './reference/limiter-v1.ts';
import { StereoIsolator as IsolatorV1 } from './reference/crossover-v1.ts';
import { Echo as EchoV1 } from './reference/echo-v1.ts';
import { Decimator2 as DecimatorV1 } from './reference/decimator-v1.ts';
import { Decimator2 } from '../src/dsp/loudness.ts';
import { fixture, plannerTrack } from './helpers.ts';

/** CPU fast paths of the realtime mixer must sound like the code they replace: within -120 dBFS. */
const LIMIT = 1e-6;
const A = fixture({ style: 'house', bpm: 120, tonic: 9, mode: 'minor', bars: 32, seed: 11, clean: true });
const B = fixture({ style: 'house', bpm: 122, tonic: 0, mode: 'major', bars: 32, seed: 12, clean: true, introBars: 8 });

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** Feeds the same blocks of random length to both processors and returns the largest output difference. */
function compare(total: number, input: (i: number) => [number, number], run: (L: Float32Array, R: Float32Array, at: number) => [Float32Array, Float32Array, Float32Array, Float32Array], seed = 1): number {
  const next = rng(seed);
  let diff = 0;
  for (let at = 0; at < total;) {
    const n = Math.min(total - at, 1 + Math.floor(next() * 300));
    const L = new Float32Array(n), R = new Float32Array(n);
    for (let i = 0; i < n; i++) [L[i], R[i]] = input(at + i);
    const [l0, r0, l1, r1] = run(L, R, at);
    for (let i = 0; i < n; i++) diff = Math.max(diff, Math.abs(l0[i] - l1[i]), Math.abs(r0[i] - r1[i]));
    at += n;
  }
  return diff;
}

describe('CPU fast paths are inaudible', () => {
  it('folded true-peak detector matches the direct limiter', () => {
    for (const gain of [0.3, 1, 2.5, 6]) {
      const ref = new LimiterV1(44100), fast = new Limiter(44100);
      const diff = compare(A.pcm.L.length, (i) => [A.pcm.L[i] * gain, A.pcm.R[i] * gain], (L, R) => {
        const l0 = L.slice(), r0 = R.slice();
        ref.processBlock(l0, r0, 0, L.length);
        fast.processBlock(L, R, 0, L.length);
        return [l0, r0, L, R];
      }, gain * 10);
    expect(diff).toBeLessThanOrEqual(LIMIT);
      expect(fast.getStats().minGainDb).toBeCloseTo(ref.getStats().minGainDb, 9);
    }
  });

  it('a silent echo is skipped without changing what it plays later', () => {
    const sr = 44100, ref = new EchoV1(sr), fast = new Echo(sr);
    for (const e of [ref, fast]) e.configure(Math.round(sr * 0.375), 0.6);
    // 2 s into the send, a minute of silence (the ring decays to exact zeros), 2 s again, a fade-out
    const send = (i: number) => i < 2 * sr || (i >= 62 * sr && i < 64 * sr);
    let skipped = 0;
    const diff = compare(70 * sr, (i) => send(i) ? [A.pcm.L[i % A.pcm.L.length], A.pcm.R[i % A.pcm.L.length]] : [0, 0], (L, R, at) => {
      if (at >= 66 * sr && at - L.length < 66 * sr) for (const e of [ref, fast]) e.fadeOut(sr * 0.1);
      const out = [L.map(() => 0.25), R.map(() => -0.25), L.map(() => 0.25), R.map(() => -0.25)];
      ref.process(L, R, out[0], out[1], L.length);
      const before = (fast as unknown as { pos: number }).pos;
      fast.process(L, R, out[2], out[3], L.length);
      if ((fast as unknown as { pos: number }).pos === before) skipped++;
      return out as [Float32Array, Float32Array, Float32Array, Float32Array];
    });
    expect(diff).toBeLessThanOrEqual(LIMIT);
    expect(skipped).toBeGreaterThan(100);
  });

  it('the unity allpass path of the isolator matches the three-band chain through band moves', () => {
    const sr = 44100, ref = new IsolatorV1(sr), fast = new StereoIsolator(sr);
    // idle 3 s, armed 1 s, low band out and back over 2 s, idle again
    const gains = (t: number): number => t < 4 ? 1 : t < 6 ? 0.5 + 0.5 * Math.cos(Math.PI * (t - 4)) : 1;
    let usedUnity = 0;
    const diff = compare(10 * sr, (i) => [A.pcm.L[i], A.pcm.R[i]], (L, R, at) => {
      const t0 = at / sr, t1 = (at + L.length) / sr;
      const from: [number, number, number] = [gains(t0), 1, 1], to: [number, number, number] = [gains(t1), 1, 1];
      fast.idle = t0 < 3 || t0 >= 7;
      const l0 = L.slice(), r0 = R.slice();
      ref.processBlock(l0, r0, 0, L.length, from, to);
      fast.processBlock(L, R, 0, L.length, from, to);
      if ((fast as unknown as { fullWarm: number }).fullWarm === 0) usedUnity++;
      return [l0, r0, L, R];
    });
    expect(diff).toBeLessThanOrEqual(LIMIT);
    expect(usedUnity).toBeGreaterThan(100);
  });

  it('a whole transition renders the same with and without the idle isolator path', () => {
    const plan = planTransition(plannerTrack('a', A), plannerTrack('b', B), { ...S, stemMixing: false });
    const render = (allowIdle: boolean) => {
      const sr = A.pcm.sampleRate, pcms = [A.pcm, B.pcm];
      let ended = false;
      const m: MixerCore = new MixerCore(sr, (e) => {
        if (e.type === 'transitionEnd') ended = true;
        if (e.type === 'need') for (const c of e.chunks) {
          const p = pcms[e.deck], a = c * CHUNK_FRAMES, b = Math.min(p.L.length, a + CHUNK_FRAMES);
          m.feed(e.deck, e.deck ? 'B' : 'A', c, p.L.slice(a, b), p.R.slice(a, b));
        }
      });
      if (!allowIdle) for (const d of m.decks) Object.defineProperty(d.iso, 'idle', { get: () => false, set: () => {} });
      m.load(0, 'A', A.pcm.L.length, plan.gainA);
      m.load(1, 'B', B.pcm.L.length, plan.gainB, Math.round(plan.bEntry * sr));
      const armed = planToArmed(plan, sr, 'A', 'B');
      m.start(0, 'A', armed.triggerFrame - 3 * sr);
      const total = 3 * sr + armed.durationFrames + armed.gapFrames + 3 * sr;
      const L = new Float32Array(total), R = new Float32Array(total);
      // armed 1.5 s before its trigger, like a prepared next track
      const armAt = Math.round(1.5 * sr / 128) * 128;
      for (let off = 0; off < total; off += 128) {
        if (off === armAt) m.arm(armed);
        const n = Math.min(128, total - off);
        m.process(L.subarray(off, off + n), R.subarray(off, off + n), n);
      }
      expect(ended).toBe(true);
      return { L, R };
    };
    const ref = render(false), fast = render(true);
    let diff = 0;
    for (let i = 0; i < ref.L.length; i++) diff = Math.max(diff, Math.abs(ref.L[i] - fast.L[i]), Math.abs(ref.R[i] - fast.R[i]));
    expect(diff).toBeLessThanOrEqual(LIMIT);
  });

  it('the 2:1 analysis decimator gives the same samples without its modulo', () => {
    const run = (d: { push(x: Float32Array, len: number, out: (v: number) => void): void }) => {
      const out: number[] = [], next = rng(7);
      for (let at = 0; at < A.pcm.L.length;) {
        const n = Math.min(A.pcm.L.length - at, 1 + Math.floor(next() * 5000));
        d.push(A.pcm.L.subarray(at, at + n), n, (v) => out.push(v));
        at += n;
      }
      return out;
    };
    expect(run(new Decimator2())).toEqual(run(new DecimatorV1()));
  });
});
