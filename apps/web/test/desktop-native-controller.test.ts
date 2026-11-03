import { expect, it, vi } from 'vitest';
import type { NativeMixState } from '../src/lib/native-mix.ts';

const bridge = vi.hoisted(() => ({ nativeMix: {} as Record<string, unknown> }));
vi.mock('../src/lib/desktop.ts', () => ({ desktop: bridge }));
vi.mock('../src/audio/engine.worklet.ts?worker&url', () => ({ default: '/engine.js' }));
vi.mock('../src/lib/api.ts', () => ({ api: { focus: vi.fn(async () => {}), saveQueue: vi.fn(async () => {}),
  startPlay: vi.fn(async () => ({ id: 1 })), endPlay: vi.fn(async () => {}) }, ApiError: class extends Error {} }));

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
