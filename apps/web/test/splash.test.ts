import { describe, expect, it, vi } from 'vitest';
import { BEAT, setSplashEnabled, skyAt, splashEnabled, T } from '../src/lib/splash.ts';

describe('launch splash timeline', () => {
  it('fits the 5–7 s brief, beats in order', () => {
    expect(T.end).toBeGreaterThanOrEqual(5);
    expect(T.end).toBeLessThanOrEqual(7);
    expect(T.bloom < T.hold && T.hold < T.flash && T.flash < T.fade && T.fade < T.end).toBe(true);
  });

  it('keeps a musical tempo with the green flash on a downbeat', () => {
    const bpm = 60 / BEAT;
    expect(bpm).toBeGreaterThan(90);
    expect(bpm).toBeLessThan(120);
    expect((T.flash / BEAT) % 4).toBeCloseTo(0);
  });

  it('starts golden and ends on the app background, so the handoff has no colour jump', () => {
    const [top, mid] = skyAt(0);
    expect(mid[0]).toBeGreaterThan(200);
    expect(top.map(Math.round)).not.toEqual([5, 13, 10]);
    const [endTop, endMid] = skyAt(T.end);
    expect(endTop.map(Math.round)).toEqual([5, 13, 10]); // --bg #050d0a
    expect(endMid.map(Math.round)).toEqual([5, 13, 10]);
  });
});

it('remembers when the intro is turned off in Settings', () => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
  setSplashEnabled(false);
  expect(splashEnabled()).toBe(false);
  setSplashEnabled(true);
  expect(splashEnabled()).toBe(true);
});
