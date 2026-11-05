import { expect, it } from 'vitest';
import { CREATIVE_TRANSITION_STYLES, planCreativeTransition } from '../src/plan/creative.ts';
import { pointValue } from '../src/plan/timing.ts';
import { renderTransitionOffline } from '../src/engine/arm.ts';
import { creativePair, setLevel } from './creative-fixtures.ts';

const revised = CREATIVE_TRANSITION_STYLES.filter(s => !['percussion-exchange', 'two-stage-bass'].includes(s.id));
it('introduces actual incoming music before releasing A, even through a six-second quiet intro', () => {
  for (const { id } of revised) {
    const c = creativePair(id), B = c.to.analysis!;
    setLevel(B, 0, 6, -40);
    const p = planCreativeTransition(c.from, c.to, c.settings, id);
    expect(p, id).not.toBeNull();
    if (!p) continue;
    const anchor = p.entrySelection!.arrivalTime!, incomingClock = p.swapAt - p.bDelay!;
    expect(anchor, id).toBeGreaterThanOrEqual(6);
    expect(p.bDelay!, id).toBeLessThan(p.swapAt - c.from.analysis!.beat!.period);
    expect(B.beat!.downbeats.some(t => Math.abs(t - anchor) < .002), id).toBe(true);
    const gainB = p.automation.find(l => l.deck === 'B' && l.lane === 'gain')!.points;
    expect(pointValue(gainB, incomingClock), id).toBeGreaterThanOrEqual(.8);
    const gainA = p.automation.find(l => l.deck === 'A' && l.lane === 'gain')!.points;
    for (let t = p.swapAt - .5; t < p.duration; t += .01) {
      const a = pointValue(gainA, t), b = pointValue(gainB, t - p.bDelay!);
      expect(a * a + b * b, `${id}@${t}`).toBeGreaterThan(.5);
    }
  }
});

it('renders the quiet intro handoff without the former long loudness hole', () => {
  for (const style of ['echo-adaptive', 'short-brake'] as const) {
  const c = creativePair(style); setLevel(c.to.analysis!, 0, 6, -40);
  const p = planCreativeTransition(c.from, c.to, c.settings, c.style)!;
  const sr = 8000, n = Math.round(c.from.duration * sr);
  const L = Float32Array.from({ length: n }, (_, i) => .2 * Math.sin(i * 2 * Math.PI * 440 / sr));
  const B = Float32Array.from({ length: n }, (_, i) => (i < sr * 6 ? .002 : .2) * Math.sin(i * 2 * Math.PI * 337 / sr));
  const r = renderTransitionOffline({ L, R: L, sampleRate: sr }, { L: B, R: B, sampleRate: sr }, p, 1, 1);
  expect(r.metrics.underruns).toBe(0);
  const handoff = r.transitionStartFrame + p.swapAt * sr;
  for (let offset = -sr; offset < sr; offset += sr / 4) {
    let power = 0; const start = Math.round(handoff + offset);
    for (let i = start; i < start + sr / 4; i++) power += r.L[i] * r.L[i];
    expect(10 * Math.log10(power / (sr / 4)), `${style} window ${offset / sr}`).toBeGreaterThan(-24);
  }
  }
});

it('lands the brake on both beat grids', () => {
  const d = creativePair('short-brake'), q = planCreativeTransition(d.from, d.to, d.settings, d.style)!;
  const handoff = q.aExit + q.swapAt;
  expect(d.from.analysis!.beat!.beats.some(t => Math.abs(t - handoff) < .0011)).toBe(true);
  expect(q.bDelay! + q.entrySelection!.arrivalTime! - q.bEntry).toBeCloseTo(q.swapAt, 3);
  expect(q.tapeStopA!.end - handoff).toBeCloseTo(.025, 3);
});

it('does not snap a decaying tail backwards into the still-loud outgoing phrase', () => {
  const c = creativePair('tail-threshold'), A = c.from.analysis!;
  setLevel(A, 0, 114.7, -16); setLevel(A, 114.7, 128, -38);
  const p = planCreativeTransition(c.from, c.to, c.settings, c.style)!;
  expect(p.aExit + p.swapAt).toBeGreaterThanOrEqual(114.7 - .001);
  expect(p.aExit + p.swapAt).toBeLessThan(115);
});

it('does not apply bass, mid, high or filter automation with EQ handoff disabled', () => {
  for (const { id } of CREATIVE_TRANSITION_STYLES) {
    const c = creativePair(id), p = planCreativeTransition(c.from, c.to, { ...c.settings, eqHandoff: false }, id);
    if (p) expect(p.automation.some(l => ['low', 'mid', 'high', 'filter'].includes(l.lane)), id).toBe(false);
  }
});

it('pins comparisons to the nearest valid outgoing handoff without forcing an unsafe cue', () => {
  const c = creativePair('echo-adaptive');
  const p = planCreativeTransition(c.from, c.to, c.settings, c.style, 100)!;
  expect(p.aExit + p.swapAt).toBeCloseTo(100, 3);
  const q = planCreativeTransition(c.from, c.to, c.settings, c.style, 1)!;
  expect(q.aExit).toBeGreaterThan(0);
  expect(q.aExit + q.duration).toBeLessThanOrEqual(c.from.analysis!.audibleEnd);
});

it('keeps B silent until the final beat instead of exposing its entire preroll', () => {
  for (const { id } of revised.filter(s => s.id !== 'short-brake')) {
    const c = creativePair(id); setLevel(c.to.analysis!, 0, 6, -40);
    const p = planCreativeTransition(c.from, c.to, c.settings, id)!;
    const incoming = p.swapAt - p.bDelay!, approach = Math.max(c.from.analysis!.beat!.period, c.to.analysis!.beat!.period);
    const gain = p.automation.find(l => l.deck === 'B' && l.lane === 'gain')!.points;
    expect(pointValue(gain, incoming - approach - .01), id).toBe(0);
    expect(pointValue(gain, incoming - approach / 2), id).toBeGreaterThan(.1);
  }
});

it('leaves audible slowing repeats after A dry stops, while B carries the bass', () => {
  const c = creativePair('slowing-echo'), p = planCreativeTransition(c.from, c.to, c.settings, c.style)!;
  const sr = 8000, n = c.from.duration * sr;
  const A = Float32Array.from({ length: n }, (_, i) => .2 * Math.sin(i * 2 * Math.PI * 440 / sr));
  const B = Float32Array.from({ length: n }, (_, i) => .2 * Math.sin(i * 2 * Math.PI * 90 / sr));
  const a = { L: A, R: A, sampleRate: sr }, b = { L: B, R: B, sampleRate: sr };
  const wet = renderTransitionOffline(a, b, p, 1, 1), dry = renderTransitionOffline(a, b, { ...p, echo: undefined }, 1, 1);
  const handoff = wet.transitionStartFrame + Math.round(p.swapAt * sr), beatB = c.to.analysis!.beat!.period;
  const gainA = p.automation.find(l => l.deck === 'A' && l.lane === 'gain')!.points;
  expect(pointValue(gainA, p.swapAt + .05)).toBe(0);
  for (const [start, end] of [[.1, beatB], [beatB, 2 * beatB]]) {
    let repeats = 0, incoming = 0;
    for (let i = handoff + Math.round(start * sr); i < handoff + Math.round(end * sr); i++) {
      repeats += (wet.L[i] - dry.L[i]) ** 2; incoming += dry.L[i] ** 2;
    }
    expect(repeats / incoming).toBeGreaterThan(.04);
  }
  expect(p.echo!.clearAt).toBeGreaterThanOrEqual(p.swapAt + 3 * beatB - .001);
  expect(p.echo!.delayPoints!.at(-1)![1]).toBeCloseTo(beatB, 3);
});
