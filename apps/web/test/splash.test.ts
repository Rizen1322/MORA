import { describe, expect, it, vi } from 'vitest';
import { BEAT, markPath, setSplashEnabled, splashEnabled, T } from '../src/lib/splash.ts';

describe('launch splash timeline', () => {
  it('fits the 3–5 s brief, beats in order', () => {
    expect(T.end).toBeGreaterThanOrEqual(3);
    expect(T.end).toBeLessThanOrEqual(5);
    expect(T.bloom < T.grid && T.grid < T.word && T.word < T.dot && T.dot < T.hold && T.hold < T.fade && T.fade < T.end).toBe(true);
  });

  it('cuts on a musical grid with the word on a downbeat', () => {
    for (const t of [T.bloom, T.grid, T.word, T.dot, T.hold]) expect((t / BEAT) % 1).toBeCloseTo(0);
    expect((T.word / BEAT) % 4).toBeCloseTo(0);
  });
});

describe('the mark as one stroke', () => {
  const p = markPath();
  it('is continuous and evenly paced, so the brush never jumps', () => {
    const steps = p.slice(1).map(([x, y], i) => Math.hypot(x - p[i][0], y - p[i][1]));
    expect(Math.max(...steps)).toBeLessThan(4.01 / 951);
    expect(Math.min(...steps.slice(0, -1))).toBeGreaterThan(3 / 951);
  });
  it('runs left to right inside the logo frame', () => {
    expect(p[0][0]).toBeLessThan(-0.4);
    expect(p.at(-1)![0]).toBeGreaterThan(0.4);
    for (const [x, y] of p) { expect(Math.abs(x)).toBeLessThan(0.5); expect(Math.abs(y)).toBeLessThan(0.36); }
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
