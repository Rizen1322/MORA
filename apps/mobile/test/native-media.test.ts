import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { setupNative } from '../src/bridge/native.ts';

const native = vi.hoisted(() => ({
  setRemoteNavigation: vi.fn(async (_state: any) => {}),
  setNowPlaying: vi.fn(async (_info: any) => {}), setPlaybackState: vi.fn(async (_state: any) => {}),
  clear: vi.fn(async () => {}), power: vi.fn(async () => ({ thermal: 0, lowPower: false })),
  addListener: vi.fn(async (_event: string, _fn: any) => ({ remove: async () => {} })),
  diagnosticsInfo: vi.fn(async () => ({ enabled: false })),
  diagnosticsRecord: vi.fn(async (_event: any) => {}),
  nativeProbeStart: vi.fn(async () => ({ active: true, playing: true, index: 0, position: 0, duration: 90 })),
  nativeProbeStop: vi.fn(async () => {}),
  nativeProbeState: vi.fn(async () => ({ active: false, playing: false, index: 0, position: 0, duration: 0 })),
  nativeProbeCommand: vi.fn(async (_o: any) => ({ active: true, playing: false, index: 0, position: 60, duration: 90 })),
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
  it('isolates native playback from WebKit metadata, commands and the normal controller', async () => {
    const originalPosition = ms.setPositionState, originalActions = ms.setActionHandler;
    setupNative(emptyFetch, () => {});
    const controls = window.moraNativePlayback!;
    controls.contextState = 'running';
    controls.suspend = async () => { controls.contextState = 'suspended'; update({ status: 'paused', position: 12 }); };
    const next = vi.fn(); ms.setActionHandler('nexttrack', next);
    const oldNext = originalActions.mock.calls.at(-1)![1];
    ms.metadata = new Metadata({ title: 'Before test' });
    update({ status: 'playing', position: 12 });
    ms.setPositionState({ duration: 180, position: 12 });
    await controls.probe!.start();
    expect(controls.probeActive).toBe(true);
    expect(controls.contextState).toBe('suspended');
    expect(ms.published).toBeNull();
    originalPosition.mockClear();
    ms.metadata = new Metadata({ title: 'Cached while native plays' });
    ms.setPositionState({ duration: 180, position: 16 });
    update({ status: 'playing', position: 16 });
    oldNext({ action: 'nexttrack' });
    expect(next).not.toHaveBeenCalled();
    expect(originalPosition).not.toHaveBeenCalled();
    expect(ms.published).toBeNull();
    await expect(controls.setRoute('native')).rejects.toThrow('Stop native');
    await controls.probe!.stop();
    expect(controls.probeActive).toBe(false);
    expect(ms.published?.title).toBe('Cached while native plays');
    expect(ms.playbackState).toBe('paused');
  });
  it('defaults to real WebKit navigation handlers and changes routes without duplicate delivery', async () => {
    const webkit = ms.setActionHandler;
    setupNative(emptyFetch, () => {});
    const next = vi.fn();
    ms.setActionHandler('nexttrack', next);
    expect(webkit).toHaveBeenLastCalledWith('nexttrack', expect.any(Function));
    const oldWebKitCallback = webkit.mock.calls.at(-1)![1];
    const controls = window.moraNativePlayback!;
    await controls.setRoute('native');
    expect(webkit).toHaveBeenLastCalledWith('nexttrack', null);
    expect(native.setRemoteNavigation).toHaveBeenLastCalledWith(expect.objectContaining({ route: 'native', actions: ['nexttrack'] }));
    const command = native.addListener.mock.calls.find(([ev]) => ev === 'command')![1];
    command({ action: 'nexttrack', source: 'remote' });
    expect(next).toHaveBeenCalledTimes(1);
    oldWebKitCallback({ action: 'nexttrack' });
    expect(next).toHaveBeenCalledTimes(1);
    await controls.setRoute('webkit');
    command({ action: 'nexttrack', source: 'remote' }); // Late event from the old route.
    expect(next).toHaveBeenCalledTimes(1);
    webkit.mock.calls.at(-1)![1]({ action: 'nexttrack' });
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('freezes system time on a context pause and restores it without changing user intent or sending rate zero', () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const position = ms.setPositionState;
    setupNative(emptyFetch, () => {});
    update({ status: 'playing', position: 75 });
    ms.setPositionState({ duration: 180, position: 75, playbackRate: 1 });
    const controls = window.moraNativePlayback!;
    controls.snapshot = () => ({ position: 75, status: 'playing', context: controls.contextState });
    controls.contextState = 'suspended';
    window.dispatchEvent(new Event('mora-context-state'));
    expect(ms.playbackState).toBe('paused');
    expect(native.setPlaybackState).toHaveBeenLastCalledWith({ playing: false, intentPlaying: true, webAudioSession: true });
    clock.mockReturnValue(16000);
    controls.contextState = 'running';
    window.dispatchEvent(new Event('mora-context-state'));
    expect(ms.playbackState).toBe('playing');
    expect(position).toHaveBeenLastCalledWith({ duration: 180, position: 75, playbackRate: 1 });
    expect(position.mock.calls.every(([p]) => !p || p.playbackRate !== 0)).toBe(true);
  });

  it('records failed position publications without claiming the seek state was accepted', async () => {
    native.diagnosticsInfo.mockResolvedValue({ enabled: true });
    ms.setPositionState.mockImplementationOnce(() => { throw new TypeError('private error'); });
    setupNative(emptyFetch, () => {});
    await Promise.resolve();
    ms.setPositionState({ duration: 180, position: 12, playbackRate: 1 });
    expect(native.diagnosticsRecord).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'js.media.publish', fields: expect.objectContaining({ kind: 'position', duration: 180, position: 12, rate: 1, outcome: 'rejected' }),
    }));
  });
  it('correlates a native event with JS execution and handler resolution', async () => {
    native.diagnosticsInfo.mockResolvedValue({ enabled: true });
    setupNative(emptyFetch, () => {});
    await Promise.resolve();
    let seen: string | undefined;
    const pause = vi.fn(() => { seen = window.moraDiagnostics?.currentId; return Promise.resolve(); });
    ms.setActionHandler('pause', pause);
    const command = native.addListener.mock.calls.find(([event]) => event === 'command')![1];
    command({ action: 'pause', id: 'native-1', source: 'test' });
    await Promise.resolve();
    expect(seen).toBe('native-1');
    expect(window.moraDiagnostics?.currentId).toBeUndefined();
    expect(native.diagnosticsRecord.mock.calls.map(([e]) => e)).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'js.command.received', fields: expect.objectContaining({ id: 'native-1', source: 'test' }) }),
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
    await window.moraNativePlayback!.setRoute('native');
    expect(native.setRemoteNavigation).toHaveBeenLastCalledWith({
      actions: ['nexttrack', 'previoustrack', 'seekto'], seekable: false, route: 'native', epoch: 1,
    });
    const command = native.addListener.mock.calls.find(([event]) => event === 'command')![1];
    for (const action of ['nexttrack', 'previoustrack', 'seekto'] as const) {
      expect(webkitActions.mock.calls.filter(([name]) => name === action).at(-1)![1]).toBeNull();
      command({ action, seekTime: 60 });
    }
    expect(next).toHaveBeenCalledOnce();
    expect(previous).toHaveBeenCalledOnce();
    expect(seek).toHaveBeenCalledExactlyOnceWith({ action: 'seekto', seekTime: 60 });
    // A genuine native interruption still reaches the controller's Pause handler.
    command({ action: 'pause' });
    expect(pause).toHaveBeenCalledOnce();
  });

  it('enables native scrubbing only with a duration and removes cleared actions', async () => {
    setupNative(emptyFetch, () => {});
    const seek = vi.fn();
    ms.setActionHandler('seekto', seek);
    await window.moraNativePlayback!.setRoute('native');
    expect(native.setRemoteNavigation).toHaveBeenLastCalledWith({ actions: ['seekto'], seekable: false, route: 'native', epoch: 1 });
    ms.setPositionState({ duration: 180, position: 10 });
    expect(native.setRemoteNavigation).toHaveBeenLastCalledWith({ actions: ['seekto'], seekable: true, route: 'native', epoch: 1 });
    ms.setActionHandler('seekto', null);
    expect(native.setRemoteNavigation).toHaveBeenLastCalledWith({ actions: [], seekable: true, route: 'native', epoch: 1 });
    const command = native.addListener.mock.calls.find(([event]) => event === 'command')![1];
    command({ action: 'seekto', seekTime: 60 });
    expect(seek).not.toHaveBeenCalled();
    ms.metadata = null;
    expect(native.setRemoteNavigation).toHaveBeenLastCalledWith({ actions: [], seekable: false, route: 'native', epoch: 1 });
  });

  it('falls back to WebKit registration when the installed native shell predates navigation', async () => {
    const webkitActions = ms.setActionHandler;
    setupNative(emptyFetch, () => {});
    const next = vi.fn();
    ms.setActionHandler('nexttrack', next);
    native.setRemoteNavigation.mockRejectedValueOnce(new Error('not implemented'));
    await expect(window.moraNativePlayback!.setRoute('native')).rejects.toThrow('unavailable');
    expect(window.moraNativePlayback!.route).toBe('webkit');
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
    expect(native.setPlaybackState).toHaveBeenLastCalledWith({ playing: true, intentPlaying: true, webAudioSession: true });
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
