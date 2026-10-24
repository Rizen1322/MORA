import { describe, expect, it } from 'vitest';
import { AudibleMotion, audibleDelay } from '../src/lib/audible-motion.ts';
describe('audible output visualisation', () => {
  it('delays render-ahead attacks until they reach the speaker time', () => {
    const motion = new AudibleMotion(), bins = new Float32Array(1024).fill(-25), signal = new Float32Array(2048).fill(.2);
    motion.update(bins, signal, 48000, 2048, .02, 1, .15);
    expect(motion.kick).toBe(0);
    for (let i = 1; i <= 8; i++) motion.update(bins, signal, 48000, 2048, .02, 1 + i * .02, .15);
    expect(motion.kick).toBeGreaterThan(.3);
  });
  it('uses the hardware output clock and bounded fallback latency', () => {
    expect(audibleDelay({ currentTime: 10, getOutputTimestamp: () => ({ contextTime: 9.8, performanceTime: 1000 }) }, 1050)).toBeCloseTo(.15);
    expect(audibleDelay({ currentTime: 0, baseLatency: .15, outputLatency: .02 }, 1000)).toBeCloseTo(.17);
    expect(audibleDelay({ currentTime: 10, baseLatency: 3 }, 1000)).toBe(.4);
  });
});
