import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { NativeMixState, NativeQueueEntry, NativeSourceConfig } from '../src/lib/native-mix.ts';
import { PlayerController } from '../src/audio/controller.ts';
import { api } from '../src/lib/api.ts';

const bridge = vi.hoisted(() => ({ nativeMix: {
  startSource: vi.fn(), prepareQueue: vi.fn(), settings: vi.fn(), stop: vi.fn(), state: vi.fn(), command: vi.fn(), setStation: vi.fn(),
}, getSettings: vi.fn() }));
vi.mock('../src/lib/desktop.ts', () => ({ desktop: bridge }));
vi.mock('../src/audio/engine.worklet.ts?worker&url', () => ({ default: '/engine.js' }));
vi.mock('../src/lib/api.ts', () => ({ api: { queue: vi.fn(), focus: vi.fn(async () => {}), saveQueue: vi.fn(async () => {}),
  startPlay: vi.fn(async () => ({ id: 1 })), endPlay: vi.fn(async () => {}) }, ApiError: class extends Error {} }));

const entry = (trackId: string) => ({ trackId, entryId: `entry-${trackId}`, origin: 'user' as const });
const state = (current: NativeQueueEntry, patch: Partial<NativeMixState> = {}): NativeMixState => ({ active: true,
  playing: true, index: 0, position: 0, duration: 120, sampleRate: 48000, entryId: current.entryId,
  currentTrack: { ...current, title: current.trackId, artist: '', totalFrames: 120 * 48000, gainDb: 0 }, ...patch });
const controllers: PlayerController[] = [];
function controller() {
  const instance = new PlayerController(id => ({ id, title: id, duration: 120, status: 'ok', analysis: {} } as any), vi.fn());
  controllers.push(instance);
  return instance;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('window', { automixDesktop: bridge });
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('document', { hidden: false, documentElement: { classList: { contains: () => false } } });
  bridge.getSettings.mockResolvedValue({ audio: { outputDevice: 'Speakers', volume: .65, muted: true } });
  bridge.nativeMix.state.mockResolvedValue(state(entry('old')));
  bridge.nativeMix.startSource.mockImplementation(async (current: NativeQueueEntry, config: NativeSourceConfig) =>
    state(current, { position: config.position, playing: !config.paused }));
  bridge.nativeMix.prepareQueue.mockResolvedValue(state(entry('old')));
  bridge.nativeMix.settings.mockResolvedValue(undefined);
  bridge.nativeMix.stop.mockResolvedValue(undefined);
  bridge.nativeMix.command.mockResolvedValue(state(entry('old')));
  bridge.nativeMix.setStation.mockResolvedValue(undefined);
  vi.mocked(api.queue).mockResolvedValue({ items: [entry('old')], index: 0, position: 4,
    context: { type: 'library', label: 'Old library' }, repeat: 'off', shuffle: false, volume: .2 });
});

it('reattaches the saved online station when an older native checkpoint only restored its tracks', async () => {
  const current = entry('old'), context = { type: 'online-radio' as const, label: 'Онлайн-радио · Моя волна' };
  vi.mocked(api.queue).mockResolvedValue({ items: [current], index: 0, position: 4, context, repeat: 'off', shuffle: false });
  bridge.nativeMix.state.mockResolvedValue(state(current, { queue: [current], position: 4, context: null, station: null }));
  const player = controller();
  await player.restore();
  expect(bridge.nativeMix.setStation).toHaveBeenCalledWith({ kind: 'online' }, context);
  expect(bridge.nativeMix.startSource).not.toHaveBeenCalled();
  expect(bridge.nativeMix.prepareQueue).not.toHaveBeenCalled();
});
afterEach(() => {
  for (const instance of controllers.splice(0)) {
    const timers = instance as any;
    clearInterval(timers.nativeTimer); clearTimeout(timers.saveTimer); clearTimeout(timers.waveRetryTimer);
  }
  vi.unstubAllGlobals();
});

it('adopts a preparing native recovery with its full unique queue, context, repeat and audible position', async () => {
  const a = entry('a'), b = entry('b'), c = entry('c');
  const context = { type: 'playlist' as const, id: 'playlist', label: 'Recovered playlist' };
  bridge.nativeMix.state.mockResolvedValue(state(b, { index: 3, position: 37, preparing: true,
    queue: [a, b, a, b, c], context, repeat: 'all' }));
  const player = controller();
  await player.restore();
  expect(player.state).toMatchObject({ queue: [a, b, c], index: 1, position: 37, duration: 120,
    status: 'playing', context, repeat: 'all', volume: .65, muted: true });
  expect((player as any).nativeTimer).toBeTruthy();
  expect(bridge.nativeMix.startSource).not.toHaveBeenCalled();
  expect(bridge.nativeMix.prepareQueue).not.toHaveBeenCalled();
});

it('hydrates the raw slider, mute, output device and sound settings before the first desktop Play', async () => {
  const tone = { enabled: true, gains: [1, 0, 0, 0, 0, 0, 0, 0, 0, -1], preampDb: -2,
    autoHeadroom: true, balance: .1, mono: false, reverbMix: .1 };
  const playback = { speed: .9, semitones: 2 };
  bridge.getSettings.mockResolvedValue({ audio: { outputDevice: 'Headphones', volume: .65, muted: true, tone, playback } });
  const player = controller();
  await player.playTracks(['new'], 0, { type: 'album', label: 'New album' });
  await (player as any).nativeSyncing;
  expect(player.state).toMatchObject({ volume: .65, muted: true });
  expect(player.outputDevice).toBe('Headphones');
  expect(bridge.nativeMix.startSource).toHaveBeenCalledOnce();
  expect(bridge.nativeMix.startSource.mock.calls[0][1]).toMatchObject({ volume: 0, userVolume: .65, muted: true, tone, playback });
});

it('does not overwrite a new Play when an older recovery is waiting for desktop settings', async () => {
  let finish!: (value: unknown) => void;
  bridge.getSettings.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  bridge.getSettings.mockResolvedValue({ audio: { outputDevice: 'Headphones', volume: .55, muted: false } });
  vi.mocked(api.queue).mockResolvedValue({ items: [entry('old')], index: 0, position: 77,
    context: null, repeat: 'all', shuffle: false, originalOrder: [entry('old')] });
  const player = controller();
  const restoring = player.restore();
  await vi.waitFor(() => expect(bridge.getSettings).toHaveBeenCalledOnce());
  await player.playTracks(['new'], 0, { type: 'album', label: 'User choice' });
  await (player as any).nativeSyncing;
  finish({ audio: { outputDevice: 'Old speakers', volume: .1, muted: true } });
  await restoring;
  expect(player.state).toMatchObject({ index: 0, position: 0, status: 'playing', repeat: 'off',
    context: { type: 'album', label: 'User choice' }, volume: .55, muted: false });
  expect(player.state.queue.map(e => e.trackId)).toEqual(['new']);
  expect((player as any).restoredPosition).toBe(0);
  expect((player as any).originalOrder).toBeNull();
});
