import { describe, expect, it } from 'vitest';
import { CREATIVE_TRANSITION_STYLES, planCreativeTransition } from '../src/plan/creative.ts';
import { planTransition } from '../src/plan/planner.ts';
import { pointValue } from '../src/plan/timing.ts';
import { LoopPcmSource } from '../src/engine/loop.ts';
import { creativeCases, creativePair, creativeTrack } from './creative-fixtures.ts';

describe('explicit creative transition auditions', () => {
  for (const test of creativeCases()) it(`${test.style}: finite bounded plan with preserved first phrase`, () => {
    const p = planCreativeTransition(test.from, test.to, test.settings, test.style);
    expect(p).not.toBeNull();
    if (!p) return;
    expect(p.bEntry).toBe(test.to.analysis!.audibleStart);
    expect(p.entrySelection!.skippedSeconds).toBe(0);
    expect(p.duration).toBeGreaterThan(0);
    expect(p.duration).toBeLessThanOrEqual(test.settings.maxBlendSeconds);
    expect(p.aExit).toBeGreaterThanOrEqual(test.from.analysis!.audibleStart);
    expect(p.aExit + p.duration).toBeLessThanOrEqual(test.from.analysis!.audibleEnd);
    expect(p.bEntry + p.duration - (p.bDelay ?? 0)).toBeLessThanOrEqual(test.to.analysis!.audibleEnd);
    expect(p.swapAt).toBeGreaterThanOrEqual(0);
    expect(p.swapAt).toBeLessThanOrEqual(p.duration);
    expect(p.debug.creative).toMatchObject({ style: test.style, experimental: true });
    expect(p.confidence).toBeGreaterThanOrEqual(0);
    expect(p.confidence).toBeLessThanOrEqual(1);
    const identities = new Set<string>();
    for (const l of p.automation) {
      const key = `${l.deck}:${l.lane}`;
      expect(identities.has(key)).toBe(false); identities.add(key);
      expect(l.points.length).toBeGreaterThanOrEqual(2);
      expect(l.points[0][0]).toBe(0);
      const end = p.duration - (l.deck === 'B' ? p.bDelay ?? 0 : 0);
      expect(l.points.at(-1)![0]).toBeCloseTo(end, 8);
      for (let i = 0; i < l.points.length; i++) {
        const [t, v] = l.points[i];
        expect(Number.isFinite(t) && Number.isFinite(v)).toBe(true);
        expect(t).toBeGreaterThanOrEqual(0); expect(t).toBeLessThanOrEqual(end + 1e-8);
        expect(v).toBeGreaterThanOrEqual(l.lane === 'filter' ? -1 : 0); expect(v).toBeLessThanOrEqual(1);
        if (i) expect(t).toBeGreaterThan(l.points[i - 1][0]);
      }
    }
    expect(pointValue(p.automation.find(l => l.deck === 'A' && l.lane === 'gain')!.points, p.duration)).toBe(0);
    expect(p.automation.find(l => l.deck === 'B' && l.lane === 'gain')!.points[0]).toEqual([0, 0]);
    expect(pointValue(p.automation.find(l => l.deck === 'B' && l.lane === 'gain')!.points, p.duration - (p.bDelay ?? 0))).toBe(1);
    if (p.echo) {
      expect(p.echo.feedback).toBeLessThanOrEqual(.72);
      expect(p.echo.clearAt).toBeGreaterThan(0); expect(p.echo.clearAt).toBeLessThanOrEqual(p.duration);
      expect(p.echo.delay).toBeGreaterThan(0);
    }
  });

  it('all fifteen plans have a distinct executable character', () => {
    const fingerprints = creativeCases().map(c => {
      const p = planCreativeTransition(c.from, c.to, c.settings, c.style)!;
      return JSON.stringify([p.duration, p.bDelay, p.automation, p.echo, p.loopA, p.tapeStopA]);
    });
    expect(new Set(fingerprints).size).toBe(15);
    const pickup = creativePair('echo-pickup'), p = planCreativeTransition(pickup.from, pickup.to, pickup.settings, pickup.style)!;
    expect(p.bDelay! + pickup.to.analysis!.beat!.downbeats.find(t => t >= p.bEntry)! - p.bEntry).toBeCloseTo(p.swapAt, 3);
    const slow = creativePair('slowing-echo'), q = planCreativeTransition(slow.from, slow.to, slow.settings, slow.style)!;
    const delays = q.echo!.delayPoints!;
    for (let i = 1; i < delays.length; i++) { expect(delays[i][0]).toBeGreaterThan(delays[i - 1][0]); expect(delays[i][1]).toBeGreaterThanOrEqual(delays[i - 1][1]); }
    const bass = creativePair('two-stage-bass'), r = planCreativeTransition(bass.from, bass.to, bass.settings, bass.style)!;
    const lowA = r.automation.find(l => l.deck === 'A' && l.lane === 'low')!.points, lowB = r.automation.find(l => l.deck === 'B' && l.lane === 'low')!.points;
    expect(pointValue(lowA, r.swapAt)).toBe(0); expect(pointValue(lowB, r.swapAt - r.bDelay!)).toBe(0);
    expect(pointValue(lowB, r.swapAt - r.bDelay! + .5)).toBe(.55);
  });

  it('finite loop and tape plans satisfy the actual PCM source guards at both output rates', () => {
    for (const style of ['single-loop', 'short-brake'] as const) {
      const c = creativePair(style), p = planCreativeTransition(c.from, c.to, c.settings, style)!;
      for (const sr of [44100, 48000]) {
        const source = new LoopPcmSource({ totalFrames: c.from.duration * sr, read: () => true }, sr);
        if (p.loopA) {
          const l = p.loopA; expect(l.roll).toBeUndefined(); expect(l.until - l.start).toBeCloseTo(2 * (l.end - l.start), 8);
          expect(source.setLoop({ start: Math.round(l.start * sr), end: Math.round(l.end * sr), until: Math.round(l.until * sr), fade: Math.round(l.crossfade * sr) })).toBe(true);
        } else {
          const t = p.tapeStopA!;
          expect(source.setTapeStop({ start: Math.round(t.start * sr), end: Math.round(t.end * sr), fade: Math.round(t.crossfade * sr) })).toBe(true);
          const incomingClock = p.swapAt - (p.bDelay ?? 0);
          expect(pointValue(p.automation.find(l => l.deck === 'B' && l.lane === 'gain')!.points, incomingClock)).toBe(1);
          expect(p.bDelay!).toBeLessThan(t.start - p.aExit);
        }
      }
    }
  });

  it('rejects absent, malformed, restricted, short or inapplicable measurements', () => {
    for (const style of CREATIVE_TRANSITION_STYLES) {
      const c = creativePair(style.id);
      expect(planCreativeTransition({ ...c.from, analysis: null }, c.to, c.settings, style.id)).toBeNull();
      expect(planCreativeTransition({ ...c.from, mixingAllowed: false }, c.to, c.settings, style.id)).toBeNull();
      expect(planCreativeTransition(c.from, c.to, { ...c.settings, maxBlendSeconds: .1 }, style.id)).toBeNull();
      expect(planCreativeTransition(c.from, c.to, { ...c.settings, enabled: false }, style.id)).toBeNull();
      c.from.analysis!.beat!.downbeats[1] = NaN;
      expect(planCreativeTransition(c.from, c.to, c.settings, style.id)).toBeNull();
    }
    const half = creativePair('half-time-handoff');
    expect(planCreativeTransition(half.from, creativeTrack('c', 90), half.settings, half.style)).toBeNull();
    const adaptive = creativePair('echo-adaptive'); delete adaptive.to.analysis!.local;
    expect(planCreativeTransition(adaptive.from, adaptive.to, adaptive.settings, adaptive.style)).toBeNull();
    const stereo = creativePair('stereo-reveal');
    stereo.from.analysis!.stereo!.correlation.fill(-.2);
    expect(planCreativeTransition(stereo.from, stereo.to, stereo.settings, stereo.style)).toBeNull();
    delete stereo.from.analysis!.stereo;
    expect(planCreativeTransition(stereo.from, stereo.to, stereo.settings, stereo.style)).toBeNull();
    const corrupt = creativePair('dub-throw'); corrupt.from.analysis!.curves.rmsDb.fill(NaN);
    expect(planCreativeTransition(corrupt.from, corrupt.to, corrupt.settings, corrupt.style)).toBeNull();
  });

  it('rejects bass holes and audible native drift instead of calling them bass exchanges', () => {
    for (const style of ['half-time-handoff', 'percussion-exchange', 'two-stage-bass'] as const) {
      const quiet = creativePair(style), B = quiet.to.analysis!;
      for (let i = 0; i < 12 * B.curves.rate; i++) { B.curves.rmsDb[i] -= 20; B.curves.lowDb[i] -= 20; B.curves.highDb[i] -= 20; }
      const quietPlan = planCreativeTransition(quiet.from, quiet.to, quiet.settings, style);
      if (style === 'half-time-handoff') {
        expect(quietPlan).not.toBeNull();
        expect(quietPlan!.entrySelection!.arrivalTime).toBeGreaterThanOrEqual(12);
      } else expect(quietPlan).toBeNull();
      const drift = creativePair(style), g = drift.to.analysis!.beat!;
      g.bpm *= 1.014; g.period /= 1.014; g.beats = g.beats.map(t => t / 1.014); g.downbeats = g.downbeats.map(t => t / 1.014);
      if (style === 'half-time-handoff') drift.to.analysis!.audibleStart = .5;
      expect(planCreativeTransition(drift.from, drift.to, drift.settings, style)).toBeNull();
      for (const deck of ['from', 'to'] as const) {
        const noBass = creativePair(style); noBass[deck].analysis!.curves.lowDb.fill(-60);
        expect(planCreativeTransition(noBass.from, noBass.to, noBass.settings, style)).toBeNull();
      }
    }
  });

  it('does not change automatic planning or depend on separated PCM', () => {
    const c = creativePair('echo-adaptive'), before = planTransition(c.from, c.to, c.settings);
    const inputs = JSON.stringify(c);
    planCreativeTransition(c.from, c.to, c.settings, c.style);
    expect(JSON.stringify(c)).toBe(inputs);
    expect(planTransition(c.from, c.to, c.settings)).toEqual(before);
    for (const x of creativeCases()) {
      const p = planCreativeTransition(x.from, x.to, { ...x.settings, stemMixing: false }, x.style)!;
      expect(p).not.toBeNull(); expect(p.vocalA).toBeUndefined(); expect(p.vocalB).toBeUndefined();
    }
  });
});
