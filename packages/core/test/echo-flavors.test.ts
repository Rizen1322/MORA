import { describe, expect, it } from 'vitest';
import { planTransition } from '../src/plan/planner.ts';
import { pointValue } from '../src/plan/timing.ts';
import { planToArmed, renderTransitionOffline } from '../src/engine/arm.ts';
import { LoopPcmSource } from '../src/engine/loop.ts';
import { Echo } from '../src/engine/mixer.ts';
import { DEFAULT_AUTOMIX_SETTINGS as S, type PlannerTrack, type TrackAnalysis, type TransitionPlan } from '../src/types.ts';

// v20 echo-out flavors (washout / dub / brake) of the automatic drop-swap echo out, and B's entrance.
function song(id: string, bpm: number, edit: (an: TrackAnalysis) => void = () => {}): PlannerTrack {
  const duration = 180, rate = 20, period = 60 / bpm;
  const beats = Array.from({ length: Math.ceil(duration / period) }, (_, i) => i * period).filter(t => t < duration);
  const downbeats = beats.filter((_, i) => i % 4 === 0), phrases = downbeats.filter((_, i) => i % 8 === 0);
  const rmsDb = Array.from({ length: duration * rate }, () => -16);
  const analysis: TrackAnalysis = {
    version: 'flavor-test', duration, audibleStart: 0, audibleEnd: duration,
    loudness: { integratedLufs: -16, samplePeakDb: -4, truePeakDb: -3 },
    beat: { bpm, period, beats, downbeats, confidence: 0.95, stable: true, jitterMs: 2, downbeatConfidence: 0.9, downbeatPhase: 0, alternatives: [] },
    rhythmStrength: 0.95, key: { tonic: -1, mode: 'unknown', name: 'unknown', camelot: '', confidence: 0 },
    phrases, phraseConfidence: 0.8, sectionBoundaries: [], intro: { start: 0, end: 0 }, outro: { start: duration - 16, end: duration }, bodyRmsDb: -16,
    // A's middle thins out at its phrase starts: a clean echo exit (not a loop roll)
    curves: { rate, rmsDb, lowDb: rmsDb.map(v => v - 3), midDb: rmsDb.map(v => v - 6), highDb: rmsDb.map(v => v - 10),
      midDensity: rmsDb.map((_, i) => phrases.some(t => Math.abs(i / rate - t) < 2 * period) ? 0.05 : 0.2) },
    peaks: rmsDb.map(() => 0.8),
    cues: { entry: [{ time: 0, score: 0.76, kind: 'start', tags: [] }], exit: [] },
    features: { energy: 0.6, brightness: 0.5, rhythmStrength: 0.95, onsetRate: 0.4, bassWeight: 0.6, midDensity: 0.2, dynamics: 0.2, acousticness: 0.1 },
    warnings: [], elapsedMs: 0,
  };
  edit(analysis);
  return { id, duration, mixingAllowed: true, analysis };
}
const intro = (key: 'rmsDb' | 'lowDb' | 'all', db: number) => (an: TrackAnalysis) => {
  for (const k of key === 'all' ? ['rmsDb', 'lowDb', 'midDb', 'highDb'] as const : [key]) for (let i = 0; i < 30 * 20; i++) an.curves[k][i] += db;
};
const lane = (p: TransitionPlan, deck: 'A' | 'B', name: string) => p.automation.find(l => l.deck === deck && l.lane === name)?.points;
const ids = ['b', 'c', 'd', 'e', 'f', 'g'];
const plans = (edit?: (an: TrackAnalysis) => void, editA?: (an: TrackAnalysis) => void) =>
  ids.map(id => planTransition(song('a', 124, editA), song(id, 160, edit), S));
const BPM_A = 124, beatA = 60 / BPM_A, barA = 4 * beatA, barB = 4 * 60 / 160;

describe('echo-out flavors', () => {
  it('a B that opens on a heavy drum drop gets dub or brake, picked per pair and deterministically', () => {
    const ps = plans();
    for (const p of ps) {
      expect(p.method).toBe('echo_out');
      expect(p.debug.variant).toBe('drop-swap');
      expect(['dub', 'brake']).toContain(p.echoFlavor);
    }
    expect(new Set(ps.map(p => p.echoFlavor)).size).toBe(2);
    expect(JSON.stringify(plans())).toBe(JSON.stringify(ps));
  });

  it('a calm B intro gets the washout: damped freeze, widened, B opens from a low-pass over its first phrase', () => {
    for (const p of plans(intro('all', -5))) {
      expect(p.echoFlavor).toBe('washout');
      expect(p.echo).toMatchObject({ feedback: 0.85, lowpass: 2500, width: 0.5 });
      const start = p.swapAt - p.bDelay!, end = p.duration - p.bDelay!;
      expect(end - start).toBeGreaterThanOrEqual(8 * barB - 0.01);
      const filter = lane(p, 'B', 'filter')!;
      expect(pointValue(filter, start)).toBeCloseTo(-0.6, 3);
      expect(pointValue(filter, start + 4 * barB)).toBeLessThan(-0.2);
      expect(pointValue(filter, end)).toBe(0);
      expect(pointValue(lane(p, 'B', 'gain')!, 0.02)).toBeLessThanOrEqual(0.5);
    }
  });

  it('dub: ping-pong dotted-8th on A’s last bar under a rising high-pass; B drops hard on the one', () => {
    const p = plans().find(q => q.echoFlavor === 'dub')!;
    expect(p.echo!.delay).toBeCloseTo(0.75 * beatA, 3);
    expect(p.echo!.width).toBe(1);
    const send = lane(p, 'A', 'echo')!, filter = lane(p, 'A', 'filter')!;
    expect(pointValue(send, p.swapAt - barA + 0.1)).toBeCloseTo(0.45, 3);
    expect(pointValue(send, p.swapAt + 0.05)).toBe(0);
    expect(pointValue(filter, p.swapAt - barA)).toBeCloseTo(0, 3);
    expect(pointValue(filter, p.swapAt)).toBeCloseTo(0.45, 3);
    expect(pointValue(lane(p, 'A', 'gain')!, p.swapAt)).toBe(0);
    expect(pointValue(lane(p, 'B', 'gain')!, 0.01)).toBe(1);
  });

  it('brake: a beat-long tape stop on A’s final beat, thrown wide into the echo; B starts with no lag', () => {
    const p = plans().find(q => q.echoFlavor === 'brake')!;
    const cut = p.aExit + p.swapAt;
    expect(p.tapeStopA!.end).toBeCloseTo(cut, 3);
    expect(p.tapeStopA!.end - p.tapeStopA!.start).toBeCloseTo(beatA, 3);
    expect(p.echo!.width).toBe(1);
    expect(pointValue(lane(p, 'A', 'echo')!, p.swapAt - beatA / 2)).toBeCloseTo(0.6, 3);
    expect(p.bDelay).toBe(p.swapAt);
    expect(pointValue(lane(p, 'B', 'gain')!, 0.01)).toBe(1);
    for (const sr of [44100, 48000]) {
      const source = new LoopPcmSource({ totalFrames: 180 * sr, read: () => true }, sr);
      expect(source.setTapeStop(planToArmed(p, sr, 'a', 'b').tapeStopA!)).toBe(true);
    }
  });

  it('brake needs a tight A grid; weak B onsets are no drum drop (washout or dub)', () => {
    expect(plans(undefined, an => { an.beat!.jitterMs = 15; }).every(p => p.echoFlavor === 'dub')).toBe(true);
    const weak = plans(an => { an.local = { rate: 1, camelot: [], keyConfidence: [], transients: Array.from({ length: 180 }, () => 0.1) }; });
    expect(weak.every(p => p.echoFlavor === 'washout' || p.echoFlavor === 'dub')).toBe(true);
    expect(new Set(weak.map(p => p.echoFlavor)).size).toBe(2);
  });

  it('a harsh B opening (loud, not carried by its kick) eases in: no step from 0 to full within a few ms', () => {
    const ps = plans(intro('lowDb', -6));
    expect(ps.every(p => (p.debug.dropSwap as { harsh: boolean }).harsh)).toBe(true);
    expect(new Set(ps.map(p => p.echoFlavor))).toEqual(new Set(['washout', 'dub']));
    for (const p of ps) {
      const gain = lane(p, 'B', 'gain')!, filter = lane(p, 'B', 'filter')!;
      for (let t = 0; t < barB; t += 0.001) expect(pointValue(gain, t + 0.005) - pointValue(gain, t)).toBeLessThan(0.25);
      expect(pointValue(gain, 0.005)).toBeLessThan(0.15);
      // dub swells over 3/4 bar; washout over its 4-bar fade-in
      expect(pointValue(gain, (p.echoFlavor === 'washout' ? 4 : 0.75) * barB + 0.01)).toBe(1);
      expect(pointValue(filter, 0)).toBeLessThan(-0.25);
      expect(pointValue(filter, barB * 8)).toBe(0);
    }
    // the dry, kick-led drop still lands at full on the one
    expect(plans().every(p => pointValue(lane(p, 'B', 'gain')!, 0.01) === 1)).toBe(true);
  });

  it('B lands on its downbeat: a pickup before B’s first bar is pre-rolled under A’s last beat', () => {
    const late = (an: TrackAnalysis) => { an.beat!.downbeats = an.beat!.downbeats.map(t => t + 0.3); an.phrases = an.phrases.map(t => t + 0.3); };
    for (const p of plans(late)) {
      expect(p.bEntry).toBe(0);
      expect(p.swapAt - p.bDelay!).toBeCloseTo(0.3, 3);
      // B's downbeat (0.3 s into B) plays exactly at A's cut
      expect(p.bEntry + (p.swapAt - p.bDelay!)).toBeCloseTo(0.3, 3);
      expect(pointValue(lane(p, 'B', 'gain')!, 0.1)).toBeLessThanOrEqual(0.5);
    }
  });

  it('A’s echo tail keeps ringing through B’s first bar for every flavor (rendered)', () => {
    const sr = 16000, n = 180 * sr;
    let seed = 12345;
    const noise = Float32Array.from({ length: n }, (_, i) => 0.1 * Math.sin(2 * Math.PI * 880 * i / sr) + 0.05 * ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 2 ** 32 - 0.5));
    const a = { L: noise, R: noise, sampleRate: sr }, silent = new Float32Array(n), b = { L: silent, R: silent, sampleRate: sr };
    const seen = new Set<string>();
    for (const p of [...plans(), ...plans(intro('all', -5))]) {
      if (seen.has(p.echoFlavor!)) continue;
      seen.add(p.echoFlavor!);
      const out = renderTransitionOffline(a, b, p, 2, 1);
      const rms = (from: number, to: number) => {
        let s = 0;
        const lo = Math.round(from * sr), hi = Math.round(to * sr);
        for (let i = lo; i < hi; i++) s += out.L[i] ** 2 + out.R[i] ** 2;
        return 10 * Math.log10(s / (hi - lo) / 2);
      };
      const cut = out.transitionStartFrame / sr + p.swapAt, before = rms(cut - barA - 1, cut - barA);
      // B is silent: everything after the cut is A's wet tail, ringing (not cut) over B's first bar
      expect(rms(cut + 0.05, cut + barB / 2) - before, p.echoFlavor).toBeGreaterThan(-20);
      expect(rms(cut + barB / 2, cut + barB) - before, p.echoFlavor).toBeGreaterThan(-30);
    }
    expect([...seen].sort()).toEqual(['brake', 'dub', 'washout']);
  });
});

describe('echo DSP', () => {
  it('width 1 ping-pongs the repeats L, R, L; the damping low-pass darkens them; width 0 is the plain echo', () => {
    const sr = 8000, d = 400, len = 4 * d;
    const run = (lowpass?: number, width?: number) => {
      const e = new Echo(sr);
      if (lowpass === undefined) e.configure(d, 0.8); else e.configure(d, 0.8, lowpass, width);
      const inL = new Float32Array(len), inR = new Float32Array(len), L = new Float32Array(len), R = new Float32Array(len);
      for (let i = 0; i < 40; i++) inL[i] = inR[i] = Math.sin(i * 2.7);
      e.process(inL, inR, L, R, len);
      const energy = (x: Float32Array, k: number) => x.slice(k * d, (k + 1) * d).reduce((s, v) => s + v * v, 0);
      return { L, R, energy };
    };
    const plain = run(), legacy = run(6000, 0), pong = run(6000, 1), dark = run(1000, 0);
    expect(legacy.L).toEqual(plain.L);
    expect(pong.energy(pong.L, 1)).toBeGreaterThan(100 * pong.energy(pong.R, 1));
    expect(pong.energy(pong.R, 2)).toBeGreaterThan(100 * pong.energy(pong.L, 2));
    expect(pong.energy(pong.L, 3)).toBeGreaterThan(100 * pong.energy(pong.R, 3));
    expect(dark.energy(dark.L, 2)).toBeLessThan(0.5 * plain.energy(plain.L, 2));
  });
});
