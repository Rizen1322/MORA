import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { setupNative } from '../src/bridge/native.ts';

const native = vi.hoisted(() => ({
  setRemoteNavigation: vi.fn(async (_state: any) => {}),
  setNowPlaying: vi.fn(async (_info: any) => {}), setPlaybackState: vi.fn(async (_state: any) => {}),
  clear: vi.fn(async () => {}), power: vi.fn(async () => ({ thermal: 0, lowPower: false })),
  addListener: vi.fn(async (_event: string, _fn: any) => ({ remove: async () => {} })),
  diagnosticsInfo: vi.fn(async () => ({ enabled: false })),
  diagnosticsRecord: vi.fn(async (_event: any) => {}),
}));
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true }, CapacitorHttp: {}, registerPlugin: () => native,
}));

class Metadata {
  title = ''; artist = ''; album = ''; artwork: { src: string }[] = [];
  constructor(info: any) { Object.assign(this, info); }
}
class Session {
  published: Metadata | null = null;
  publications = 0;
  playbackState = 'none';
  get metadata() { return this.published; }
  set metadata(value) { this.published = value; this.publications++; }
  setActionHandler = vi.fn((_action: string, _handler: any) => {});
  setPositionState = vi.fn();
}
let ms: Session;
let update: (s: { status: string; position: number }) => void;
const emptyFetch = async () => new Response(null, { status: 404 });

beforeEach(() => {
  vi.clearAllMocks();
  native.diagnosticsInfo.mockResolvedValue({ enabled: false });
  ms = new Session();
  const page = Object.assign(new EventTarget(), { automix: { subscribe(fn: typeof update) { update = fn; } } });
  vi.stubGlobal('window', page);
  vi.stubGlobal('document', { documentElement: { dataset: {} } });
  vi.stubGlobal('location', { href: 'http://localhost/', origin: 'http://localhost' });
  vi.stubGlobal('navigator', { mediaSession: ms, audioSession: { type: 'playback' } });
  vi.stubGlobal('MediaMetadata', Metadata);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('iPhone Now Playing bridge', () => {
  it('correlates a native event with JS execution and handler resolution', async () => {
    native.diagnosticsInfo.mockResolvedValue({ enabled: true });
    setupNative(emptyFetch, () => {});
    await Promise.resolve();
    let seen: string | undefined;
    const pause = vi.fn(() => { seen = window.moraDiagnostics?.currentId; return Promise.resolve(); });
    ms.setActionHandler('pause', pause);
    const command = native.addListener.mock.calls.find(([event]) => event === 'command')![1];
    command({ action: 'pause', id: 'native-1', source: 'remote' });
    await Promise.resolve();
    expect(seen).toBe('native-1');
    expect(window.moraDiagnostics?.currentId).toBeUndefined();
    expect(native.diagnosticsRecord.mock.calls.map(([e]) => e)).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'js.command.received', fields: expect.objectContaining({ id: 'native-1', source: 'remote' }) }),
      expect.objectContaining({ stage: 'js.handler.resolved', fields: expect.objectContaining({ id: 'native-1', action: 'pause' }) }),
    ]));
    command({ action: 'seekto', id: 'native-2' });
    expect(native.diagnosticsRecord).toHaveBeenLastCalledWith(expect.objectContaining({ stage: 'js.command.missingHandler' }));
  });

  it('records WebKit play/pause callbacks without adding native play/pause handlers', async () => {
    native.diagnosticsInfo.mockResolvedValue({ enabled: true });
    const webkitActions = ms.setActionHandler;
    setupNative(emptyFetch, () => {});
    await Promise.resolve();
    const pause = vi.fn();
    ms.setActionHandler('pause', pause);
    webkitActions.mock.calls.at(-1)![1]({ action: 'pause' });
    expect(pause).toHaveBeenCalledOnce();
    expect(native.diagnosticsRecord).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'js.command.received', fields: expect.objectContaining({ action: 'pause', source: 'webkit' }),
    }));
  });
  it('routes lock-screen navigation through native commands, not AudioContext remote handlers', async () => {
    const webkitActions = ms.setActionHandler;
    setupNative(emptyFetch, () => {});
    const next = vi.fn(), previous = vi.fn(), seek = vi.fn(), pause = vi.fn();
    ms.setActionHandler('nexttrack', next);
    ms.setActionHandler('previoustrack', previous);
    ms.setActionHandler('seekto', seek);
    ms.setActionHandler('pause', pause);
    expect(webkitActions).toHaveBeenCalledTimes(4);
    expect(native.setRemoteNavigation).toHaveBeenLastCalledWith({
      actions: ['nexttrack', 'previoustrack', 'seekto'], seekable: false,
    });
    const command = native.addListener.mock.calls.find(([event]) => event === 'command')![1];
    for (const action of ['nexttrack', 'previoustrack', 'seekto'] as const) {
      expect(webkitActions.mock.calls.find(([name]) => name === action)![1]).toBeNull();
      command({ action, seekTime: 60 });
    }
    expect(next).toHaveBeenCalledOnce();
    expect(previous).toHaveBeenCalledOnce();
    expect(seek).toHaveBeenCalledExactlyOnceWith({ action: 'seekto', seekTime: 60 });
    // A genuine native interruption still reaches the controller's Pause handler.
    command({ action: 'pause' });
    expect(pause).toHaveBeenCalledOnce();
  });

  it('enables native scrubbing only with a duration and removes cleared actions', () => {
    setupNative(emptyFetch, () => {});
    const seek = vi.fn();
    ms.setActionHandler('seekto', seek);
    expect(native.setRemoteNavigation).toHaveBeenLastCalledWith({ actions: ['seekto'], seekable: false });
    ms.setPositionState({ duration: 180, position: 10 });
    expect(native.setRemoteNavigation).toHaveBeenLastCalledWith({ actions: ['seekto'], seekable: true });
    ms.setActionHandler('seekto', null);
    expect(native.setRemoteNavigation).toHaveBeenLastCalledWith({ actions: [], seekable: true });
    const command = native.addListener.mock.calls.find(([event]) => event === 'command')![1];
    command({ action: 'seekto', seekTime: 60 });
    expect(seek).not.toHaveBeenCalled();
    ms.metadata = null;
    expect(native.setRemoteNavigation).toHaveBeenLastCalledWith({ actions: [], seekable: false });
  });

  it('falls back to WebKit registration when the installed native shell predates navigation', async () => {
    native.setRemoteNavigation.mockRejectedValueOnce(new Error('not implemented'));
    const webkitActions = ms.setActionHandler;
    setupNative(emptyFetch, () => {});
    const next = vi.fn();
    ms.setActionHandler('nexttrack', next);
    await Promise.resolve();
    expect(webkitActions).toHaveBeenLastCalledWith('nexttrack', expect.any(Function));
    webkitActions.mock.calls.at(-1)![1]({ action: 'nexttrack' });
    expect(next).toHaveBeenCalledOnce();
    ms.setActionHandler('nexttrack', null);
    expect(webkitActions).toHaveBeenLastCalledWith('nexttrack', null);
  });

  it('keeps one Now Playing publisher and ignores duplicate metadata ticks', async () => {
    setupNative(emptyFetch, () => {});
    const meta = new Metadata({ title: 'Track', artist: 'Artist' });
    ms.metadata = meta;
    expect(ms.published).toBe(meta);
    ms.metadata = new Metadata({ title: 'Track', artist: 'Artist' });
    expect(ms.publications).toBe(1);
    update({ status: 'playing', position: 0 });
    expect(ms.playbackState).toBe('playing');
    expect(native.setPlaybackState).toHaveBeenLastCalledWith({ playing: true, webAudioSession: true });
    expect(native.setNowPlaying).not.toHaveBeenCalled();
  });

  it('resynchronizes a minute of progress and an immediate seek without flooding either bridge', () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const webkitPosition = ms.setPositionState;
    setupNative(emptyFetch, () => {});
    update({ status: 'playing', position: 0 });
    for (let t = 0; t <= 60_000; t += 50) {
      clock.mockReturnValue(t);
      ms.setPositionState({ duration: 180, position: t / 1000, playbackRate: 1 });
    }
    expect(webkitPosition).toHaveBeenLastCalledWith({ duration: 180, position: 60, playbackRate: 1 });
    expect(webkitPosition.mock.calls.length).toBeLessThanOrEqual(32);
    ms.setPositionState({ duration: 180, position: 90, playbackRate: 1 });
    expect(webkitPosition).toHaveBeenLastCalledWith({ duration: 180, position: 90, playbackRate: 1 });
    update({ status: 'buffering', position: 90 });
    expect(ms.playbackState).toBe('paused');
    expect(native.setPlaybackState).toHaveBeenCalledTimes(2);
  });

  it('reapplies the current clock after late artwork, without publishing a second native player', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const webkitPosition = ms.setPositionState;
    let finish!: (r: Response) => void;
    setupNative(() => new Promise((resolve) => { finish = resolve; }), () => {});
    ms.metadata = new Metadata({ title: 'Track', artwork: [{ src: '/api/covers/a' }] });
    update({ status: 'playing', position: 5 });
    ms.setPositionState({ duration: 120, position: 5, playbackRate: 1 });
    clock.mockReturnValue(6000);
    finish(new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }));
    await vi.waitFor(() => expect(ms.publications).toBe(2));
    expect(webkitPosition).toHaveBeenLastCalledWith({ duration: 120, position: 10, playbackRate: 1 });
    expect(ms.published?.artwork[0].src).toBe('data:image/png;base64,AQID');
    expect(native.setNowPlaying).not.toHaveBeenCalled();
  });

  it('ignores an old cover after skipping and clears WebKit metadata and position', async () => {
    const webkitPosition = ms.setPositionState;
    let finish!: (r: Response) => void;
    setupNative(() => new Promise((resolve) => { finish = resolve; }), () => {});
    ms.metadata = new Metadata({ title: 'Old', artwork: [{ src: '/api/covers/old' }] });
    ms.metadata = new Metadata({ title: 'New' });
    finish(new Response(new Uint8Array([1])));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ms.publications).toBe(2);
    expect(ms.published?.title).toBe('New');
    ms.metadata = null;
    expect(ms.published).toBeNull();
    expect(webkitPosition).toHaveBeenLastCalledWith();
    expect(native.clear).not.toHaveBeenCalled();
  });

  it('cuts optional graphics and work from fair thermal state, and restores after cooling', async () => {
    const onPower = vi.fn();
    setupNative(emptyFetch, onPower);
    await Promise.resolve();
    const power = native.addListener.mock.calls.find(([event]) => event === 'power')![1];
    power({ thermal: 1, lowPower: false });
    expect(document.documentElement.dataset.power).toBe('saver');
    expect(onPower).toHaveBeenLastCalledWith(true);
    power({ thermal: 0, lowPower: false });
    expect(document.documentElement.dataset.power).toBeUndefined();
    power({ thermal: 0, lowPower: true });
    expect(onPower).toHaveBeenLastCalledWith(true);
  });
});
