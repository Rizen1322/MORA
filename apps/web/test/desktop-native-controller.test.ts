import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_AUTOMIX_SETTINGS, planToArmed, planTransition } from '@automix/core';
import type { NativeMixState } from '../src/lib/native-mix.ts';

const bridge = vi.hoisted(() => ({ nativeMix: {} as Record<string, unknown> }));
vi.mock('../src/lib/desktop.ts', () => ({ desktop: bridge }));
vi.mock('../src/audio/engine.worklet.ts?worker&url', () => ({ default: '/engine.js' }));
vi.mock('../src/lib/api.ts', () => ({ api: { focus: vi.fn(async () => {}), saveQueue: vi.fn(async () => {}),
  startPlay: vi.fn(async () => ({ id: 1 })), endPlay: vi.fn(async () => {}) }, ApiError: class extends Error {} }));

afterEach(() => {
  for (const key of Object.keys(bridge.nativeMix)) delete bridge.nativeMix[key];
  vi.unstubAllGlobals();
});

it.each(['playing', 'error'] as const)('settles a desktop station start after settings are saved: %s', async outcome => {
  let resolve!: (state: NativeMixState) => void, reject!: (error: Error) => void;
  const pending = new Promise<NativeMixState>((ok, fail) => { resolve = ok; reject = fail; });
  const plan = { ...planTransition({ id: 'a', duration: 20, mixingAllowed: true, analysis: null },
    { id: 'b', duration: 30, mixingAllowed: true, analysis: null }, DEFAULT_AUTOMIX_SETTINGS), aExit: 16, bEntry: 2, duration: 4 };
  const state: NativeMixState = { active: true, playing: true, index: 0, position: 3, duration: 20,
    entryId: 'entry-a', queue: ['a', 'b'].map(trackId => ({ trackId, entryId: `entry-${trackId}`, origin: 'wave' as const })), blend: null,
    currentTrack: { trackId: 'a', entryId: 'entry-a', title: 'a', artist: '', totalFrames: 960000, gainDb: 0 },
    nextTrack: { trackId: 'b', entryId: 'entry-b', title: 'b', artist: '', totalFrames: 1440000, gainDb: 0,
      plan, transition: planToArmed(plan, 48000, 'A', 'B') } };
  Object.assign(bridge.nativeMix, { startStation: vi.fn(() => pending), startSource: vi.fn(async () => state),
    prepareQueue: vi.fn(async () => state), settings: vi.fn(async () => {}),
    state: vi.fn(async () => state), command: vi.fn(async () => state) });
  vi.stubGlobal('window', { automixDesktop: bridge });
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('document', { hidden: false, documentElement: { classList: { contains: () => false } } });
  const { PlayerController } = await import('../src/audio/controller.ts');
  const controller = new PlayerController(id => ({ id, title: id, duration: 20, status: 'ok', analysis: {} } as any), vi.fn());
  const h = controller as any;
  try {
    const starting = controller.startDesktopStation({ kind: 'yandex' });
    await vi.waitFor(() => expect(bridge.nativeMix.startStation).toHaveBeenCalledOnce());
    controller.onSettingsChanged(-16);
    if (outcome === 'error') {
      const failed = expect(starting).rejects.toThrow('station unavailable');
      reject(new Error('station unavailable')); await failed;
      expect(controller.state.error).toBe('station unavailable');
    } else {
      resolve(state); await starting;
      expect(controller.state).toMatchObject({ status: 'playing', position: 3, index: 0 });
      expect(controller.state.nextPlan).toEqual(plan);
      expect(controller.state.transition).toMatchObject({ active: false, startsIn: 13 });
      controller.seek(12);
      expect(bridge.nativeMix.command).toHaveBeenCalledWith('seekto', 12);
      expect(controller.state.position).toBe(12);
      h.onNativeState({ ...state, position: 13 });
      expect(controller.state.position).toBe(13);
      h.onNativeState({ ...state, index: 1, position: 2, duration: 30, entryId: 'entry-b', currentTrack: state.nextTrack, nextTrack: undefined });
      expect(controller.state).toMatchObject({ index: 1, position: 2, duration: 30, transition: null, nextPlan: null });
      await h.nativeSyncing;
    }
    expect(h.nativeStarting).toBe(false);
    expect(controller.state.waveLoading).toBe(false);
  } finally { clearInterval(h.nativeTimer); clearTimeout(h.saveTimer); }
});

it('keeps the confirmed track visible while rapid desktop starts select a later pending track', async () => {
  const pending: Array<(value: NativeMixState) => void> = [];
  const state = (id: string): NativeMixState => ({ active: true, playing: true, index: 0, position: 0, duration: 20,
    currentTrack: { trackId: id, entryId: `entry-${id}`, title: id, artist: '', totalFrames: 960000, gainDb: 0 } });
  Object.assign(bridge.nativeMix, { startSource: vi.fn(() => new Promise<NativeMixState>(resolve => pending.push(resolve))),
    prepareQueue: vi.fn(async () => state('c')), settings: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    state: vi.fn(async () => state('a')), command: vi.fn(async () => state('a')) });
  vi.stubGlobal('window', { automixDesktop: bridge });
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('document', { hidden: false, documentElement: { classList: { contains: () => false } } });
  const { PlayerController } = await import('../src/audio/controller.ts');
  const controller = new PlayerController(id => ({ id, title: id, duration: 20, status: 'ok', analysis: {} } as any), vi.fn());
  const h = controller as any;
  h.nativeAt = 0;
  controller.state = { ...controller.state, index: 0, status: 'playing', position: 8, duration: 20,
    queue: ['a', 'b', 'c'].map(id => ({ trackId: id, entryId: `entry-${id}`, origin: 'user' })) };
  const first = controller.startAt(1, 0);
  expect(controller.state).toMatchObject({ index: 0, position: 8, status: 'loading' });
  const second = controller.nextTrack();
  expect(bridge.nativeMix.startSource).toHaveBeenCalledTimes(2);
  pending[1](state('c')); await second;
  pending[0](state('b')); await first;
  expect(controller.state).toMatchObject({ index: 2, position: 0, status: 'playing' });
  clearInterval(h.nativeTimer); clearTimeout(h.saveTimer);
  vi.unstubAllGlobals();
});
