import { afterEach, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ listener: null as ((event: any) => void) | null,
  audioStart: vi.fn(async () => ({ sampleRate: 48000, queueFrames: 2048, engine: 'rust' })),
  audioCommand: vi.fn(async () => {}), audioStop: vi.fn(async () => {}),
}));
vi.mock('../src/lib/desktop.ts', () => ({ desktop: { ...native, onAudio: (cb: (event: any) => void) => { native.listener = cb; return () => { native.listener = null; }; } } }));
vi.mock('../src/audio/engine.worklet.ts?worker&url', () => ({ default: '/engine.js' }));
vi.mock('../src/lib/api.ts', async original => ({ ...await original<typeof import('../src/lib/api.ts')>(), api: { saveQueue: vi.fn(async () => {}), focus: vi.fn(async () => {}) } }));
import { PlayerController } from '../src/audio/controller.ts';

afterEach(() => { vi.useRealTimers();vi.clearAllMocks(); });
it('reloads PCM at the saved position after a native engine failure instead of resuming empty decks', async () => {
  vi.useFakeTimers();
  const c = new PlayerController(() => undefined, vi.fn());
  const h = c as unknown as { ensureEngine(): Promise<void>; current: any; slots: any[]; ctx: any; node: any };
  await h.ensureEngine();
  expect(native.audioStart).toHaveBeenCalledWith('');
  const abort = new AbortController();
  h.current = { deck: 0, token: 'T0', abort };h.slots = [h.current, null];
  c.state = { ...c.state, status: 'playing', index: 0, position: 17, queue: [{ trackId: 'a', entryId: 'a1', origin: 'user' }] };
  native.listener!({ type: 'fatal', error: 'device lost' });
  expect(abort.signal.aborted).toBe(true);
  expect(h.current).toBeNull();expect(h.node).toBeNull();expect(h.ctx).toBeNull();
  expect(c.state.status).toBe('paused');expect(c.state.engineReady).toBe(false);
  expect(native.audioStop).toHaveBeenCalledOnce();
  const restart = vi.spyOn(c, 'startAt').mockResolvedValue();
  await c.resume();
  expect(restart).toHaveBeenCalledWith(0, 17);
});

it('keeps desktop playback on the original recordings even for a cached vocal plan', async () => {
  const c = new PlayerController(() => undefined, vi.fn());
  const h = c as unknown as { bufferVocals(cur: any, next: any, plan: any): Promise<any>; readChunks: any; startupChunks: any };
  const cur = { token: 'A' }, next = { token: 'B' };
  const A = [{ chunk: 0, L: new Float32Array([.1]), R: new Float32Array([.2]) }];
  const B = [{ chunk: 0, L: new Float32Array([.3]), R: new Float32Array([.4]) }];
  const read = vi.spyOn(h, 'readChunks').mockImplementation(async slot => slot === cur ? A : B);
  vi.spyOn(h, 'startupChunks').mockReturnValue([0]);
  const plan = { duration: 2, aExit: 10, bEntry: 3, reasons: [], debug: {}, vocalA: [[0, 1], [1, 0]],
    vocalB: [[0, 0], [1, 1]], voiceEcho: { delay: .25, feedback: .4 }, automation: [] };
  const result = await h.bufferVocals(cur, next, plan);
  expect(result.A).toEqual([]);expect(result.B).toEqual([]);
  expect(result.plan.vocalA).toBeUndefined();expect(result.plan.vocalB).toBeUndefined();expect(result.plan.voiceEcho).toBeUndefined();
  expect(read).not.toHaveBeenCalled();expect(plan.vocalA).toBeDefined();
});

it('removes voice echo lanes from legacy desktop plans without requesting vocal PCM', async () => {
  const c = new PlayerController(() => undefined, vi.fn());
  const h = c as unknown as { bufferVocals(cur: any, next: any, plan: any): Promise<any>; readChunks: any; startupChunks: any };
  const read = vi.spyOn(h, 'readChunks').mockRejectedValue(new Error('missing stem'));
  vi.spyOn(h, 'startupChunks').mockReturnValue([0]);
  const plan = { duration: 2, reasons: ['вокальная подводка'], debug: {}, vocalA: [[0, 1], [1, 0]], vocalB: [[0, 0], [1, 1]],
    voiceEcho: { delay: .25, feedback: .4 }, automation: [{ deck: 'A', lane: 'gain', points: [[0, 1], [2, 0]] }, { deck: 'A', lane: 'voiceEcho', points: [[0, .2]] }] };
  const result = await h.bufferVocals(null, null, plan);
  expect(result.A).toEqual([]);expect(result.B).toEqual([]);
  expect(result.plan.vocalA).toBeUndefined();expect(result.plan.vocalB).toBeUndefined();expect(result.plan.voiceEcho).toBeUndefined();
  expect(result.plan.automation.every((lane: any) => lane.lane !== 'voiceEcho')).toBe(true);
  expect(read).not.toHaveBeenCalled();
  expect(plan.vocalA).toBeDefined();
});
