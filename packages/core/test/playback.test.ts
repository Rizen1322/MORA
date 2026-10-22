import { describe, expect, it } from 'vitest';
import { PlaybackTransform, sanitizePlayback } from '../src/dsp/playback.ts';
import { MixerCore, type MixerEvent } from '../src/engine/mixer.ts';
import { CHUNK_FRAMES } from '../src/engine/chunks.ts';
import { LoudnessMeter } from '../src/dsp/loudness.ts';

const SR = 48000;
function signal(frequency: number, speed: number, semitones: number, seconds = 3) {
  let sourceFrames = 0;
  const effect = new PlaybackTransform(SR, (L, R, n) => {
    for (let i = 0; i < n; i++) L[i] = R[i] = .3 * Math.sin(2 * Math.PI * frequency * (sourceFrames + i) / SR);
    sourceFrames += n;
  });
  effect.set({ speed, semitones }); effect.reset();
  const L = new Float32Array(SR * seconds), R = new Float32Array(L.length);
  for (let off = 0; off < L.length; off += 128) effect.process(L.subarray(off, off + 128), R.subarray(off, off + 128), Math.min(128, L.length - off));
  return { L, R, sourceFrames, effect };
}
function frequency(x: Float32Array) {
  let first = -1, last = -1, count = 0;
  for (let i = SR; i < x.length; i++) if (x[i - 1] < 0 && x[i] >= 0) {
    const crossing = i - x[i] / (x[i] - x[i - 1]);
    if (first < 0) first = crossing;
    last = crossing; count++;
  }
  return (count - 1) * SR / (last - first);
}

describe('independent speed and pitch on a shared musical timeline', () => {
  it('sanitizes old and malformed settings', () => {
    expect(sanitizePlayback(undefined)).toEqual({ speed: 1, semitones: 0 });
    expect(sanitizePlayback({ speed: Infinity, semitones: '4' })).toEqual({ speed: 1, semitones: 0 });
    expect(sanitizePlayback({ speed: 9, semitones: -99 })).toEqual({ speed: 1.2, semitones: -6 });
  });
  it('neutral path is bit-identical and consumes exactly the requested frames', () => {
    const result = signal(440, 1, 0, 1);
    expect(result.sourceFrames).toBe(SR);
    expect(result.L).toEqual(Float32Array.from({ length: SR }, (_, i) => .3 * Math.sin(2 * Math.PI * 440 * i / SR)));
  });
  it.each([[.8, 0], [1.2, 0], [1, 6], [1, -6], [.8, 6], [1.2, -6]])('speed %s and pitch %s are independent', (speed, semitones) => {
    const r = signal(440, speed, semitones);
    expect(frequency(r.L)).toBeCloseTo(440 * 2 ** (semitones / 12), 0);
    expect(Math.abs(r.sourceFrames / SR - 3 * speed)).toBeLessThan(.12);
    expect(r.L.every(Number.isFinite)).toBe(true);
    expect(r.R).toEqual(r.L);
  });
  it('attenuates content that would alias when pitch is raised', () => {
    const r = signal(22000, 1, 6);
    const power = r.L.subarray(SR).reduce((sum, x) => sum + x * x, 0) / (r.L.length - SR);
    expect(Math.sqrt(power)).toBeLessThan(.003);
  });
  it('changes settings continuously and can return to neutral without skipping its buffered source', () => {
    let frame = 0;
    const fx = new PlaybackTransform(SR, (L, R, n) => {
      for (let i = 0; i < n; i++) L[i] = R[i] = .3 * Math.sin(2 * Math.PI * 220 * frame++ / SR);
    });
    const L = new Float32Array(128), R = L.slice(); let previous = 0, jump = 0;
    for (let b = 0; b < 1000; b++) {
      if (b === 100) fx.set({ speed: 1.2, semitones: 6 });
      if (b === 400) fx.set({ speed: .8, semitones: -6 });
      if (b === 700) fx.set({ speed: 1, semitones: 0 });
      fx.process(L, R, 128);
      for (const x of L) { expect(Number.isFinite(x)).toBe(true); jump = Math.max(jump, Math.abs(x - previous)); previous = x; }
    }
    expect(jump).toBeLessThan(.07);
  });
  it('renders transitions on the common timeline and keeps the final limiter after pitch processing', () => {
    const events: { event: MixerEvent; output: number }[] = []; let output = 0;
    const mixer = new MixerCore(SR, (event) => {
      if (event.type === 'need') for (const chunk of event.chunks) {
        const L = Float32Array.from({ length: CHUNK_FRAMES }, (_, i) => 1.1 * Math.sin(2 * Math.PI * (event.token === 'A' ? 440 : 660) * (chunk * CHUNK_FRAMES + i) / SR));
        mixer.feed(event.deck, event.token, chunk, L, L.slice());
      }
      events.push({ event, output });
    });
    mixer.setPlayback({ speed: 1.2, semitones: 6 });
    mixer.load(0, 'A', SR * 10, 0); mixer.load(1, 'B', SR * 10, 0);
    mixer.start(0, 'A', 0);
    mixer.arm({ planId: 'timing', method: 'test', fromToken: 'A', toToken: 'B', triggerFrame: SR,
      entryFrame: SR * 2, durationFrames: SR * 2, gapFrames: SR / 2, swapFrame: SR,
      tempoB: [[0, 1]], lanes: [
        { deck: 'A', lane: 0, points: [[0, 1], [SR * 2, 0]] },
        { deck: 'B', lane: 0, points: [[0, 0], [SR * 2, 1]] },
      ] });
    const L = new Float32Array(SR * 4), R = L.slice();
    for (; output < L.length; output += 128) mixer.process(L.subarray(output, output + 128), R.subarray(output, output + 128), Math.min(128, L.length - output));
    const swap = events.find(({ event }) => event.type === 'swap');
    const end = events.find(({ event }) => event.type === 'transitionEnd');
    expect(swap).toBeDefined(); expect(end).toBeDefined();
    expect(swap!.output / SR).toBeCloseTo(2 / 1.2, 0);
    expect(end!.output / SR).toBeCloseTo(3.5 / 1.2, 0);
    expect(events.some(({ event }) => event.type === 'underrun')).toBe(false);
    const meter = new LoudnessMeter(SR); meter.push([L, R]);
    expect(meter.result().truePeakDb).toBeLessThanOrEqual(-.95);
    mixer.seek('B', SR); mixer.process(new Float32Array(128), new Float32Array(128), 128);
    expect(mixer.decks[1].position()).toBeLessThan(SR * 1.2);
    mixer.stopAll();
    const stopped = new Float32Array(128); mixer.process(stopped, new Float32Array(128), 128);
    expect(stopped.every(x => x === 0)).toBe(true);
  });
  it('does not announce the end while the pitch transform still holds the last audible window', () => {
    let rendered = 0, endedAt = -1;
    const m = new MixerCore(SR, event => {
      if (event.type === 'ended') endedAt = rendered / SR;
      if (event.type === 'need') for (const chunk of event.chunks) {
        const L = Float32Array.from({ length: Math.min(CHUNK_FRAMES, SR - chunk * CHUNK_FRAMES) }, (_, i) => .2 * Math.sin(440 * 2 * Math.PI * (chunk * CHUNK_FRAMES + i) / SR));
        m.feed(event.deck, event.token, chunk, L, L.slice());
      }
    });
    m.setPlayback({ speed: 1.2, semitones: 6 }); m.load(0, 'end', SR, 0); m.start(0, 'end', 0);
    const L = new Float32Array(128), R = L.slice();
    while (rendered < SR * 2 && endedAt < 0) { m.process(L, R, 128); rendered += 128; }
    expect(endedAt).toBeGreaterThan(1 / 1.2 - .02);
    expect(endedAt).toBeLessThan(1 / 1.2 + .08);
  });
});
