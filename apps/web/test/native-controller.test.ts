import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_AUTOMIX_SETTINGS, planTransition } from '@automix/core';
import { PlayerController } from '../src/audio/controller.ts';
import { api, type Track } from '../src/lib/api.ts';
import type { NativeMix, NativeMixState } from '../src/lib/native-mix.ts';

vi.mock('../src/audio/engine.worklet.ts?worker&url', () => ({ default: '/engine.js' }));
vi.mock('../src/lib/api.ts', async (original) => {
  const actual = await original<typeof import('../src/lib/api.ts')>();
  return { ...actual, api: { plan: vi.fn(), prepare: vi.fn(), focus: vi.fn(), saveQueue: vi.fn(), startPlay: vi.fn(), endPlay: vi.fn(), waveNext: vi.fn(), yandexFeedback: vi.fn() } };
});

const seconds = 20, frames = seconds * 48000;
const state = (patch: Partial<NativeMixState> = {}): NativeMixState => ({ active: true, playing: true, index: 0, position: 0, duration: seconds, ...patch });
let timer: (() => void) | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.plan).mockImplementation(async (from, to) => ({ cached: false, pending: [], plan: planTransition(
    { id: from, duration: seconds, mixingAllowed: true, analysis: null }, { id: to, duration: seconds, mixingAllowed: true, analysis: null }, DEFAULT_AUTOMIX_SETTINGS) }));
  vi.mocked(api.prepare).mockResolvedValue({ totalFrames: frames, complete: true, analysis: 'done' });
  vi.mocked(api.focus).mockResolvedValue(undefined);
  vi.mocked(api.saveQueue).mockResolvedValue(undefined);
  vi.mocked(api.startPlay).mockResolvedValue({ id: 1 });
  vi.mocked(api.endPlay).mockResolvedValue(undefined);
  // Each request returns the next 32768 frames of a decoded track.
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const start = Number(new URL(url, 'http://x').searchParams.get('start'));
    const count = Math.min(32768, frames - start);
    return { ok: true, headers: new Headers({ 'X-PCM-Format': 'f32le', 'X-Complete': '1', 'X-Total-Frames': String(frames) }),
      arrayBuffer: async () => new ArrayBuffer(count * 8) };
  }));
  vi.stubGlobal('document', { hidden: false, addEventListener: vi.fn() });
  vi.stubGlobal('navigator', {});
});
afterEach(() => { timer?.(); vi.unstubAllGlobals(); });

it('plays the queue natively: uploads tracks with their blends ahead and follows the audible track', async () => {
  const mix = { upload: vi.fn(async () => {}), start: vi.fn(async () => state()), update: vi.fn(async () => state()),
    stop: vi.fn(), state: vi.fn(async () => state()), command: vi.fn(async () => state()) } satisfies NativeMix;
  vi.stubGlobal('window', { moraNativePlayback: { route: 'webkit', mix } });
  const tracks = new Map(['a', 'b', 'c', 'd'].map((id) => [id, { id, title: id, artist: '', duration: seconds, status: 'ok', analysis: {} } as Track]));
  const controller = new PlayerController((id) => tracks.get(id), vi.fn());
  const h = controller as unknown as { nativeSyncing: Promise<void> | null; nativeTimer: ReturnType<typeof setInterval>; onNativeState(s: NativeMixState): void; saveTimer: ReturnType<typeof setTimeout> | null };
  timer = () => { clearInterval(h.nativeTimer); if (h.saveTimer) clearTimeout(h.saveTimer); };

  await controller.playTracks(['a', 'b', 'c', 'd'], 0, { type: 'queue', label: 'Очередь' });
  expect(mix.start).toHaveBeenCalledOnce();
  expect(mix.start.mock.calls[0][0]).toMatchObject({ index: 0, position: 0, tracks: [{ title: 'a', totalFrames: frames }] });
  expect(controller.state.status).toBe('playing');
  await h.nativeSyncing;
  // Two tracks ahead, each with the planned blend from its predecessor.
  expect(mix.update.mock.calls.map(([from, added]) => [from, added.map(t => t.title)])).toEqual([[1, ['b']], [2, ['c']]]);
  expect(mix.update.mock.calls[0][1][0].transition).toMatchObject({ fromToken: 'A', toToken: 'B' });

  const entries = controller.state.queue;
  h.onNativeState(state({ index: 1, position: 2, entryId: entries[1].entryId }));
  expect(controller.state.index).toBe(1);
  expect(api.endPlay).toHaveBeenCalledWith(1, expect.any(Number), 'transition', undefined);
  await h.nativeSyncing;
  expect(mix.update.mock.calls.at(-1)?.[0]).toBe(3);
  expect(mix.update.mock.calls.at(-1)?.[1].map(t => t.title)).toEqual(['d']);

  await controller.nextTrack();
  expect(mix.command).toHaveBeenCalledWith('nexttrack', undefined);
  controller.pause();
  expect(mix.command).toHaveBeenLastCalledWith('pause', undefined);
  expect(controller.state.status).toBe('paused');
});
