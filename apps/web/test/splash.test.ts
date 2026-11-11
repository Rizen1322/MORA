import { afterEach, describe, expect, it, vi } from 'vitest';
import { BEAT, markPath, setSplashEnabled, splashEnabled, T } from '../src/lib/splash.ts';
afterEach(() => vi.unstubAllGlobals());

it('skips background launches and releases the overlay when hidden, without replaying', async () => {
  vi.resetModules();
  const splash = await import('../src/lib/splash.ts');
  const listeners = new Map<string, () => void>();
  const root = { className: '', setAttribute: vi.fn(), append: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), remove: vi.fn() };
  const draw = new Proxy({}, { get: () => vi.fn() });
  const doc = { hidden: true, createElement: vi.fn((tag: string) => tag === 'canvas' ? { getContext: () => draw } : root),
    body: { append: vi.fn() }, fonts: { load: async () => {} },
    addEventListener: (name: string, fn: () => void) => listeners.set(name, fn), removeEventListener: vi.fn() };
  vi.stubGlobal('document', doc);
  vi.stubGlobal('location', { search: '' });
  vi.stubGlobal('addEventListener', vi.fn());
  vi.stubGlobal('removeEventListener', vi.fn());
  vi.stubGlobal('dispatchEvent', vi.fn());
  vi.stubGlobal('requestAnimationFrame', vi.fn());
  const options = { ready: () => false, target: () => null };
  splash.playSplash(options);
  expect(doc.createElement).not.toHaveBeenCalled();
  doc.hidden = false;
  splash.playSplash(options);
  expect(doc.body.append).toHaveBeenCalledOnce();
  expect(splash.splashing).toBe(true);
  doc.hidden = true;
  listeners.get('visibilitychange')!();
  expect(splash.splashing).toBe(false);
  expect(root.remove).toHaveBeenCalledOnce();
  doc.hidden = false;
  splash.playSplash(options);
  expect(doc.body.append).toHaveBeenCalledOnce();
});

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

it('keeps Reduce Motion static until the app behind it is ready', async () => {
  vi.useFakeTimers(); vi.resetModules();
  const frames: FrameRequestCallback[] = [];
  const metrics = { width: 20, fontBoundingBoxAscent: 20, fontBoundingBoxDescent: 4, actualBoundingBoxRight: 20, actualBoundingBoxLeft: 0, actualBoundingBoxAscent: 20, actualBoundingBoxDescent: 4, addColorStop: vi.fn() };
  const draw = new Proxy({}, { get: (_target, key) => key === 'measureText' ? () => metrics : vi.fn(() => metrics) });
  const root = { style: {}, setAttribute: vi.fn(), append: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), remove: vi.fn() };
  const doc = { hidden: false, createElement: (tag: string) => tag === 'canvas' ? { getContext: () => draw } : root,
    body: { append: vi.fn() }, documentElement: { dataset: { motion: 'reduced' }, classList: { contains: () => true } },
    fonts: { load: async () => {}, check: () => true }, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  vi.stubGlobal('document', doc); vi.stubGlobal('location', { search: '' });
  vi.stubGlobal('innerWidth', 390); vi.stubGlobal('innerHeight', 844); vi.stubGlobal('devicePixelRatio', 3);
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => frames.push(fn));
  vi.stubGlobal('addEventListener', vi.fn()); vi.stubGlobal('removeEventListener', vi.fn()); vi.stubGlobal('dispatchEvent', vi.fn());
  const splash = await import('../src/lib/splash.ts');
  let ready = false, time = 100;
  splash.playSplash({ ready: () => ready, target: () => null });
  for (let i = 0; i < 60; i++) { time += 16; frames.shift()?.(time); }
  expect(splash.splashing).toBe(true);
  expect(root.remove).not.toHaveBeenCalled();
  ready = true;
  for (let i = 0; i < 60 && frames.length; i++) { time += 16; frames.shift()?.(time); }
  expect(splash.splashing).toBe(false);
  await vi.runAllTimersAsync(); vi.useRealTimers();
});
