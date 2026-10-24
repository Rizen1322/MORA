import { describe, expect, it } from 'vitest';
import { NativeMixerRuntime } from '../src/native-mixer.ts';
import type { NativeMixConfig } from '../../web/src/lib/native-mix.ts';
const sr = 48000;
const config = (): NativeMixConfig => ({ sampleRate: sr, position: 0, tracks: [0, 1].map(i => ({
  title: `test ${i}`, artist: '', totalFrames: sr * 3, gainDb: 0,
})), transition: { planId: 'test', method: 'beatmatch_blend', fromToken: 'A', toToken: 'B',
  triggerFrame: sr / 2, entryFrame: 0, durationFrames: sr, gapFrames: 0, swapFrame: sr / 2,
  tempoB: [[0, 1.02], [sr, 1]], lanes: [
    { deck: 'A', lane: 0, points: [[0, 1], [sr, 0]] },
    { deck: 'B', lane: 0, points: [[0, 0], [sr, 1]] },
  ] } });
function reader(index: number, chunk: number) {
  const start = chunk * 32768, frames = Math.max(0, Math.min(32768, sr * 3 - start));
  const data = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) data[i * 2] = data[i * 2 + 1] = Math.sin((start + i) * (index ? .04 : .03)) * .2;
  return Buffer.from(data.buffer).toString('base64');
}
describe('native prepared-pair mixer', () => {
  it.each([44100, 48000])('starts a long DJ transition with native prefetch at %i Hz, including an 8-second lead-in seek', rate => {
    const c = config();
    c.sampleRate = rate; c.position = 4;
    c.tracks = c.tracks.map(t => ({ ...t, totalFrames: rate * 32 }));
    c.transition = { ...c.transition!, triggerFrame: rate * 12, entryFrame: rate * 6,
      durationFrames: rate * 8, swapFrame: rate * 4, tempoB: [[0, 1.02], [rate * 8, 1]],
      lanes: [
        { deck: 'A', lane: 0, points: [[0, 1], [rate * 8, 0]] },
        { deck: 'B', lane: 0, points: [[0, 0], [rate * 8, 1]] },
      ] };
    const r = new NativeMixerRuntime(c, (deck, chunk) => {
      const frames = Math.min(32768, rate * 32 - chunk * 32768);
      return Buffer.from(new Float32Array(frames * 2).fill(deck ? .12 : .2).buffer).toString('base64');
    });
    const events = [];
    for (let i = 0; i < Math.ceil(rate * 18 / 4096); i++) events.push(...r.render().events);
    expect(events.filter(e => e.type === 'fallback')).toEqual([]);
    expect(events.filter(e => ['transitionStart', 'swap', 'transitionEnd'].includes(e.type)).map(e => e.type))
      .toEqual(['transitionStart', 'swap', 'transitionEnd']);
    expect(events.find(e => e.type === 'transitionStart')).toMatchObject({ late: false });
  });
  it('renders the actual two-deck transition without WebKit and tags output time separately', () => {
    const r = new NativeMixerRuntime(config(), reader);
    const types: string[] = [];
    let frames = 0, heard = 0, done = false;
    for (let i = 0; i < 80; i++) {
      const b = r.render(); frames += b.left.length;
      types.push(...b.events.map(e => e.type));
      expect(b.marks[0].offset).toBe(0);
      expect(b.marks.at(-1)!.offset).toBe(b.left.length);
      expect(b.left.every(Number.isFinite)).toBe(true);
      heard += b.left.reduce((n, x) => n + x * x, 0);
      if (b.done) { done = true; break; }
    }
    expect(types.filter(x => ['transitionStart', 'swap', 'transitionEnd'].includes(x))).toEqual(['transitionStart', 'swap', 'transitionEnd']);
    expect(types).not.toContain('underrun');
    expect(done).toBe(true); expect(heard).toBeGreaterThan(100);
    expect(frames).toBeGreaterThan(sr * 3);
  });
  it('starts the second track directly and does not replay an obsolete transition', () => {
    const r = new NativeMixerRuntime({ ...config(), index: 1, position: 1.5 }, reader);
    const b = r.render();
    expect(b.marks[0]).toEqual({ offset: 0, index: 1, position: 1.5 });
    expect(b.marks.at(-1)!.position).toBeGreaterThan(1.5);
    expect(b.events.some(e => e.type === 'transitionStart')).toBe(false);
  });
  it('fails preparation on missing or malformed PCM instead of producing hidden gaps', () => {
    expect(() => new NativeMixerRuntime(config(), () => '')).toThrow();
    expect(() => new NativeMixerRuntime(config(), () => 'invalid')).toThrow();
  });
});
