import { describe, expect, it } from 'vitest';
import { CHUNK_FRAMES } from '../src/engine/chunks.ts';
import { MixerCore, type MixerEvent } from '../src/engine/mixer.ts';

describe('bounded live PCM windows', () => {
  const sr = 8000;
  const total = CHUNK_FRAMES * 64;
  const prepare = () => {
    const events: MixerEvent[] = [];
    const m = new MixerCore(sr, e => events.push(e));
    m.load(0, 'A', total, 0);
    const d = m.decks[0];
    for (let c = 0; c < 64; c++) {
      const pcm = Float32Array.from({ length: CHUNK_FRAMES }, (_, i) =>
        0.1 * Math.sin(2 * Math.PI * 200 * (c * CHUNK_FRAMES + i) / sr));
      m.feed(0, 'A', c, pcm, pcm);
      m.feedVocal(0, 'A', c, pcm, pcm);
    }
    return { m, d, events };
  };

  it('releases played history instead of pinning every chunk back to the original cue', () => {
    const { m, d, events } = prepare();
    const position = CHUNK_FRAMES * 30;
    m.start(0, 'A', position);
    expect(d.store.has(0)).toBe(false);
    expect(d.vocalStore.has(0)).toBe(false);
    expect(d.store.loadedCount()).toBeLessThanOrEqual(15);
    expect(d.store.has(30)).toBe(true);
    const L = new Float32Array(128), R = new Float32Array(128);
    for (let i = 0; i < 20; i++) m.process(L, R, 128);
    expect(d.position()).toBe(position + 2560);
    expect(L.every(Number.isFinite)).toBe(true);
    expect(L.some(x => Math.abs(x) > 0.01)).toBe(true);
    expect(events.some(e => e.type === 'underrun')).toBe(false);
  });

  it('keeps future handoff stems without retaining every chunk between the two windows', () => {
    const { m, d } = prepare();
    m.arm({ planId: 'future', method: 'beatmatch_blend', fromToken: 'A', toToken: 'B',
      triggerFrame: CHUNK_FRAMES * 48, entryFrame: 0, durationFrames: sr * 2,
      gapFrames: 0, swapFrame: sr, tempoB: [[0, 1]],
      vocalA: [[0, 1], [sr, 0]], lanes: [],
    });
    expect(d.vocalStore.has(0)).toBe(true);
    expect(d.vocalStore.has(48)).toBe(true);
    expect(d.vocalStore.has(24)).toBe(false);
    expect(d.vocalStore.loadedCount()).toBeLessThanOrEqual(26);
  });

  it('keeps the audible old window until a distant seek fade finishes', () => {
    const { m, d, events } = prepare();
    m.start(0, 'A', CHUNK_FRAMES * 30);
    // Destination data arrives before seek, like a completed prefetch.
    const pcm = new Float32Array(CHUNK_FRAMES).fill(0.1);
    m.feed(0, 'A', 1, pcm, pcm);
    m.seek('A', CHUNK_FRAMES);
    expect(d.store.has(30)).toBe(true);
    expect(d.store.has(1)).toBe(true);
    const L = new Float32Array(128), R = new Float32Array(128);
    m.process(L, R, 128);
    m.process(L, R, 128);
    expect(events.some(e => e.type === 'underrun')).toBe(false);
  });
});
