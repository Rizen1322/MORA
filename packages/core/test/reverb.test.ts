import { describe, expect, it } from 'vitest';
import { MasterReverb } from '../src/dsp/reverb.ts';
import { sanitizeTone } from '../src/dsp/tone.ts';
import { FLAT_TONE, EQ_BANDS } from '../src/dsp/tone.ts';
import { MixerCore } from '../src/engine/mixer.ts';
import { CHUNK_FRAMES } from '../src/engine/chunks.ts';
import { LoudnessMeter } from '../src/dsp/loudness.ts';

describe('listener room effect', () => {
  it.each(['mono', 'left'] as const)('keeps hot audio below the true-peak ceiling and respects %s after the room', (mode) => {
    const sr = 48000, frames = sr * 3;
    const L = Float32Array.from({ length: frames }, (_, i) => i < sr * 2
      ? .8 * Math.sin(2 * Math.PI * 55 * i / sr) + .6 * Math.sin(2 * Math.PI * 7000 * i / sr) : 0);
    const R = Float32Array.from({ length: frames }, (_, i) => i < sr * 2
      ? .7 * Math.sin(2 * Math.PI * 73 * i / sr) - .5 * Math.sin(2 * Math.PI * 11000 * i / sr) : 0);
    const m = new MixerCore(sr, (event) => {
      if (event.type === 'need') for (const c of event.chunks) {
        const offset = c * CHUNK_FRAMES;
        m.feed(event.deck, event.token, c, L.slice(offset, offset + CHUNK_FRAMES), R.slice(offset, offset + CHUNK_FRAMES));
      }
    });
    m.setTone({ ...FLAT_TONE, enabled: true, reverbMix: .35, preampDb: 6, autoHeadroom: false,
      gains: EQ_BANDS.map((_, i) => i < 3 ? 12 : 0), mono: mode === 'mono', balance: mode === 'left' ? -1 : 0 });
    m.load(0, 'room-test', frames, 1);
    for (let c = 0; c * CHUNK_FRAMES < frames; c++) {
      const offset = c * CHUNK_FRAMES;
      m.feed(0, 'room-test', c, L.slice(offset, offset + CHUNK_FRAMES), R.slice(offset, offset + CHUNK_FRAMES));
    }
    m.start(0, 'room-test', 0);
    const outL = new Float32Array(frames), outR = new Float32Array(frames);
    for (let offset = 0; offset < frames; offset += 128) {
      m.process(outL.subarray(offset, offset + 128), outR.subarray(offset, offset + 128), Math.min(128, frames - offset));
    }
    expect(outL.every(Number.isFinite) && outR.every(Number.isFinite)).toBe(true);
    const meter = new LoudnessMeter(sr); meter.push([outL, outR]);
    expect(meter.result().truePeakDb).toBeLessThanOrEqual(-.95);
    // Test the settled controls, including the stereo room tail after the source becomes silent.
    const tail = outL.subarray(sr * 2 + 1024);
    expect(tail.some((v) => Math.abs(v) > 1e-6)).toBe(true);
    for (let i = sr; i < frames; i++) {
      expect(Math.abs(mode === 'mono' ? outL[i] - outR[i] : outR[i])).toBeLessThan(1e-6);
    }
  });
  it('is bit-identical when off and sanitizes invalid saved values', () => {
    const effect = new MasterReverb(48000);
    const L = Float32Array.from({ length: 128 }, (_, i) => Math.sin(i)), R = L.slice(), before = L.slice();
    effect.process(L, R, 128); expect(L).toEqual(before); expect(R).toEqual(before);
    expect(sanitizeTone({ reverbMix: Infinity }).reverbMix).toBe(0);
    expect(sanitizeTone({ reverbMix: 2 }).reverbMix).toBe(.35);
  });
  it.each([22050, 48000, 96000])('has a decaying stereo tail and bounded peaks at %s Hz', (sr) => {
    const effect = new MasterReverb(sr); effect.setMix(.35);
    const L = new Float32Array(128), R = new Float32Array(128);
    for (let b = 0; b < Math.ceil(sr / 128); b++) { L.fill(0); R.fill(0); effect.process(L, R, 128); }
    let early = 0, late = 0, difference = 0, peak = 0;
    for (let b = 0; b < Math.ceil(sr * 3 / 128); b++) {
      L.fill(0); R.fill(0); if (b === 0) L[0] = R[0] = 1;
      effect.process(L, R, 128);
      for (let i = 0; i < 128; i++) {
        const frame = b * 128 + i, power = L[i] ** 2 + R[i] ** 2;
        if (frame > sr * .02 && frame < sr * .5) early += power;
        if (frame > sr * 2.5) late += power;
        difference += Math.abs(L[i] - R[i]); peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
      }
    }
    expect(early).toBeGreaterThan(1e-5); expect(late).toBeLessThan(early * 1e-3); expect(difference).toBeGreaterThan(0); expect(peak).toBeLessThanOrEqual(1);
  });
});
