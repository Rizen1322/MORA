import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHUNK_FRAMES, DEFAULT_AUTOMIX_SETTINGS, planRequestedTransition, planTransition, type MixerEvent } from '@automix/core';
import { PlayerController, gainFromSummary, type QueueEntry } from '../src/audio/controller.ts';
import { api, type Track } from '../src/lib/api.ts';

vi.mock('../src/audio/engine.worklet.ts?worker&url', () => ({ default: '/engine.js' }));
vi.mock('../src/lib/api.ts', async (original) => {
  const actual = await original<typeof import('../src/lib/api.ts')>();
  return { ...actual, api: { plan: vi.fn(), mixNow: vi.fn(), prepare: vi.fn(), focus: vi.fn(), saveQueue: vi.fn(), startPlay: vi.fn(), endPlay: vi.fn(), logTransition: vi.fn(), rateTransition: vi.fn(), queue: vi.fn(), yandexWave: vi.fn(), waveNext: vi.fn(), yandexFeedback: vi.fn() } };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

// Seed a running worklet transport; the tests exercise HTTP/queue races without
// depending on real audio hardware. DSP execution is covered by core engine tests.
function setup() {
  const tracks = new Map(['a', 'b', 'c'].map((id) => [id, { id, title: id, duration: 180, status: 'ok', analysis: {} } as Track]));
  const controller = new PlayerController((id) => tracks.get(id), vi.fn());
  const postMessage = vi.fn();
  const slot = { deck: 0, token: 'a-token', entryId: 'a-entry', trackId: 'a', totalFrames: 180 * 48000,
    abort: new AbortController(), pending: [] as number[], inflight: 0, fed: new Set([0]), fetching: new Set<number>(), failed: null,
    vocals: { pending: [] as number[], inflight: 0, fed: new Set<number>(), fetching: new Set<number>(), failed: null as string | null } };
  const queue: QueueEntry[] = ['a', 'b', 'c'].map((id) => ({ entryId: `${id}-entry`, trackId: id, origin: 'user' }));
  // Deliberately use a narrow test harness for private transport collaborators.
  const h = controller as unknown as {
    current: typeof slot; slots: (typeof slot | null)[]; node: { port: { postMessage: typeof postMessage } };
    next: { slot: typeof slot; entry: QueueEntry; plan: ReturnType<typeof planTransition>; pending: string[] } | null;
    prepareNext(): Promise<void>; onNeed(deck: number, token: string, chunks: number[]): void;
    ensureEngine(): Promise<void>;
    onEngine(event: MixerEvent): void;
    onSlotFailed(slot: typeof slot, message: string): void;
    advanceAfterFailure(): Promise<void>;
    maxPos: number;
    saveTimer: ReturnType<typeof setTimeout> | null;
  };
  h.node = { port: { postMessage } };
  h.current = slot;
  h.slots = [slot, null];
  controller.state = { ...controller.state, queue, index: 0, context: { type: 'queue', label: 'Очередь' }, status: 'playing' };
  return { controller, h, postMessage, slot, tracks };
}

const pair = (to: string, from = 'a') => ({ plan: planTransition(
  { id: from, duration: 180, mixingAllowed: true, analysis: null },
  { id: to, duration: 180, mixingAllowed: true, analysis: null }, DEFAULT_AUTOMIX_SETTINGS), cached: false, pending: [] });
const requested = (to: string, position: number, from = 'a') => ({ plan: planRequestedTransition(
  { id: from, duration: 180, mixingAllowed: true, analysis: null },
  { id: to, duration: 180, mixingAllowed: true, analysis: null }, position, DEFAULT_AUTOMIX_SETTINGS) });

const cleanups: (() => void)[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.plan).mockImplementation(async (from, to) => pair(to, from));
  vi.mocked(api.mixNow).mockImplementation(async (from, to, position) => requested(to, position, from));
  vi.mocked(api.prepare).mockResolvedValue({ totalFrames: 180 * 48000, complete: true, analysis: 'done' });
  vi.mocked(api.focus).mockResolvedValue(undefined);
  vi.mocked(api.saveQueue).mockResolvedValue(undefined);
  vi.mocked(api.startPlay).mockResolvedValue({ id: 1 });
  vi.mocked(api.endPlay).mockResolvedValue(undefined);
  vi.mocked(api.logTransition).mockResolvedValue({ id: 7 });
  vi.mocked(api.rateTransition).mockResolvedValue(undefined);
  vi.mocked(api.yandexFeedback).mockResolvedValue(undefined);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(CHUNK_FRAMES * 8 * 4) }));
  vi.stubGlobal('navigator', {});
});
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.unstubAllGlobals(); });

describe('playback preparation and queue changes', () => {
  it('bounds vocal lookahead to two distinct future tracks and follows repeat order',()=>{
    const {controller}=setup();
    const focus=controller as unknown as {focusAnalysis():void};
    focus.focusAnalysis();expect(api.focus).toHaveBeenLastCalledWith({current:'a',next:['b'],candidates:['c']});
    controller.state={...controller.state,index:2,repeat:'all'};
    focus.focusAnalysis();expect(api.focus).toHaveBeenLastCalledWith({current:'c',next:['a'],candidates:['b']});
    controller.state={...controller.state,index:0,repeat:'one'};
    focus.focusAnalysis();expect(api.focus).toHaveBeenLastCalledWith({current:'a',next:['a'],candidates:[]});
  });
  it('waits for online-radio refill after an emptied reserve and starts it without restarting the station', () => {
    const { controller, h, slot } = setup();
    controller.state = { ...controller.state, context: { type: 'online-radio', label: 'Радио' }, queue: controller.state.queue.slice(0, 1) };
    const start = vi.spyOn(controller, 'startAt').mockResolvedValue(undefined);
    cleanups.push(() => { if (h.saveTimer) clearTimeout(h.saveTimer); });
    h.onEngine({ type: 'ended', deck: 0, token: slot.token });
    expect(controller.state.status).toBe('buffering');
    controller.addToQueue(['b']);
    expect(start).toHaveBeenCalledWith(1, 0, 'finished');
    expect(api.yandexWave).not.toHaveBeenCalled(); expect(api.waveNext).not.toHaveBeenCalled();
  });
  it('keeps provisional headroom for a streamed master until measured loudness arrives', () => {
    expect(gainFromSummary(undefined, -16)).toBe(-6);
    expect(gainFromSummary({ status: 'pending' }, -16)).toBe(-6);
    expect(gainFromSummary(undefined, null)).toBe(0);
    expect(gainFromSummary({ status:'done', lufs:-8.9, truePeak:1.8 }, -16)).toBeCloseTo(-7.1);
  });
  it('updates measured current-track gain even without a prepared next deck', () => {
    const { controller, h, postMessage, tracks } = setup();
    controller.setLoudnessTarget(-16);
    tracks.get('a')!.analysis={status:'done',lufs:-8.9,truePeak:1.8}; h.next=null;
    controller.onAnalysisDone('a');
    expect(postMessage).toHaveBeenCalledWith({cmd:'gain',deck:0,gainDb:-7.1}, []);
    expect(api.plan).not.toHaveBeenCalled();
  });
  it('stops preparing after three next tracks fail in a row and reports it once', async () => {
    const { controller, h } = setup();
    const notify = (controller as unknown as { notify: ReturnType<typeof vi.fn> }).notify;
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    controller.state = { ...controller.state, queue: ids.map((id) => ({ entryId: `${id}-entry`, trackId: id, origin: 'user' })) };
    const load = vi.spyOn(h as typeof h & { loadSlot(): Promise<never> }, 'loadSlot').mockRejectedValue(new Error('bie.Readable.from is not a function'));
    await h.prepareNext();
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(3));
    await new Promise((r) => setTimeout(r, 20));
    expect(load).toHaveBeenCalledTimes(3);
    expect(controller.state.queue.map((e) => e.trackId)).toEqual(['a', 'e', 'f']);
    expect(notify.mock.calls.map(([msg]) => msg)).toEqual([
      'Пропущен следующий трек: bie.Readable.from is not a function',
      'Подряд не загрузились 3 следующих трека, подготовка остановлена: bie.Readable.from is not a function',
    ]);
    await h.prepareNext();
    expect(load).toHaveBeenCalledTimes(3);
  });
  it('does not let background preparation replace the deck of an unfinished manual load', async () => {
    const { controller, h, slot } = setup();
    const transport = h as typeof h & { loadSlot(): Promise<typeof h.current>; waitFed(): Promise<void> };
    const loading = deferred<typeof slot>();
    vi.spyOn(h, 'ensureEngine').mockResolvedValue(undefined);
    vi.spyOn(transport, 'loadSlot').mockReturnValue(loading.promise);
    vi.spyOn(transport, 'waitFed').mockResolvedValue(undefined);
    cleanups.push(() => { if (h.saveTimer) clearTimeout(h.saveTimer); });
    const starting = controller.startAt(1, 0, 'skip', true);
    await vi.waitFor(() => expect(controller.state.index).toBe(1));
    await h.prepareNext();
    expect(api.plan).not.toHaveBeenCalled();
    vi.spyOn(h, 'prepareNext').mockResolvedValue(undefined);
    loading.resolve({ ...slot, deck: 1, entryId: 'b-entry', trackId: 'b', token: 'b-token' });
    await starting;
    expect(h.current.trackId).toBe('b');
    expect(controller.state.status).toBe('paused');
  });
  it('selects the next track while paused without arming a transition or unpausing audio', async () => {
    const { controller, h, postMessage, slot } = setup();
    const transport = h as typeof h & { loadSlot(): Promise<typeof h.current>; waitFed(): Promise<void> };
    vi.spyOn(h, 'ensureEngine').mockResolvedValue(undefined);
    vi.spyOn(transport, 'loadSlot').mockResolvedValue({ ...slot, deck: 1, entryId: 'b-entry', trackId: 'b', token: 'b-token' });
    vi.spyOn(transport, 'waitFed').mockResolvedValue(undefined);
    vi.spyOn(h, 'prepareNext').mockResolvedValue(undefined);
    cleanups.push(() => { if (h.saveTimer) clearTimeout(h.saveTimer); });
    controller.pause(); postMessage.mockClear();
    await controller.nextTrack();
    expect(controller.state).toMatchObject({ index: 1, status: 'paused', position: 0 });
    expect(h.current.trackId).toBe('b');
    const commands = postMessage.mock.calls.map(([command]) => command);
    expect(commands).not.toContainEqual({ cmd: 'pause', paused: false });
    expect(commands.some((c) => c.cmd === 'arm')).toBe(false);
    expect(api.mixNow).not.toHaveBeenCalled();
  });
  it('keeps Pause pressed while the selected track is still loading', async () => {
    const { controller, h, slot, postMessage } = setup();
    const loading = deferred<typeof slot>();
    const transport = h as typeof h & { loadSlot(): Promise<typeof slot>; waitFed(): Promise<void> };
    vi.spyOn(h, 'ensureEngine').mockResolvedValue(undefined);
    vi.spyOn(transport, 'loadSlot').mockReturnValueOnce(loading.promise);
    vi.spyOn(transport, 'waitFed').mockResolvedValue(undefined);
    vi.spyOn(h, 'prepareNext').mockResolvedValue(undefined);
    cleanups.push(() => { if (h.saveTimer) clearTimeout(h.saveTimer); });
    const starting = controller.startAt(1, 0);
    await vi.waitFor(() => expect(controller.state.status).toBe('loading'));
    controller.pause();
    loading.resolve({ ...slot, deck: 1, entryId: 'b-entry', trackId: 'b', token: 'b-token' });
    await starting;
    expect(controller.state.status).toBe('paused');
    expect(postMessage.mock.calls.map(([command]) => command).slice(-1)).toEqual([{ cmd: 'pause', paused: true }]);
    expect(h.current.trackId).toBe('b');
  });

  it('does not undo Pause when AudioContext.resume completes late', async () => {
    const { controller, h, postMessage } = setup();
    const unlocking = deferred<void>();
    vi.spyOn(h, 'ensureEngine').mockReturnValueOnce(unlocking.promise);
    cleanups.push(() => { if (h.saveTimer) clearTimeout(h.saveTimer); });
    const resuming = controller.resume();
    controller.pause();
    unlocking.resolve();
    await resuming;
    expect(controller.state.status).toBe('paused');
    expect(postMessage.mock.calls.map(([command]) => command)).toEqual([{ cmd: 'pause', paused: true }]);
  });

  it('resumes an AudioContext the system interrupted while playing, never one the listener paused', async () => {
    const { controller, h } = setup();
    const resume = vi.fn(async () => {});
    const ctx = { state: 'running', sampleRate: 48000, onstatechange: null as null | (() => void), resume, destination: {},
      audioWorklet: { addModule: async () => {} }, createAnalyser: () => ({ connect: vi.fn() }) };
    vi.stubGlobal('AudioContext', vi.fn(function () { return ctx; }));
    vi.stubGlobal('AudioWorkletNode', vi.fn(function () { return { connect: vi.fn(), port: { postMessage: vi.fn(), onmessage: null } }; }));
    vi.stubGlobal('document', { addEventListener: vi.fn() });
    (h as unknown as { ctx: null }).ctx = null;
    await h.ensureEngine();
    ctx.state = 'interrupted';
    ctx.onstatechange!();
    expect(resume).toHaveBeenCalledTimes(1);
    cleanups.push(() => { if (h.saveTimer) clearTimeout(h.saveTimer); });
    controller.pause();
    ctx.onstatechange!();
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('takes the exact PCM length of a finished decode instead of padding the estimate', async () => {
    const { h, postMessage, slot } = setup();
    const samples = new Float32Array(20).fill(0.25);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, headers: new Headers({ 'X-Total-Frames': '10', 'X-Complete': '1', 'X-PCM-Format': 'f32le' }), arrayBuffer: async () => samples.buffer })));
    const chunks = await (h as unknown as { readChunks(s: unknown, run: number[]): Promise<{ L: Float32Array }[]> }).readChunks(slot, [0]);
    expect(slot.totalFrames).toBe(10);
    expect(chunks[0].L.length).toBe(10);
    expect(postMessage.mock.calls.map(([c]) => c)).toContainEqual({ cmd: 'length', deck: 0, token: slot.token, totalFrames: 10 });
  });

  it('does not advance automatically when a load fails after Pause', async () => {
    const { controller, h } = setup();
    const loading = deferred<typeof h.current>();
    const transport = h as typeof h & { loadSlot(): Promise<typeof h.current> };
    vi.spyOn(h, 'ensureEngine').mockResolvedValue(undefined);
    vi.spyOn(transport, 'loadSlot').mockReturnValueOnce(loading.promise);
    const advance = vi.spyOn(h, 'advanceAfterFailure').mockResolvedValue(undefined);
    const starting = controller.startAt(1, 0);
    await vi.waitFor(() => expect(controller.state.status).toBe('loading'));
    controller.pause();
    vi.useFakeTimers();
    try {
      vi.spyOn(transport as typeof transport & { waitFed(): Promise<void> }, 'waitFed').mockRejectedValueOnce(new Error('offline'));
      loading.resolve(h.current);
      await starting;
      await vi.advanceTimersByTimeAsync(601);
      expect(controller.state.status).toBe('paused');
      expect(advance).not.toHaveBeenCalled();
    } finally {
      if (h.saveTimer) clearTimeout(h.saveTimer);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('rejects an older Play after engine startup and preserves the newer selection', async () => {
    const { controller, h } = setup();
    const unlocking = deferred<void>();
    const transport = h as typeof h & { loadSlot(): Promise<typeof h.current> };
    vi.spyOn(h, 'ensureEngine').mockReturnValueOnce(unlocking.promise);
    const load = vi.spyOn(transport, 'loadSlot');
    const starting = controller.startAt(1, 0);
    controller.pause();
    unlocking.resolve();
    await starting;
    expect(load).not.toHaveBeenCalled();
    expect(controller.state.status).toBe('paused');
    cleanups.push(() => { if (h.saveTimer) clearTimeout(h.saveTimer); });
  });

  it('keeps a user queue command issued while startup restoration is pending', async () => {
    const { controller, h } = setup();
    h.current = null as unknown as typeof h.current;
    controller.state = { ...controller.state, queue: [], index: -1, status: 'idle' };
    cleanups.push(() => { if (h.saveTimer) clearTimeout(h.saveTimer); });
    const slow = deferred<unknown>();
    vi.mocked(api.queue).mockImplementationOnce(() => slow.promise);
    const restoring = controller.restore();
    controller.addToQueue(['b']);
    slow.resolve({ items: [{ entryId: 'saved', trackId: 'a', origin: 'user' }], index: 0, position: 80 });
    await restoring;
    expect(controller.state.queue.map((entry) => entry.trackId)).toEqual(['b']);
    expect(controller.state.position).toBe(0);
  });

  it('does not arm the old next track when the queue changes during planning', async () => {
    const { controller, h, postMessage } = setup();
    cleanups.push(() => { if (h.saveTimer) clearTimeout(h.saveTimer); });
    const slow = deferred<ReturnType<typeof pair>>();
    vi.mocked(api.plan).mockImplementationOnce(() => slow.promise);
    const preparing = h.prepareNext();
    await vi.waitFor(() => expect(api.plan).toHaveBeenCalledWith('a', 'b'));
    controller.move(2, 1);
    slow.resolve(pair('b'));
    await preparing;
    await vi.waitFor(() => expect(h.next?.entry.trackId).toBe('c'));
    expect(api.prepare).not.toHaveBeenCalledWith('b', expect.anything(), expect.anything());
    const arms = postMessage.mock.calls.map(([command]) => command).filter((command) => command.cmd === 'arm');
    expect(arms).toHaveLength(1);
    expect(arms[0].transition.toToken).toContain('c-entry');
  });

  it('does not replace the spare deck with a stale prepare response', async () => {
    const { controller, h, postMessage } = setup();
    cleanups.push(() => { if (h.saveTimer) clearTimeout(h.saveTimer); });
    const slow = deferred<Awaited<ReturnType<typeof api.prepare>>>();
    vi.mocked(api.prepare).mockImplementationOnce(() => slow.promise);
    const preparing = h.prepareNext();
    await vi.waitFor(() => expect(api.prepare).toHaveBeenCalledWith('b', 48000, 'next'));
    controller.move(2, 1);
    slow.resolve({ totalFrames: 180 * 48000, complete: true, analysis: 'done' });
    await preparing;
    await vi.waitFor(() => expect(h.next?.entry.trackId).toBe('c'));
    const loads = postMessage.mock.calls.map(([command]) => command).filter((command) => command.cmd === 'load');
    expect(loads).toHaveLength(1);
    expect(loads[0].token).toContain('c-entry');
  });

  it('replans a prepared pair immediately after mix settings are saved', async () => {
    const { controller, h, postMessage } = setup();
    await h.prepareNext();
    const previous = h.next;
    controller.onSettingsChanged(-18);
    await vi.waitFor(() => expect(api.plan).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(h.next).not.toBeNull());
    expect(h.next).not.toBe(previous);
    expect(postMessage.mock.calls.some(([command]) => command.cmd === 'disarm')).toBe(true);
  });

  it('fetches evicted PCM again after a backward seek instead of buffering forever', async () => {
    const { h, slot, postMessage } = setup();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(32768 * 4) });
    vi.stubGlobal('fetch', fetchMock);
    expect(slot.fed.has(0)).toBe(true);
    h.onNeed(0, slot.token, [0]);
    await vi.waitFor(() => expect(postMessage.mock.calls.some(([command]) => command.cmd === 'feed' && command.chunk === 0)).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(slot.fed.has(0)).toBe(true);
  });

  it('keeps the fading deck intact after seeking during an active blend', async () => {
    const { controller, h, postMessage } = setup();
    await h.prepareNext();
    const nx = h.next!;
    controller.state = { ...controller.state, transition: { planId: nx.plan.id, plan: nx.plan, active: true, late: false, startsIn: null, progress: 0.2, fallback: null } };
    postMessage.mockClear();
    controller.seek(30);
    h.onEngine({ type: 'transitionAborted', planId: nx.plan.id, reason: 'seek' });
    await vi.waitFor(() => expect(api.prepare).toHaveBeenCalledTimes(2));
    expect(postMessage.mock.calls.some(([command]) => command.cmd === 'unload' || command.cmd === 'load')).toBe(false);
    await vi.waitFor(() => {
      expect(h.next).not.toBeNull();
      expect(h.next!.slot.token).not.toBe(nx.slot.token);
    }, { timeout: 1500 });
  });

  it('does not let a late analysis response replace a manual next command', async () => {
    const { controller, h } = setup();
    await h.prepareNext();
    h.next!.pending = ['b'];
    const slow = deferred<ReturnType<typeof pair>>();
    vi.mocked(api.plan).mockImplementationOnce(() => slow.promise);
    controller.onAnalysisDone('b');
    await vi.waitFor(() => expect(api.plan).toHaveBeenCalledTimes(2));
    await controller.nextTrack('dislike');
    const skip = h.next!.plan;
    expect(skip.method).toBe('skip_fade');
    slow.resolve(pair('b'));
    await slow.promise;
    await Promise.resolve();
    expect(h.next!.plan).toBe(skip);
  });

  it('prepares a short musical transition from the current position on the first Next', async () => {
    const { controller, h, postMessage } = setup();
    controller.state.position = 41;
    const response = requested('b', 41);
    response.plan.bEntry = 24;
    response.plan.gainA = -2;
    response.plan.gainB = 3;
    vi.mocked(api.mixNow).mockResolvedValueOnce(response);
    await controller.nextTrack();
    expect(api.prepare).toHaveBeenCalledWith('b', 48000, 'next');
    expect(api.mixNow).toHaveBeenCalledWith('a', 'b', 41);
    expect(h.next!.plan).toBe(response.plan);
    expect(h.next!.plan.method).not.toBe('skip_fade');
    expect(h.next!.plan.duration).toBeGreaterThan(0.4);
    expect(postMessage.mock.calls.map(([command]) => command)).toEqual(expect.arrayContaining([
      expect.objectContaining({ cmd: 'cue', deck: 1, frame: 24 * 48000 }),
      expect.objectContaining({ cmd: 'gain', deck: 0, gainDb: -2 }),
      expect.objectContaining({ cmd: 'gain', deck: 1, gainDb: 3 }),
    ]));
  });

  it('uses a quick skip for a repeated Next while the musical plan is pending', async () => {
    const { controller, h } = setup();
    await h.prepareNext();
    const slow = deferred<ReturnType<typeof requested>>();
    vi.mocked(api.mixNow).mockReturnValueOnce(slow.promise);
    const first = controller.nextTrack();
    await vi.waitFor(() => expect(api.mixNow).toHaveBeenCalledTimes(1));
    await controller.nextTrack();
    const fast = h.next!.plan;
    expect(fast.method).toBe('skip_fade');
    slow.resolve(requested('b', 0));
    await first;
    expect(h.next!.plan).toBe(fast);
    expect(api.mixNow).toHaveBeenCalledTimes(1);
  });

  it('stages a changed entry before arming and retimes the transition after PCM arrives', async () => {
    const { controller, h, postMessage } = setup();
    await h.prepareNext();
    const original = h.next!.plan;
    const pcm = deferred<ArrayBuffer>();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, arrayBuffer: () => pcm.promise });
    vi.stubGlobal('fetch', fetchMock);
    const response = requested('b', 0);
    response.plan.bEntry = 45;
    vi.mocked(api.mixNow).mockResolvedValueOnce(response);
    postMessage.mockClear();
    const first = controller.nextTrack();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(h.next!.plan).toBe(original);
    expect(postMessage.mock.calls.some(([command]) => ['cue', 'arm', 'gain'].includes(command.cmd))).toBe(false);
    controller.state.position = 2;
    pcm.resolve(new ArrayBuffer(CHUNK_FRAMES * 8 * 4));
    await first;
    const commands = postMessage.mock.calls.map(([command]) => command);
    expect(h.next!.plan.bEntry).toBe(45);
    expect(h.next!.plan.aExit).toBeGreaterThan(2);
    const cueIndex = commands.findIndex((command) => command.cmd === 'cue');
    const feedIndex = commands.findIndex((command) => command.cmd === 'feed');
    const armIndex = commands.findIndex((command) => command.cmd === 'arm');
    expect(cueIndex).toBeGreaterThanOrEqual(0);
    expect(feedIndex).toBeGreaterThan(cueIndex);
    expect(armIndex).toBeGreaterThan(feedIndex);
  });

  it('keeps the old loaded cue on repeated Next while a different entry is buffering', async () => {
    const { controller, h, postMessage } = setup();
    await h.prepareNext();
    const original = h.next!.plan;
    const pcm = deferred<ArrayBuffer>();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, arrayBuffer: () => pcm.promise });
    vi.stubGlobal('fetch', fetchMock);
    const response = requested('b', 0);
    response.plan.bEntry = 45;
    vi.mocked(api.mixNow).mockResolvedValueOnce(response);
    postMessage.mockClear();
    const first = controller.nextTrack();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await controller.nextTrack();
    const fast = h.next!.plan;
    expect(fast.method).toBe('skip_fade');
    expect(fast.bEntry).toBe(original.bEntry);
    expect(postMessage.mock.calls.some(([command]) => command.cmd === 'cue')).toBe(false);
    pcm.resolve(new ArrayBuffer(CHUNK_FRAMES * 8 * 4));
    await first;
    expect(h.next!.plan).toBe(fast);
    expect(postMessage.mock.calls.some(([command]) => command.cmd === 'feed' || command.cmd === 'cue')).toBe(false);
  });

  it('retains native A bar alignment when a requested tempo bridge arrives late', async () => {
    const { controller, h } = setup();
    await h.prepareNext();
    const response = requested('b', 0);
    response.plan.method = 'tempo_bridge';
    response.plan.aExit = 0.1;
    response.plan.beatAlign = { bpmA: 120, bpmB: 150, relation: 1, ratio: 0.8, stretchPercent: 20,
      overlapBeats: 8, phraseAligned: true, bridge: { commonBpm: 135, lockAt: 2, recoverySeconds: 4 } };
    controller.state.position = 2.2;
    vi.mocked(api.mixNow).mockResolvedValueOnce(response);
    await controller.nextTrack();
    expect(h.next!.plan.aExit).toBeCloseTo(4.1, 8);
    expect((h.next!.plan.aExit - response.plan.aExit) / 2).toBeCloseTo(2, 8);
  });

  it('preserves the outgoing echo bar after a late requested response', async () => {
    const { controller, h, tracks } = setup();
    await h.prepareNext();
    tracks.get('a')!.analysis.bpm = 120;
    const response = requested('b', 0);
    response.plan.method = 'echo_out';
    response.plan.aExit = 0.6;
    response.plan.swapAt = 2.4;
    response.plan.echo = { delay: 0.375, feedback: 0.5 };
    controller.state.position = 1;
    vi.mocked(api.mixNow).mockResolvedValueOnce(response);
    await controller.nextTrack();
    expect(h.next!.plan.aExit).toBeCloseTo(2.6, 8);
    expect(h.next!.plan.aExit + h.next!.plan.swapAt).toBeCloseTo(5, 8);
  });

  it('keeps source restrictions when a sequential plan is prepared near the end and manually skipped', async () => {
    const { controller, h } = setup();
    const restricted = planTransition(
      { id: 'a', duration: 180, mixingAllowed: false, analysis: null },
      { id: 'b', duration: 180, mixingAllowed: true, analysis: null }, DEFAULT_AUTOMIX_SETTINGS);
    vi.mocked(api.plan).mockResolvedValueOnce({ plan: restricted, pending: [], cached: false });
    controller.state.position = 179;
    await h.prepareNext();
    expect(h.next!.plan.method).toBe('gapless');
    expect(h.next!.plan.duration).toBe(0);
    await controller.nextTrack('dislike');
    expect(h.next!.plan.method).toBe('gapless');
    expect(h.next!.plan.duration).toBe(0);
    expect(h.next!.plan.automation).toEqual([]);
    expect(h.next!.plan.tempoA).toBeUndefined();
    expect(h.next!.plan.tempoB).toEqual([[0, 1]]);
  });

  it.each([
    ['AutoMix is off', { ...DEFAULT_AUTOMIX_SETTINGS, enabled: false }, {}],
    ['album order is respected', { ...DEFAULT_AUTOMIX_SETTINGS, respectAlbums: true }, { album: 'Альбом', albumArtist: 'X', discNo: 1 }],
  ])('keeps gapless playback near the end when %s', async (_, settings, album) => {
    const { controller, h } = setup();
    const sequential = planTransition(
      { id: 'a', duration: 180, mixingAllowed: true, analysis: null, ...album, trackNo: 1 },
      { id: 'b', duration: 180, mixingAllowed: true, analysis: null, ...album, trackNo: 2 }, settings);
    expect(sequential.method).toBe('gapless');
    vi.mocked(api.plan).mockResolvedValueOnce({ plan: sequential, pending: [], cached: false });
    controller.state.position = 179;
    await h.prepareNext();
    expect(h.next!.plan.method).toBe('gapless');
    expect(h.next!.plan.duration).toBe(0);
    expect(h.next!.plan.fallbackReason).toBeUndefined();
  });

  it('remembers a repeated Next even while the spare deck is still being prepared', async () => {
    const { controller, h } = setup();
    const slow = deferred<ReturnType<typeof pair>>();
    vi.mocked(api.plan).mockReturnValueOnce(slow.promise);
    const first = controller.nextTrack();
    await vi.waitFor(() => expect(api.plan).toHaveBeenCalledTimes(1));
    await controller.nextTrack();
    slow.resolve(pair('b'));
    await first;
    expect(h.next!.entry.trackId).toBe('b');
    expect(h.next!.plan.method).toBe('skip_fade');
    expect(api.mixNow).not.toHaveBeenCalled();
  });

  it('uses a quick skip on dislike without waiting for a musical plan', async () => {
    const { controller, h } = setup();
    await controller.nextTrack('dislike');
    expect(h.next!.plan.method).toBe('skip_fade');
    expect(api.mixNow).not.toHaveBeenCalled();
  });

  it('quickly finishes a requested blend when Next is pressed again before it starts', async () => {
    const { controller, h } = setup();
    await controller.nextTrack();
    expect(h.next!.plan.debug.requested).toBe(true);
    await controller.nextTrack();
    expect(h.next!.plan.method).toBe('skip_fade');
    expect(api.mixNow).toHaveBeenCalledTimes(1);
  });

  it('does not apply a musical response after the listener seeks elsewhere', async () => {
    const { controller, h, postMessage } = setup();
    await h.prepareNext();
    const prepared = h.next!.plan;
    const slow = deferred<ReturnType<typeof requested>>();
    vi.mocked(api.mixNow).mockReturnValueOnce(slow.promise);
    const first = controller.nextTrack();
    await vi.waitFor(() => expect(api.mixNow).toHaveBeenCalledTimes(1));
    controller.seek(90);
    postMessage.mockClear();
    slow.resolve(requested('b', 0));
    await first;
    expect(h.next!.plan).toBe(prepared);
    expect(postMessage.mock.calls.some(([command]) => command.cmd === 'arm')).toBe(false);
  });

  it('asks again for a plan whose render check waited for the next track PCM', async () => {
    const { h } = setup();
    const unchecked = pair('b');
    unchecked.plan = { ...unchecked.plan, debug: { ...unchecked.plan.debug, renderCheck: { policy: 'render-finalists-1', skipped: 'pcm-not-ready' } } };
    const checked = pair('b');
    checked.plan = { ...checked.plan, id: `${checked.plan.id}_render`, debug: { ...checked.plan.debug, renderCheck: { policy: 'render-finalists-1', selected: 'baseline' } } };
    vi.mocked(api.plan).mockResolvedValueOnce(unchecked).mockResolvedValueOnce(checked);
    await h.prepareNext();
    await vi.waitFor(() => expect(h.next!.plan.id).toBe(checked.plan.id));
    expect(api.plan).toHaveBeenCalledTimes(2);
  });

  it('keeps an analysis refresh from superseding a requested transition in flight', async () => {
    const { controller, h } = setup();
    await h.prepareNext();
    h.next!.pending = ['b'];
    const original = h.next!.plan;
    const analysis = deferred<ReturnType<typeof pair>>();
    const musical = deferred<ReturnType<typeof requested>>();
    vi.mocked(api.plan).mockReturnValueOnce(analysis.promise);
    vi.mocked(api.mixNow).mockReturnValueOnce(musical.promise);
    controller.onAnalysisDone('b');
    await vi.waitFor(() => expect(api.plan).toHaveBeenCalledTimes(2));
    const first = controller.nextTrack();
    await vi.waitFor(() => expect(api.mixNow).toHaveBeenCalledTimes(1));
    analysis.resolve(pair('b'));
    await analysis.promise;
    await Promise.resolve();
    expect(h.next!.plan).toBe(original);
    const response = requested('b', 0);
    musical.resolve(response);
    await first;
    expect(h.next!.plan).toBe(response.plan);
  });

  it('finishes an already active blend immediately on Next', async () => {
    const { controller, h, postMessage } = setup();
    await h.prepareNext();
    const nx = h.next!;
    controller.state.transition = { planId: nx.plan.id, plan: nx.plan, active: true, late: false, startsIn: null, progress: 0.2, fallback: null };
    postMessage.mockClear();
    await controller.nextTrack();
    expect(postMessage.mock.calls.map(([command]) => command)).toEqual([{ cmd: 'finish', fade: 0.4 }]);
    expect(api.mixNow).not.toHaveBeenCalled();
  });

  it('does not replace the new next track with a response for the old queue', async () => {
    const { controller, h } = setup();
    cleanups.push(() => { if (h.saveTimer) clearTimeout(h.saveTimer); });
    await h.prepareNext();
    const slow = deferred<ReturnType<typeof requested>>();
    vi.mocked(api.mixNow).mockReturnValueOnce(slow.promise);
    const first = controller.nextTrack();
    await vi.waitFor(() => expect(api.mixNow).toHaveBeenCalledTimes(1));
    controller.move(2, 1);
    await vi.waitFor(() => expect(h.next?.entry.trackId).toBe('c'));
    const replacement = h.next!.plan;
    slow.resolve(requested('b', 0));
    await first;
    expect(h.next!.plan).toBe(replacement);
    expect(h.next!.plan.toTrackId).toBe('c');
  });

  it('advances to the next entry on manual Next while repeat-one is enabled', async () => {
    const { controller, h } = setup();
    controller.state.repeat = 'one';
    await h.prepareNext();
    expect(h.next!.entry.trackId).toBe('a');
    await controller.nextTrack();
    expect(h.next!.entry.trackId).toBe('b');
    expect(api.mixNow).toHaveBeenCalledWith('a', 'b', 0);
    expect(controller.state.repeat).toBe('one');
  });

  it('retains an already audible incoming track when upcoming songs are cleared', async () => {
    const { controller, h } = setup();
    cleanups.push(() => { if (h.saveTimer) clearTimeout(h.saveTimer); });
    await h.prepareNext();
    const nx = h.next!;
    controller.state = { ...controller.state, transition: { planId: nx.plan.id, plan: nx.plan, active: true, late: false, startsIn: null, progress: 0.2, fallback: null } };
    controller.clearUpcoming();
    expect(controller.state.queue.map((entry) => entry.trackId)).toEqual(['a', 'b']);
    h.onEngine({ type: 'swap', planId: nx.plan.id, token: nx.slot.token });
    expect(controller.currentEntry?.trackId).toBe('b');
    expect(controller.state.index).toBe(1);
  });

  it('adopts incoming position and duration before planning the following pair without another tick', async () => {
    const { controller, h, tracks } = setup();
    cleanups.push(() => { if (h.saveTimer) clearTimeout(h.saveTimer); });
    tracks.get('b')!.duration = 90;
    const initial = pair('b');
    initial.plan.bEntry = 20;
    initial.plan.duration = 6;
    const following = pair('c', 'b');
    following.plan.aExit = 70;
    vi.mocked(api.plan).mockResolvedValueOnce(initial).mockResolvedValueOnce(following);
    await h.prepareNext();
    const nx = h.next!;
    controller.state.position = 178;
    h.maxPos = 178;
    h.onEngine({ type: 'transitionEnd', planId: nx.plan.id, token: nx.slot.token, forced: false });
    expect(controller.currentEntry?.trackId).toBe('b');
    expect(controller.state.position).toBe(26);
    expect(controller.state.duration).toBe(90);
    expect(h.maxPos).toBe(26);
    await vi.waitFor(() => expect(h.next?.entry.trackId).toBe('c'));
    expect(h.next!.plan.aExit).toBe(70);
    h.onEngine({ type: 'swap', planId: nx.plan.id, token: nx.slot.token });
    expect(controller.currentEntry?.trackId).toBe('b');
    expect(h.next!.entry.trackId).toBe('c');
  });

  it('resets position and history counters when A ends before its prepared transition', async () => {
    const { controller, h, tracks, slot } = setup();
    cleanups.push(() => { if (h.saveTimer) clearTimeout(h.saveTimer); });
    tracks.get('b')!.duration = 90;
    const initial = pair('b');
    initial.plan.bEntry = 20;
    vi.mocked(api.plan).mockResolvedValueOnce(initial);
    await h.prepareNext();
    controller.state.position = 180;
    h.maxPos = 180;
    h.onEngine({ type: 'ended', deck: slot.deck, token: slot.token });
    expect(controller.state.position).toBe(20);
    expect(controller.state.duration).toBe(90);
    expect(h.maxPos).toBe(20);
    expect(controller.state.nextPending).toEqual([]);
    await vi.waitFor(() => expect(h.next?.entry.trackId).toBe('c'));
  });

  it('defers a new beat-locked Next until the preceding bridge recovers its native tempo', async () => {
    const { controller, h } = setup();
    cleanups.push(() => { if (h.saveTimer) clearTimeout(h.saveTimer); });
    const initial = pair('b');
    initial.plan.bEntry = 20;
    initial.plan.duration = 6;
    initial.plan.tempoB = [[0, 1.1], [6, 1.1], [10, 1]];
    vi.mocked(api.plan).mockResolvedValueOnce(initial);
    await h.prepareNext();
    const nx = h.next!;
    h.onEngine({ type: 'transitionEnd', planId: nx.plan.id, token: nx.slot.token, forced: false });
    await vi.waitFor(() => expect(h.next?.entry.trackId).toBe('c'));
    const next = requested('c', 26.6, 'b');
    next.plan.method = 'beatmatch_blend';
    next.plan.aExit = 28;
    next.plan.beatAlign = { bpmA: 120, bpmB: 120, relation: 1, ratio: 1, stretchPercent: 0, overlapBeats: 8, phraseAligned: true };
    vi.mocked(api.mixNow).mockResolvedValueOnce(next);
    await controller.nextTrack();
    expect(h.next!.plan.aExit).toBe(32);
    expect(h.next!.plan.debug.recoveryDeferred).toBe(true);
  });

  it('remembers the log row of the finished transition and saves the listener rating for it', async () => {
    const { controller, h } = setup();
    cleanups.push(() => { if (h.saveTimer) clearTimeout(h.saveTimer); });
    await h.prepareNext();
    const nx = h.next!;
    h.onEngine({ type: 'transitionEnd', planId: nx.plan.id, token: nx.slot.token, forced: false });
    expect(api.logTransition).toHaveBeenCalledWith(nx.plan, expect.objectContaining({ forced: false }));
    await vi.waitFor(() => expect(controller.state.lastTransition?.logId).toBe(7));
    await controller.rateTransition(7, 'bad', 'резко');
    expect(api.rateTransition).toHaveBeenCalledWith(7, 'bad', 'резко');
    expect(controller.state.lastTransition).toMatchObject({ plan: nx.plan, logId: 7, rating: 'bad', ratingReason: 'резко' });
    await controller.rateTransition(7, null);
    expect(controller.state.lastTransition).toMatchObject({ rating: null, ratingReason: null });
    // rating an older history row leaves the last transition untouched
    await controller.rateTransition(3, 'good');
    expect(api.rateTransition).toHaveBeenLastCalledWith(3, 'good', null);
    expect(controller.state.lastTransition).toMatchObject({ logId: 7, rating: null });
  });

  it('applies settings changed during a blend to B even when the queue ends there', async () => {
    const { controller, h, tracks, postMessage } = setup();
    cleanups.push(() => { if (h.saveTimer) clearTimeout(h.saveTimer); });
    controller.state.queue = controller.state.queue.slice(0, 2);
    tracks.get('b')!.analysis = { status: 'done', lufs: -20, truePeak: -6 };
    await h.prepareNext();
    const nx = h.next!;
    h.onEngine({ type: 'transitionStart', planId: nx.plan.id, late: false, clock: 0 });
    postMessage.mockClear();
    controller.onSettingsChanged(-18);
    expect(postMessage.mock.calls.some(([command]) => command.cmd === 'gain')).toBe(false);
    h.onEngine({ type: 'transitionEnd', planId: nx.plan.id, token: nx.slot.token, forced: false });
    expect(postMessage.mock.calls.map(([command]) => command)).toContainEqual({ cmd: 'gain', deck: nx.slot.deck, gainDb: 2 });
    await Promise.resolve();
    expect(controller.currentEntry?.trackId).toBe('b');
  });

  it('accepts the latest completed analysis when A and B refresh concurrently', async () => {
    const { controller, h, postMessage } = setup();
    await h.prepareNext();
    h.next!.pending = ['a', 'b'];
    const original = h.next!.plan;
    const earlier = deferred<ReturnType<typeof pair>>();
    const latest = deferred<ReturnType<typeof pair>>();
    vi.mocked(api.plan).mockReturnValueOnce(earlier.promise).mockReturnValueOnce(latest.promise);
    controller.onAnalysisDone('a');
    controller.onAnalysisDone('b');
    await vi.waitFor(() => expect(api.plan).toHaveBeenCalledTimes(3));
    earlier.resolve({ ...pair('b'), pending: ['b'] });
    await earlier.promise;
    await Promise.resolve();
    expect(h.next!.plan).toBe(original);
    const final = pair('b');
    final.plan.bEntry = 45;
    final.plan.gainA = -2;
    latest.resolve(final);
    await vi.waitFor(() => expect(h.next!.plan).toBe(final.plan));
    expect(h.next!.pending).toEqual([]);
    expect(postMessage.mock.calls.map(([command]) => command)).toContainEqual({ cmd: 'gain', deck: 0, gainDb: -2 });
  });

  it('retains the old cue if a requested-entry PCM request fails', async () => {
    const { controller, h, postMessage } = setup();
    await h.prepareNext();
    const oldEntry = h.next!.plan.bEntry;
    const next = requested('b', 0);
    next.plan.bEntry = 45;
    vi.mocked(api.mixNow).mockResolvedValueOnce(next);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => ({ error: 'decode failed' }) }));
    postMessage.mockClear();
    await controller.nextTrack();
    expect(h.next!.plan.method).toBe('skip_fade');
    expect(h.next!.plan.bEntry).toBe(oldEntry);
    expect(postMessage.mock.calls.some(([command]) => command.cmd === 'cue' || command.cmd === 'feed')).toBe(false);
  });

  it('does not mark aborted PCM as fed and deduplicates repeated requests in flight', async () => {
    const { h, slot, postMessage } = setup();
    const pcm = deferred<ArrayBuffer>();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, arrayBuffer: () => pcm.promise });
    vi.stubGlobal('fetch', fetchMock);
    h.onNeed(0, slot.token, [0]);
    h.onNeed(0, slot.token, [0]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    slot.abort.abort();
    pcm.resolve(new ArrayBuffer(CHUNK_FRAMES * 4));
    await pcm.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(slot.fed.has(0)).toBe(false);
    expect(postMessage.mock.calls.some(([command]) => command.cmd === 'feed')).toBe(false);
  });

  it('preserves floating original PCM above full scale until the worklet processes it', async () => {
    const { h, slot, postMessage } = setup();
    const pcm = new Float32Array(CHUNK_FRAMES * 2);
    for (let i = 0; i < CHUNK_FRAMES; i++) { pcm[i * 2] = 1.25; pcm[i * 2 + 1] = -1.125; }
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, headers: new Headers({ 'X-PCM-Format': 'f32le' }), arrayBuffer: async () => pcm.buffer });
    vi.stubGlobal('fetch', fetchMock);
    h.onNeed(0, slot.token, [0]);
    await vi.waitFor(() => expect(postMessage.mock.calls.some(([command]) => command.cmd === 'feed')).toBe(true));
    expect(fetchMock.mock.calls[0][0]).toContain('&format=f32le');
    const feed = postMessage.mock.calls.find(([command]) => command.cmd === 'feed')![0];
    expect(feed.L[100]).toBe(1.25);
    expect(feed.R[100]).toBe(-1.125);
  });

  it('fetches separate f32 vocal PCM and feeds both decks before arming a stem mix', async () => {
    const { h, postMessage, slot } = setup();
    const stemPlan = pair('b');
    stemPlan.plan.vocalA = [[0, 1], [2, 0.2], [6, 0.2]];
    stemPlan.plan.vocalB = [[0, 0.2], [4, 1]];
    vi.mocked(api.plan).mockResolvedValueOnce(stemPlan);
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const params = new URL(url, 'http://localhost').searchParams;
      const frames = Number(params.get('frames'));
      const vocal = url.includes('/vocals/pcm?');
      const pcm = vocal ? new Float32Array(frames * 2).fill(0.25) : new Int16Array(frames * 2);
      return { ok: true, arrayBuffer: async () => pcm.buffer };
    });
    vi.stubGlobal('fetch', fetchMock);
    await h.prepareNext();
    expect(fetchMock.mock.calls.filter(([url]) => url.includes('/vocals/pcm?'))).toHaveLength(2);
    const commands = postMessage.mock.calls.map(([command]) => command);
    const vocalFeeds = commands.filter((command) => command.cmd === 'feedVocal');
    expect(vocalFeeds.some((command) => command.deck === 0)).toBe(true);
    expect(vocalFeeds.some((command) => command.deck === 1)).toBe(true);
    expect(vocalFeeds[0].L[0]).toBe(0.25);
    expect(vocalFeeds[0].R[0]).toBe(0.25);
    expect(commands.findIndex((command) => command.cmd === 'arm')).toBeGreaterThan(commands.findLastIndex((command) => command.cmd === 'feedVocal'));
    expect(slot.vocals.fed.size).toBeGreaterThan(0);
    expect(slot.fed.has(0)).toBe(true);
    expect(h.next!.plan.vocalA).toEqual(stemPlan.plan.vocalA);
  });

  it('waits for vocal startup PCM before arming a prepared DJ transition', async () => {
    const { h, postMessage } = setup();
    const stemPlan = pair('b');
    stemPlan.plan.vocalB = [[0, 0.2], [4, 1]];
    vi.mocked(api.plan).mockResolvedValueOnce(stemPlan);
    const vocalPcm = deferred<ArrayBuffer>();
    const fetchMock = vi.fn().mockImplementation(async (url: string) => ({
      ok: true, arrayBuffer: () => url.includes('/vocals/pcm?') ? vocalPcm.promise : Promise.resolve(new ArrayBuffer(CHUNK_FRAMES * 8 * 4)),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const preparing = h.prepareNext();
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url.includes('/vocals/pcm?'))).toBe(true));
    expect(postMessage.mock.calls.some(([command]) => command.cmd === 'arm')).toBe(false);
    vocalPcm.resolve(new ArrayBuffer(CHUNK_FRAMES * 8 * 8));
    await preparing;
    expect(postMessage.mock.calls.some(([command]) => command.cmd === 'arm')).toBe(true);
  });

  it('arms the original mix without vocal maps when optional vocal PCM is unavailable', async () => {
    const { h } = setup();
    const stemPlan = pair('b');
    stemPlan.plan.vocalA = [[0, 0.2], [4, 1]];
    stemPlan.plan.vocalB = [[0, 0.2], [4, 1]];
    vi.mocked(api.plan).mockResolvedValueOnce(stemPlan);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => url.includes('/vocals/pcm?')
      ? { ok: false, status: 409, json: async () => ({ error: 'вокальная партия ещё не готова' }) }
      : { ok: true, arrayBuffer: async () => new ArrayBuffer(CHUNK_FRAMES * 8 * 4) }));
    await h.prepareNext();
    expect(h.next!.plan.vocalA).toBeUndefined();
    expect(h.next!.plan.vocalB).toBeUndefined();
    expect(h.next!.plan.debug.vocalFallback).toBe('вокальная партия ещё не готова');
    expect(h.next!.entry.trackId).toBe('b');
  });

  it('keeps an early incoming voice protected when optional stem PCM fails', async () => {
    const { h } = setup();
    const stemPlan = pair('b'), D = stemPlan.plan.duration;
    stemPlan.plan.vocalA = [[0, 1], [1, 0], [D, 0]];
    stemPlan.plan.vocalB = [[0, 0], [1, 1], [D, 1]];
    stemPlan.plan.debug.firstWords = { attack: 1.2, wholeDeckFade: false };
    stemPlan.plan.automation.push({ deck: 'A', lane: 'echo', points: [[0, .4], [D, 0]] });
    stemPlan.plan.automation.push({ deck: 'B', lane: 'low', points: [[0, 0], [D, 1]] });
    vi.mocked(api.plan).mockResolvedValueOnce(stemPlan);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => url.includes('/vocals/pcm?')
      ? { ok: false, status: 409, json: async () => ({ error: 'not ready' }) }
      : { ok: true, arrayBuffer: async () => new ArrayBuffer(CHUNK_FRAMES * 8 * 4) }));
    await h.prepareNext();
    const plan = h.next!.plan;
    expect(plan.vocalA).toBeUndefined();
    expect(plan.vocalB).toBeUndefined();
    expect(plan.automation.some(l => l.deck === 'A' && l.lane === 'echo')).toBe(false);
    const gain = plan.automation.find(l => l.deck === 'A' && l.lane === 'gain')!;
    expect(gain.points.filter(([t]) => t >= 1.2).every(([, g]) => g === 0)).toBe(true);
    const low = plan.automation.find(l => l.deck === 'B' && l.lane === 'low')!;
    expect(low.points.filter(([t]) => t >= 1.2).every(([, g]) => g >= .999)).toBe(true);
    expect(plan.debug.firstWords).toMatchObject({ stemFallback: true });
  });

  it('removes stale voice echo and voice claims when optional stems cannot be buffered', async () => {
    const { h } = setup();
    const stemPlan = pair('b');
    stemPlan.plan.vocalA = [[0, 1], [2, 0]];
    stemPlan.plan.voiceEcho = { delay: .4, feedback: .25 };
    stemPlan.plan.automation.push({ deck: 'A', lane: 'voiceEcho', points: [[0, .4], [3, 0]] });
    stemPlan.plan.reasons.push('голос заканчивается в паузе', 'эхо голоса затихает до нового');
    stemPlan.plan.debug.stems = { model: 'model' };
    vi.mocked(api.plan).mockResolvedValueOnce(stemPlan);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => url.includes('/vocals/pcm?')
      ? { ok: false, status: 409, json: async () => ({ error: 'не готово' }) }
      : { ok: true, arrayBuffer: async () => new ArrayBuffer(CHUNK_FRAMES * 8 * 4) }));
    await h.prepareNext();
    expect(h.next!.plan.voiceEcho).toBeUndefined();
    expect(h.next!.plan.automation.some((lane) => lane.lane === 'voiceEcho')).toBe(false);
    expect(h.next!.plan.debug.stems).toBeUndefined();
    expect(h.next!.plan.reasons).not.toContain('голос заканчивается в паузе');
  });

  it('refreshes stems that became ready while the original next track was buffering', async () => {
    const { controller, h } = setup();
    const slow = deferred<Awaited<ReturnType<typeof api.prepare>>>();
    vi.mocked(api.prepare).mockReturnValueOnce(slow.promise);
    const preparing = h.prepareNext();
    await vi.waitFor(() => expect(api.prepare).toHaveBeenCalled());
    expect(h.next).toBeNull();
    const upgraded = pair('b'); upgraded.plan.vocalA = [[0, 1], [2, 0]];
    vi.mocked(api.plan).mockResolvedValueOnce(upgraded);
    controller.onAnalysisDone('a');
    slow.resolve({ totalFrames: 180 * 48000, complete: true, analysis: 'done' });
    await preparing;
    await vi.waitFor(() => expect(h.next!.plan.vocalA).toEqual(upgraded.plan.vocalA));
  });

  it('streams vocal chunks independently and disables only optional vocals on HTTP failure', async () => {
    const { h, slot, postMessage } = setup();
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: 'stem unavailable' }) });
    vi.stubGlobal('fetch', fetchMock);
    h.onEngine({ type: 'need', deck: 0, token: slot.token, chunks: [0], part: 'vocals' });
    await vi.waitFor(() => expect(postMessage.mock.calls.some(([command]) => command.cmd === 'disableVocals')).toBe(true));
    expect(slot.failed).toBeNull();
    expect(slot.fed.has(0)).toBe(true);
    expect(slot.vocals.failed).toBe('stem unavailable');
    expect(postMessage.mock.calls.map(([command]) => command)).toContainEqual({ cmd: 'nack', deck: 0, token: slot.token, chunk: 0, part: 'vocals' });
  });

  it('pins all streamed vocal chunks to one server generation', async () => {
    const { h, slot } = setup();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, headers: new Headers({ 'X-Automix-Vocal-Revision': 'generation:1' }), arrayBuffer: async () => new ArrayBuffer(CHUNK_FRAMES * 8) });
    vi.stubGlobal('fetch', fetchMock);
    h.onEngine({ type: 'need', deck: 0, token: slot.token, chunks: [0], part: 'vocals' });
    await vi.waitFor(() => expect(slot.vocals.fed.has(0)).toBe(true));
    h.onEngine({ type: 'need', deck: 0, token: slot.token, chunks: [1], part: 'vocals' });
    await vi.waitFor(() => expect(slot.vocals.fed.has(1)).toBe(true));
    expect(fetchMock.mock.calls[1][0]).toContain('&revision=generation%3A1');
  });

  it('waits for worklet acknowledgement before swapping an existing vocal source', async () => {
    const { controller, h, slot, postMessage } = setup();
    await h.prepareNext();
    const previous = h.next, oldStream = slot.vocals;
    controller.onVocalsChanged('a', 'new-generation');
    expect(postMessage.mock.calls.map(([c]) => c)).toContainEqual({ cmd: 'resetVocals', deck: 0, token: slot.token });
    expect(h.next).toBe(previous); expect(slot.vocals).toBe(oldStream);
    h.onEngine({ type: 'vocalsReset', deck: 0, token: slot.token, applied: true });
    await vi.waitFor(() => expect(slot.vocals).not.toBe(oldStream));
    await vi.waitFor(() => expect(h.next).not.toBeNull());
    expect(h.next).not.toBe(previous);
  });

  it('keeps old vocal PCM when the worklet has already started a blend', async () => {
    const { controller, h, slot } = setup();
    await h.prepareNext();
    const previous = h.next, oldStream = slot.vocals;
    controller.onVocalsChanged('a', 'new-generation');
    h.onEngine({ type: 'vocalsReset', deck: 0, token: slot.token, applied: false });
    await Promise.resolve(); await Promise.resolve();
    expect(h.next).toBe(previous); expect(slot.vocals).toBe(oldStream);
    controller.onVocalsChanged('a', 'new-generation');
    expect(h.next).toBe(previous);
  });

  it('discards old in-flight vocal responses after an acknowledged source reset', async () => {
    const { controller, h, slot, postMessage } = setup();
    await h.prepareNext();
    const slow = deferred<ArrayBuffer>();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => ({ ok: true,
      arrayBuffer: () => url.includes('/vocals/pcm?') ? slow.promise : Promise.resolve(new ArrayBuffer(CHUNK_FRAMES * 8 * 4)) })));
    h.onEngine({ type: 'need', deck: 0, token: slot.token, chunks: [0], part: 'vocals' });
    controller.onVocalsChanged('a', 'new-generation');
    h.onEngine({ type: 'vocalsReset', deck: 0, token: slot.token, applied: true });
    await vi.waitFor(() => expect(slot.vocals.inflight).toBe(0));
    slow.resolve(new ArrayBuffer(CHUNK_FRAMES * 8));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(postMessage.mock.calls.some(([c]) => c.cmd === 'feedVocal')).toBe(false);
    expect(postMessage.mock.calls.some(([c]) => c.cmd === 'disableVocals')).toBe(false);
  });

  it('refreshes a completed original analysis when its vocal separation becomes ready later', async () => {
    const { controller, h } = setup();
    await h.prepareNext();
    expect(h.next!.pending).toEqual([]);
    const stemPlan = pair('b');
    stemPlan.plan.vocalB = [[0, 0.2], [4, 1]];
    vi.mocked(api.plan).mockResolvedValueOnce(stemPlan);
    controller.onAnalysisDone('b');
    await vi.waitFor(() => expect(h.next!.plan.vocalB).toEqual(stemPlan.plan.vocalB));
  });

  it('aborts back to A before dropping a failed incoming B during an active blend', async () => {
    const { controller, h, slot, postMessage } = setup();
    cleanups.push(() => { if (h.saveTimer) clearTimeout(h.saveTimer); });
    await h.prepareNext();
    const nx = h.next!;
    controller.state.position = 38;
    h.onEngine({ type: 'transitionStart', planId: nx.plan.id, late: false, clock: 0 });
    postMessage.mockClear();
    h.onSlotFailed(nx.slot, 'PCM unavailable');
    expect(h.next).toBe(nx);
    expect(postMessage.mock.calls.map(([command]) => command)).toContainEqual({ cmd: 'seek', token: slot.token, frame: 38 * 48000 });
    expect(postMessage.mock.calls.some(([command]) => command.cmd === 'load' || command.cmd === 'unload')).toBe(false);
    h.onEngine({ type: 'transitionAborted', planId: nx.plan.id, reason: 'seek' });
    expect(controller.state.queue.map((entry) => entry.trackId)).toEqual(['a', 'c']);
    expect(controller.currentEntry?.trackId).toBe('a');
    await vi.waitFor(() => expect(h.next?.entry.trackId).toBe('c'), { timeout: 1500 });
  });

  it('treats swapped B as current and does not let its failure timer skip a later selection', async () => {
    const { controller, h, slot, postMessage } = setup();
    vi.useFakeTimers();
    cleanups.push(() => { vi.clearAllTimers(); vi.useRealTimers(); });
    await h.prepareNext();
    const nx = h.next!;
    h.onEngine({ type: 'swap', planId: nx.plan.id, token: nx.slot.token });
    postMessage.mockClear();
    const advance = vi.spyOn(h, 'advanceAfterFailure').mockResolvedValue(undefined);
    h.onSlotFailed(nx.slot, 'PCM unavailable');
    expect(controller.state.queue.some((entry) => entry.trackId === 'b')).toBe(true);
    expect(h.next).toBe(nx);
    expect(postMessage.mock.calls.some(([command]) => command.cmd === 'disarm')).toBe(false);
    // A different slot represents a newer successful Play/Next command.
    h.current = slot;
    await vi.advanceTimersByTimeAsync(801);
    expect(advance).not.toHaveBeenCalled();
  });

  it('previews the freshly planned exit with the normal pair queue and respects sequential source policy', async () => {
    const { controller, h } = setup();
    vi.spyOn(h, 'ensureEngine').mockResolvedValue(undefined);
    const start = vi.spyOn(controller, 'startAt').mockResolvedValue(undefined);
    controller.state = { ...controller.state, shuffle: true, repeat: 'one', nextPlan: { ...pair('b').plan, aExit: 50 } };
    const latest = pair('b');
    latest.plan.aExit = 130;
    vi.mocked(api.plan).mockResolvedValueOnce(latest);
    await controller.previewPair('a', 'b');
    expect(api.plan).toHaveBeenCalledWith('a', 'b');
    expect(start).toHaveBeenLastCalledWith(0, 122);
    expect(controller.state.queue.map((entry) => entry.trackId)).toEqual(['a', 'b']);
    expect(controller.state.shuffle).toBe(false);
    expect(controller.state.repeat).toBe('off');

    const restricted = planTransition(
      { id: 'a', duration: 180, mixingAllowed: false, analysis: null },
      { id: 'b', duration: 180, mixingAllowed: true, analysis: null }, DEFAULT_AUTOMIX_SETTINGS);
    vi.mocked(api.plan).mockResolvedValueOnce({ plan: restricted, cached: false, pending: [] });
    await controller.previewPair('a', 'b');
    expect(start).toHaveBeenLastCalledWith(0, 172);
    // Preview only chooses where normal playback starts; it never constructs
    // or rewrites the server's source-policy transition into an overlap.
    expect(restricted.method).toBe('gapless');
    expect(restricted.duration).toBe(0);
    expect(restricted.vocalA).toBeUndefined();
    expect(restricted.vocalB).toBeUndefined();
  });

  it('does not replace a newer Play command when preview planning responds late', async () => {
    const { controller, h } = setup();
    vi.spyOn(h, 'ensureEngine').mockResolvedValue(undefined);
    const start = vi.spyOn(controller, 'startAt').mockResolvedValue(undefined);
    const slow = deferred<ReturnType<typeof pair>>();
    vi.mocked(api.plan).mockReturnValueOnce(slow.promise);
    const preview = controller.previewPair('a', 'b');
    await controller.playTracks(['c'], 0, { type: 'library', label: 'Медиатека' });
    slow.resolve(pair('b'));
    await preview;
    expect(controller.state.queue.map((entry) => entry.trackId)).toEqual(['c']);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(0, 0);
    expect(controller.state.context?.type).toBe('library');
  });
});


describe('local service temporarily unreachable', () => {
  // fetch() rejects with TypeError when 127.0.0.1 does not answer at all (backend
  // restarting, offline renderer). That says nothing about the track itself.
  const unreachable = () => new TypeError('Failed to fetch');

  it('keeps the playing track queued and resumes feeding when the service returns', async () => {
    const { controller, h, slot, postMessage } = setup();
    const fetchMock = vi.fn().mockRejectedValue(unreachable());
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
    try {
      h.onNeed(0, slot.token, [1]);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(fetchMock.mock.calls.length).toBeGreaterThan(4);
      expect(slot.failed).toBeNull();
      expect(controller.state.queue.map((e) => e.trackId)).toEqual(['a', 'b', 'c']);
      fetchMock.mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(CHUNK_FRAMES * 8 * 4) });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(postMessage.mock.calls.some(([command]) => command.cmd === 'feed' && command.token === slot.token)).toBe(true);
    } finally {
      if (h.saveTimer) clearTimeout(h.saveTimer);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('does not drop the next track when the service cannot be reached while preparing it', async () => {
    const { controller, h } = setup();
    vi.mocked(api.prepare).mockRejectedValueOnce(unreachable());
    vi.useFakeTimers();
    try {
      await h.prepareNext();
      expect(controller.state.queue.map((e) => e.trackId)).toEqual(['a', 'b', 'c']);
      expect(h.next).toBeNull();
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() => expect(h.next?.entry.trackId).toBe('b'));
      expect(controller.state.queue.map((e) => e.trackId)).toEqual(['a', 'b', 'c']);
    } finally {
      if (h.saveTimer) clearTimeout(h.saveTimer);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('retries the selected track instead of skipping it, and respects Pause meanwhile', async () => {
    const { controller, h } = setup();
    vi.spyOn(h, 'ensureEngine').mockResolvedValue(undefined);
    vi.spyOn(h, 'prepareNext').mockResolvedValue(undefined);
    const advance = vi.spyOn(h, 'advanceAfterFailure');
    vi.mocked(api.prepare).mockRejectedValueOnce(unreachable());
    vi.useFakeTimers();
    try {
      await controller.startAt(1, 0);
      expect(controller.state.queue.map((e) => e.trackId)).toEqual(['a', 'b', 'c']);
      expect(controller.state.index).toBe(1);
      expect(controller.state.status).toBe('buffering');
      controller.pause();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(controller.state.status).toBe('paused');
      expect(vi.mocked(api.prepare)).toHaveBeenCalledTimes(1);
      expect(advance).not.toHaveBeenCalled();
    } finally {
      if (h.saveTimer) clearTimeout(h.saveTimer);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

describe('continuous wave reservoir', () => {
  function waveSetup(realPreparation = false) {
    const env = setup();
    const { controller, h, tracks } = env;
    for (const id of ['d','e','f','g','h','i','j']) tracks.set(id, { id, title: id, duration: 180, reaction: 0, status: 'ok', analysis: {} } as Track);
    controller.state = { ...controller.state, context: { type: 'yandex-wave', label: 'Яндекс' },
      queue: controller.state.queue.map((entry, i) => ({ ...entry, origin: 'yandex', yandexId: `${100 + i}:10`, yandexSessionId: 'session-old', yandexBatchId: 'batch-old' })) };
    const w = controller as unknown as {
      topUpWave(): Promise<void>; waveEpoch: number; waveRetryAt: number; generation: number;
      waveRetryTimer: ReturnType<typeof setTimeout> | null;
      yandexSession: { sessionId: string; batchId: string | null } | null;
      beginPlay(entry: QueueEntry): void; finishPlay(reason: string): void;
      playId: number | null;
      radioPlay: { seconds: number; tick: number } | null;
    };
    w.yandexSession = { sessionId: 'session-old', batchId: 'batch-old' };
    if (!realPreparation) h.prepareNext = vi.fn().mockResolvedValue(undefined);
    cleanups.push(() => { if (h.saveTimer) clearTimeout(h.saveTimer); if (w.waveRetryTimer) clearTimeout(w.waveRetryTimer); });
    return { ...env, w };
  }
  const batch = (ids: string[], tag = 'new') => ({ sessionId: 'session-old', batchId: tag,
    items: ids.map((id, i) => ({ trackId: id, yandexId: `${200 + i}:10`, title: id, artist: 'Artist' })) });

  it('fills ahead immediately and sends received IDs without waiting for batch completion', async () => {
    const { controller, w } = waveSetup();
    vi.mocked(api.yandexWave).mockResolvedValueOnce(batch(['d','e','f','g']));
    await w.topUpWave();
    expect(api.yandexWave).toHaveBeenCalledTimes(1);
    expect(api.yandexWave).toHaveBeenCalledWith('session-old', { queue: ['100:10','101:10','102:10'], count: 4 });
    expect(controller.state.queue.slice(3).map(e => e.trackId)).toEqual(['d','e','f','g']);
    expect(controller.state.queue[3].yandexBatchId).toBe('new');
    expect(api.focus).toHaveBeenCalled();
  });

  it('does not block planning the immediate pair on recommendation downloads', async () => {
    const { h, w } = waveSetup(true);
    const slow = deferred<ReturnType<typeof batch>>();
    vi.mocked(api.yandexWave).mockReturnValueOnce(slow.promise);
    const preparing = h.prepareNext();
    await vi.waitFor(() => expect(api.plan).toHaveBeenCalledWith('a','b'));
    await vi.waitFor(() => expect(h.next?.entry.trackId).toBe('b'));
    slow.resolve(batch(['d','e','f','g']));
    await preparing;
    await w.topUpWave();
  });

  it('coalesces requests and accepts results across a manual track generation change', async () => {
    const { controller, w } = waveSetup();
    const slow = deferred<ReturnType<typeof batch>>();
    vi.mocked(api.yandexWave).mockReturnValueOnce(slow.promise);
    const first = w.topUpWave();
    expect(w.topUpWave()).toBe(first);
    w.generation++;
    controller.state = { ...controller.state, index: 1 };
    slow.resolve(batch(['d','e','f','g']));
    await first;
    expect(controller.state.queue.map(e=>e.trackId)).toContain('d');
    expect(api.yandexWave).toHaveBeenCalledTimes(1);
  });

  it('rejects responses after leaving the wave and releases the loading state', async () => {
    const { controller, w } = waveSetup();
    const slow = deferred<ReturnType<typeof batch>>();
    vi.mocked(api.yandexWave).mockReturnValueOnce(slow.promise);
    const request = w.topUpWave();
    controller.state = { ...controller.state, context: { type: 'library', label: 'Library' } };
    slow.resolve(batch(['d','e','f','g']));
    await request;
    expect(controller.state.queue).toHaveLength(3);
    expect(controller.state.waveLoading).toBe(false);
  });

  it('filters duplicates within/across responses, album aliases and disliked tracks', async () => {
    const { controller, tracks, w } = waveSetup();
    tracks.set('e', { ...tracks.get('e')!, reaction: -1 });
    const response = batch(['b','d','d','e','f','g']);
    response.items[4].yandexId = '101:99';
    vi.mocked(api.yandexWave).mockResolvedValue(response);
    await w.topUpWave();
    expect(controller.state.queue.map(e=>e.trackId)).toEqual(['a','b','c','d','g']);
    expect(api.yandexWave).toHaveBeenCalledTimes(1);
  });

  it('backs off on failure, keeps existing music, and never silently substitutes local recommendations', async () => {
    const { controller, w } = waveSetup();
    vi.mocked(api.yandexWave).mockRejectedValueOnce(new Error('offline'));
    await w.topUpWave();
    await w.topUpWave();
    expect(api.yandexWave).toHaveBeenCalledTimes(1);
    expect(api.waveNext).not.toHaveBeenCalled();
    expect(controller.state.queue).toHaveLength(3);
    expect(controller.state.waveRefillError).toBeTruthy();
    expect(controller.state.waveLoading).toBe(false);
    expect(w.waveRetryAt).toBeGreaterThan(Date.now());
  });

  it('bounds duplicate-only responses and does not spin on an empty reservoir', async () => {
    const { w } = waveSetup();
    vi.mocked(api.yandexWave).mockResolvedValue({ sessionId: 'session-old', batchId:'x', items: [] });
    await w.topUpWave();
    expect(api.yandexWave).toHaveBeenCalledTimes(1);
    expect(w.waveRetryTimer).not.toBeNull();
  });

  it('replenishes and resumes when the last playable wave entry fails', async () => {
    const { controller, h } = waveSetup();
    controller.state = {...controller.state,queue:controller.state.queue.slice(0,1)};
    vi.mocked(api.yandexWave).mockResolvedValueOnce(batch(['d','e','f','g']));
    const start = vi.spyOn(controller,'startAt').mockResolvedValue(undefined);
    await h.advanceAfterFailure();
    await vi.waitFor(() => expect(start).toHaveBeenCalledWith(0,0,'finished'));
    expect(controller.state.queue.map(e=>e.trackId)).toEqual(['d','e','f','g']);
  });

  it('manual Next replenishes an exhausted wave instead of doing nothing', async () => {
    const { controller, h } = waveSetup(true);
    controller.state = {...controller.state, queue:controller.state.queue.slice(0,1)};
    controller.instantNext = true;
    vi.mocked(api.yandexWave).mockResolvedValueOnce(batch(['d','e','f','g']));
    await controller.nextTrack();
    await vi.waitFor(() => expect(h.next?.entry.trackId).toBe('d'));
    expect(api.yandexWave).toHaveBeenCalledTimes(1);
  });

  it('keeps retrying after the last track ends and automatically starts the new reserve', async () => {
    vi.useFakeTimers();
    const { controller, h, slot, w } = waveSetup();
    controller.state = { ...controller.state, queue: controller.state.queue.slice(0,1) };
    w.waveRetryAt = Date.now() + 1000;
    vi.mocked(api.yandexWave).mockResolvedValueOnce(batch(['d','e','f','g']));
    const start = vi.spyOn(controller, 'startAt').mockResolvedValue(undefined);
    try {
      h.onEngine({type:'ended',deck:0,token:slot.token} as MixerEvent);
      expect(controller.state.status).toBe('buffering');
      expect(api.yandexWave).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1001);
      expect(api.yandexWave).toHaveBeenCalledTimes(1);
      expect(start).toHaveBeenCalledWith(1,0,'finished');
    } finally {
      if (w.waveRetryTimer) clearTimeout(w.waveRetryTimer);
      if (h.saveTimer) clearTimeout(h.saveTimer);
      vi.useRealTimers();
    }
  });

  it('finishes the old radio entry after another context has already replaced the queue', () => {
    const { controller, w } = waveSetup();
    controller.state = {...controller.state,queue:[...controller.state.queue,...['d','e','f'].map(id=>({entryId:id,trackId:id,origin:'wave' as const}))]};
    w.beginPlay(controller.state.queue[0]);
    controller.state = {...controller.state,queue:[{entryId:'replacement',trackId:'d',origin:'user'}],index:0,context:{type:'library',label:'Library'}};
    w.finishPlay('skip');
    expect(api.yandexFeedback).toHaveBeenLastCalledWith('session-old','batch-old',expect.objectContaining({trackId:'100:10',type:'skip'}));
  });

  it('uses per-entry feedback attribution even after a new batch and history failure', async () => {
    const { controller, w } = waveSetup();
    // A full reservoir avoids unrelated network work during beginPlay.
    controller.state = { ...controller.state, queue: [...controller.state.queue, ...['d','e','f','g'].map(id=>({entryId:id,trackId:id,origin:'wave' as const}))] };
    vi.mocked(api.startPlay).mockRejectedValueOnce(new Error('history unavailable'));
    w.beginPlay(controller.state.queue[0]);
    w.yandexSession = { sessionId:'replacement', batchId:'newest' };
    if (w.radioPlay) w.radioPlay.seconds = 12;
    w.playId = null;
    w.finishPlay('skip');
    w.finishPlay('skip');
    expect(api.yandexFeedback).toHaveBeenCalledTimes(2);
    expect(api.yandexFeedback).toHaveBeenLastCalledWith('session-old','batch-old', {type:'skip',trackId:'100:10',totalPlayedSeconds:12});
  });

  it('does not attach delayed history to a replay of the same queue entry', async () => {
    const { controller, w } = waveSetup();
    const slow = deferred<{ id: number }>();
    vi.mocked(api.startPlay).mockReturnValueOnce(slow.promise).mockResolvedValueOnce({ id: 22 });
    w.beginPlay(controller.state.queue[0]);
    w.finishPlay('skip');
    w.beginPlay(controller.state.queue[0]);
    await Promise.resolve();
    slow.resolve({ id: 11 });
    await Promise.resolve();
    expect(w.playId).toBe(22);
    expect(api.endPlay).toHaveBeenCalledWith(11, 0, 'skip');
  });

  it('applies provider settings to a fresh session while preserving paused audio, the prepared pair and manual entries', async () => {
    const { controller, h, w, slot } = waveSetup();
    const incoming = { ...slot, deck: 1, token: 'b-token', trackId: 'b', entryId: 'b-entry' };
    h.next = { slot: incoming, entry: controller.state.queue[1], plan: pair('b').plan, pending: [] };
    controller.state = { ...controller.state, status: 'paused', queue: [...controller.state.queue,
      { entryId: 'manual', trackId: 'h', origin: 'user' }] };
    vi.mocked(api.yandexWave).mockResolvedValueOnce(batch(['d','e','f','g']));
    const start = vi.spyOn(controller, 'startAt').mockResolvedValue(undefined);
    await controller.refreshYandexWave();
    expect(api.yandexWave).toHaveBeenCalledWith(null, { queue: ['100:10','101:10'], count: 4 });
    expect(controller.state.queue.map(e => e.trackId)).toEqual(['a','b','h','d','e','f','g']);
    expect(h.current).toBe(slot);
    expect(h.next?.slot).toBe(incoming);
    expect(controller.state.status).toBe('paused');
    expect(start).not.toHaveBeenCalled();
    expect(w.yandexSession?.batchId).toBe('new');
  });

  it('discards a previous refill response after provider settings change', async () => {
    const { controller, w } = waveSetup();
    const old = deferred<ReturnType<typeof batch>>();
    vi.mocked(api.yandexWave).mockReturnValueOnce(old.promise).mockResolvedValueOnce(batch(['e','f','g','h']));
    const previous = w.topUpWave();
    await controller.refreshYandexWave();
    old.resolve(batch(['d'], 'stale'));
    await previous;
    expect(controller.state.queue.map(e => e.trackId)).not.toContain('d');
    expect(controller.state.queue.some(e => e.yandexBatchId === 'stale')).toBe(false);
  });
});

describe('queue-end continuation', () => {
  it('waits for the chosen station instead of stopping and starts it as the last song ends', () => {
    const { controller, h, slot } = setup();
    controller.state = { ...controller.state, context: { type: 'playlist', label: 'Летний' }, queue: controller.state.queue.slice(0, 1) };
    const start = vi.spyOn(controller, 'startAt').mockResolvedValue(undefined);
    cleanups.push(() => { if (h.saveTimer) clearTimeout(h.saveTimer); });
    controller.holdQueueEnd('Радио по мотивам «Летний»');
    h.onEngine({ type: 'ended', deck: 0, token: slot.token });
    expect(controller.state.status).toBe('buffering');
    controller.continueAs({ type: 'online-radio', label: 'Радио по мотивам «Летний»' });
    expect(controller.state).toMatchObject({ status: 'buffering', continuation: null, context: { type: 'online-radio' } });
    controller.addToQueue(['b']);
    expect(start).toHaveBeenCalledWith(1, 0, 'finished');
  });
  it('appends a local wave without cutting the playing song and prepares the usual transition', async () => {
    const { controller, h } = setup();
    controller.state = { ...controller.state, context: { type: 'album', label: 'Альбом' }, queue: controller.state.queue.slice(0, 1) };
    vi.mocked(api.waveNext).mockResolvedValue({ picks: [] });
    const start = vi.spyOn(controller, 'startAt');
    cleanups.push(() => { if (h.saveTimer) clearTimeout(h.saveTimer); });
    controller.continueAs({ type: 'wave', label: 'Моя волна' }, ['b', 'c'], 'wave');
    expect(controller.state.queue.map((e) => [e.trackId, e.origin])).toEqual([['a', 'user'], ['b', 'wave'], ['c', 'wave']]);
    expect(controller.state.index).toBe(0);
    expect(start).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(api.plan).toHaveBeenCalledWith('a', 'b'));
  });
  it('stops for real when no continuation was found', () => {
    const { controller, h, slot } = setup();
    controller.state = { ...controller.state, context: { type: 'playlist', label: 'Летний' }, queue: controller.state.queue.slice(0, 1) };
    cleanups.push(() => { if (h.saveTimer) clearTimeout(h.saveTimer); });
    controller.holdQueueEnd('Радио');
    h.onEngine({ type: 'ended', deck: 0, token: slot.token });
    controller.holdQueueEnd(null);
    expect(controller.state.status).toBe('idle');
    // without a pending station the end of a finite queue stops as before
    const fresh = setup();
    fresh.controller.state = { ...fresh.controller.state, context: { type: 'playlist', label: 'Летний' }, queue: fresh.controller.state.queue.slice(0, 1) };
    cleanups.push(() => { if (fresh.h.saveTimer) clearTimeout(fresh.h.saveTimer); });
    fresh.h.onEngine({ type: 'ended', deck: 0, token: fresh.slot.token });
    expect(fresh.controller.state.status).toBe('idle');
  });
  it('lets another station take over from the next song without cutting the playing one', () => {
    const { controller, h } = setup();
    controller.state = { ...controller.state, context: { type: 'wave', label: 'Моя волна' } };
    const start = vi.spyOn(controller, 'startAt');
    cleanups.push(() => { if (h.saveTimer) clearTimeout(h.saveTimer); });
    controller.continueAs({ type: 'online-radio', label: 'Радио' }, ['c'], 'context', true);
    expect(controller.state.queue.map((e) => e.trackId)).toEqual(['a', 'c']);
    expect(controller.state).toMatchObject({ index: 0, context: { type: 'online-radio' } });
    expect(h.current.trackId).toBe('a');
    expect(start).not.toHaveBeenCalled();
  });
  it('remembers songs that played through, not skipped ones', () => {
    const { controller } = setup();
    const play = controller as unknown as { finishPlay(reason: string): void };
    play.finishPlay('skip');
    expect(controller.heard.has('a-entry')).toBe(false);
    play.finishPlay('transition');
    expect(controller.heard.has('a-entry')).toBe(true);
  });
});
