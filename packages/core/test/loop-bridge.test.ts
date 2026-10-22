import { expect, it } from 'vitest';
import { LoopPcmSource } from '../src/engine/loop.ts';
import { ChunkStore, CHUNK_FRAMES } from '../src/engine/chunks.ts';
import { MixerCore, type MixerEvent } from '../src/engine/mixer.ts';
import { planToArmed, renderTransitionOffline } from '../src/engine/arm.ts';
import { planTransition, skipPlanFrom } from '../src/plan/planner.ts';
import { withInstrumentalLoop } from '../src/plan/loop.ts';
import { DEFAULT_AUTOMIX_SETTINGS as settings, type TrackAnalysis, type TransitionPlan } from '../src/types.ts';
import type { PcmSource } from '../src/dsp/wsola.ts';

function source(sr = 48000, duration = 20) {
  const L = Float32Array.from({ length: sr * duration }, (_, i) => .2 * Math.sin(2 * Math.PI * (i < sr * 6 ? 220 : 880) * i / sr) + .1 * i / (sr * duration));
  const pcm: PcmSource = { totalFrames: L.length, read(start, len, outL, outR, offset) {
    for (let i = 0; i < len; i++) outL[offset + i] = outR[offset + i] = L[start + i] ?? 0;
    return true;
  } };
  return { L, pcm, loop: new LoopPcmSource(pcm, sr) };
}
function plan(): TransitionPlan {
  const a = { id: 'a', duration: 20, analysis: null, mixingAllowed: true };
  return { ...planTransition(a, { ...a, id: 'b' }, settings), method: 'crossfade', aExit: 4, bEntry: 0, duration: 6, swapAt: 3,
    automation: [{ deck: 'A', lane: 'gain', points: [[0, 1], [6, 0]] }, { deck: 'B', lane: 'gain', points: [[0, 0], [6, 1]] }],
    loopA: { start: 4, end: 6, until: 10, crossfade: .006 }, debug: { processingAllowed: true } };
}

it('bypasses exactly without a loop, including out-of-range zeros and offsets', () => {
  const { pcm, loop } = source(), a = new Float32Array(500), b = a.slice(), c = a.slice(), d = a.slice();
  pcm.read(-10, 400, a, b, 20); loop.read(-10, 400, c, d, 20);
  expect(c).toEqual(a); expect(d).toEqual(b);
});

it('preserves the bar period and smooths a discontinuous source seam at device rates', () => {
  for (const sr of [32000, 44100, 48000, 96000]) {
    const { loop } = source(sr), start = sr * 2, end = sr * 4, fade = Math.round(sr * .006);
    expect(loop.setLoop({ start, end, until: sr * 8, fade })).toBe(true);
    const L = new Float32Array(2 * fade), R = L.slice();
    loop.read(end - fade, L.length, L, R, 0);
    let jump = 0; for (let i = 1; i < L.length; i++) jump = Math.max(jump, Math.abs(L[i] - L[i - 1]));
    expect(jump).toBeLessThan(.025);
    const next = L.slice(); loop.read(end - fade + end - start, L.length, next, R, 0);
    expect(next).toEqual(L);
  }
});

it('is independent of read block boundaries and stops finitely instead of resuming later vocals', () => {
  const { loop } = source(8000), spec = { start: 16000, end: 32000, until: 64000, fade: 48 };
  loop.setLoop(spec);
  const L = new Float32Array(70000), R = L.slice(), split = L.slice(), splitR = L.slice();
  loop.read(0, L.length, L, R, 0);
  for (let at = 0; at < L.length; at += 137) loop.read(at, Math.min(137, L.length - at), split, splitR, at);
  expect(split).toEqual(L); expect(L.subarray(64000).every(x => x === 0)).toBe(true);
  loop.setLoop(null); loop.read(65000, 10, split, splitR, 0);
  expect(split.subarray(0, 10).some(x => x !== 0)).toBe(true);
});

it('rejects invalid and unbounded loops and never conceals missing preroll PCM', () => {
  const { loop } = source(8000), valid = { start: 16000, end: 32000, until: 64000, fade: 48 };
  for (const spec of [{ ...valid, start: NaN }, { ...valid, until: 200000 }, { ...valid, fade: 1000 }, { ...valid, end: 200000 }, { ...valid, start: 1.5 }]) expect(loop.setLoop(spec)).toBe(false);
  const store = new ChunkStore(CHUNK_FRAMES * 3), missing = new LoopPcmSource(store, 8000);
  store.put(1, new Float32Array(CHUNK_FRAMES), new Float32Array(CHUNK_FRAMES));
  missing.setLoop({ start: CHUNK_FRAMES, end: CHUNK_FRAMES + 8000, until: CHUNK_FRAMES + 16000, fade: 48 });
  expect(missing.read(CHUNK_FRAMES + 8000 - 48, 48, new Float32Array(48), new Float32Array(48), 0)).toBe(false);
});

it('renders the loop through the shared mixer without underruns and clears it on seek/stop', () => {
  const sr = 8000, { L } = source(sr), silence = new Float32Array(L.length), p = plan();
  const rendered = renderTransitionOffline({ L, R: L, sampleRate: sr }, { L: silence, R: silence, sampleRate: sr }, p, 1, 1);
  expect(rendered.metrics.underruns).toBe(0); expect(rendered.L.every(Number.isFinite)).toBe(true);
  expect(rendered.events.filter(e => e.type === 'transitionEnd')).toHaveLength(1);
  const events: MixerEvent[] = [], m = new MixerCore(sr, e => events.push(e));
  for (const deck of [0, 1]) { const token = deck ? 'B' : 'A'; m.load(deck, token, L.length, 0);
    for (let c = 0; c < Math.ceil(L.length / CHUNK_FRAMES); c++) { const v = L.slice(c * CHUNK_FRAMES, (c + 1) * CHUNK_FRAMES); m.feed(deck, token, c, v, v); } }
  m.start(0, 'A', sr * 4); m.arm(planToArmed(p, sr, 'A', 'B'));
  const block = new Float32Array(128), right = block.slice();
  for (let i = 0; i < 150; i++) m.process(block, right, 128);
  expect(m.decks[0].loopSource.getLoop()).not.toBeNull();
  m.seek('A', sr); for (let i = 0; i < 20; i++) m.process(block, right, 128);
  expect(m.decks[0].loopSource.getLoop()).toBeNull();
  expect(events.some(e => e.type === 'underrun')).toBe(false);
  m.stopAll(); expect(m.decks.every(d => d.loopSource.getLoop() === null)).toBe(true);
  expect(skipPlanFrom(p, 5).loopA).toBeUndefined();
});

function measured(): TrackAnalysis {
  return { duration: 20, audibleEnd: 20, bodyRmsDb: -16,
    beat: { stable: true, confidence: .95, downbeatConfidence: .95, period: .5, jitterMs: 1, downbeats: Array.from({length: 11}, (_, i) => i * 2) },
    vocalActivity: { rate: 10, vocalRmsDb: Array(200).fill(-60), accompanimentRmsDb: Array(200).fill(-16) },
    curves: { rate: 10, rmsDb: Array.from({length: 200}, (_, i) => i < 140 ? -16 : -28) } } as unknown as TrackAnalysis;
}
it('only selects a measured quiet bar when the original tail drops before B arrives', () => {
  const A = measured(), p = { ...plan(), aExit: 10, duration: 8, loopA: undefined, entrySelection: { kind: 'section' as const, skippedSeconds: 0, arrivalTime: 6, confidence: .9 } };
  const selected = withInstrumentalLoop(p, A, A, settings);
  expect(selected.loopA).toMatchObject({ start: 10, end: 14, until: 18 });
  expect(selected.aExit).toBe(p.aExit); expect(selected.bEntry).toBe(p.bEntry); expect(selected.duration).toBe(p.duration);
  for (const change of ['voice', 'missing', 'grid', 'flat']) {
    const a = measured();
    if (change === 'voice') a.vocalActivity!.vocalRmsDb![190] = -20;
    if (change === 'missing') a.vocalActivity!.vocalRmsDb = undefined;
    if (change === 'grid') a.beat!.stable = false;
    if (change === 'flat') a.curves.rmsDb.fill(-16);
    expect(withInstrumentalLoop(p, a, A, settings).loopA).toBeUndefined();
  }
  expect(withInstrumentalLoop(p, A, A, settings, 10).loopA).toBeUndefined();
  expect(withInstrumentalLoop(p, A, A, {...settings, stemMixing: false}).loopA).toBeUndefined();
  expect(withInstrumentalLoop(p, A, A, {...settings, loopBridges: false}).loopA).toBeUndefined();
});
