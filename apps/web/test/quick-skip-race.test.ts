import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_AUTOMIX_SETTINGS, planTransition, type MixerEvent, type TransitionPlan } from '@automix/core';
import { PlayerController } from '../src/audio/controller.ts';
import type { Track } from '../src/lib/api.ts';
vi.mock('../src/audio/engine.worklet.ts?worker&url', () => ({ default: '/engine.js' }));
vi.mock('../src/lib/api.ts', async original => ({ ...await original<typeof import('../src/lib/api.ts')>(), api: {
  focus: vi.fn(async () => {}), saveQueue: vi.fn(async () => {}), startPlay: vi.fn(async () => ({ id: 1 })), endPlay: vi.fn(async () => {}), logTransition: vi.fn(async () => ({ id: 1 })),
} }));
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('navigator', {}); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function setup() {
  const controller = new PlayerController(id => ({ id, title: id, duration: 180, status: 'ok', analysis: {} } as Track), vi.fn());
  const makeSlot = (deck: number, id: string) => ({ deck, token: id + '-token', entryId: id + '-entry', trackId: id, totalFrames: 180 * 48000,
    abort: new AbortController(), pending: [], inflight: 0, fed: new Set([0]), fetching: new Set(), failed: null,
    vocals: { pending: [], inflight: 0, fed: new Set(), fetching: new Set(), failed: null } });
  const cur = makeSlot(0, 'a'), incoming = makeSlot(1, 'b');
  const entries = ['a', 'b'].map(trackId => ({ trackId, entryId: trackId + '-entry', origin: 'user' as const }));
  const plan = planTransition({ id: 'a', duration: 180, mixingAllowed: true, analysis: null },
    { id: 'b', duration: 180, mixingAllowed: true, analysis: null }, DEFAULT_AUTOMIX_SETTINGS);
  const nx = { slot: incoming, entry: entries[1], index: 1, plan, pending: [] };
  const postMessage = vi.fn();
  const h = controller as unknown as { current: typeof cur; next: typeof nx; slots: typeof cur[]; node: unknown;
    prepareNext(): Promise<void>; bufferChangedCue(): Promise<[]>; armQuickSkip(cur: typeof cur, nx: typeof nx): Promise<void>;
    armRequestedPlan(cur: typeof cur, nx: typeof nx, plan: TransitionPlan): void; onEngine(event: MixerEvent): void };
  h.current = cur; h.next = nx; h.slots = [cur, incoming]; h.node = { port: { postMessage } };
  controller.state = { ...controller.state, queue: entries, index: 0, position: 10, duration: 180, status: 'playing' };
  vi.spyOn(h, 'prepareNext').mockResolvedValue();
  h.armRequestedPlan(cur, nx, plan); postMessage.mockClear();
  let release!: (value: []) => void;
  vi.spyOn(h, 'bufferChangedCue').mockImplementation(() => new Promise(resolve => { release = resolve; }));
  return { controller, h, cur, nx, plan, postMessage, release: () => release([]) };
}
it('does not replace a transition that starts while quick-skip PCM is loading', async () => {
  const { controller, h, cur, nx, plan, postMessage, release } = setup();
  const pending = h.armQuickSkip(cur, nx);
  h.onEngine({ type: 'transitionStart', planId: plan.id, late: false, clock: 0 });
  release(); await pending;
  expect(postMessage.mock.calls.filter(([command]) => command.cmd === 'arm')).toHaveLength(0);
  expect(nx.plan.id).toBe(plan.id);
  expect(controller.state.transition?.active).toBe(true);
});
it('does not rearm a buffered quick skip after Previous restarts the current track', async () => {
  const { controller, h, cur, nx, plan, postMessage, release } = setup();
  const pending = h.armQuickSkip(cur, nx);
  await controller.prevTrack();
  release(); await pending;
  expect(postMessage.mock.calls.map(([command]) => command)).toContainEqual({ cmd: 'seek', token: cur.token, frame: 0 });
  expect(postMessage.mock.calls.filter(([command]) => command.cmd === 'arm')).toHaveLength(0);
  expect(nx.plan.id).toBe(plan.id);
});
it('adopts the actual engine plan when a replacement arm raced an undelivered transitionStart', () => {
  const { controller, h, cur, nx, plan } = setup();
  // The engine already started plan; its start event is queued while arm(new) is ignored.
  h.armRequestedPlan(cur, nx, { ...plan, id: plan.id + '-replacement' });
  h.onEngine({ type: 'transitionStart', planId: plan.id, late: false, clock: 0 });
  h.onEngine({ type: 'swap', planId: plan.id, token: nx.slot.token });
  expect(controller.state.index).toBe(1);
  expect(h.current).toBe(nx.slot);
  expect(nx.plan.id).toBe(plan.id);
});

it('adopts a completed registered plan even when its start and swap events were delayed', () => {
  const { controller, h, cur, nx, plan } = setup();
  h.armRequestedPlan(cur, nx, { ...plan, id: plan.id + '-replacement' });
  h.onEngine({ type: 'transitionEnd', planId: plan.id, token: nx.slot.token, forced: false });
  expect(controller.state.index).toBe(1);
  expect(h.current).toBe(nx.slot);
  expect(h.next).toBeNull();
  expect(h.prepareNext).toHaveBeenCalledOnce();
});
it('recognizes the registered running plan from active telemetry before delayed lifecycle events', () => {
  const { controller, h, cur, nx, plan } = setup();
  h.armRequestedPlan(cur, nx, { ...plan, id: plan.id + '-replacement' });
  h.onEngine({ type: 'tick', clock: 0, paused: false, main: 0, decks: [cur, nx.slot].map(slot => ({ token: slot.token,
    position: 480000, totalFrames: slot.totalFrames, playing: true, starved: false, ratio: 1, bufferedAhead: 48000 })),
    transition: { planId: plan.id, active: true, late: false, t: 128 }, limiterDb: 0, peak: .1 });
  expect(nx.plan.id).toBe(plan.id);
  expect(controller.state.transition?.active).toBe(true);
  h.onEngine({ type: 'transitionEnd', planId: plan.id, token: nx.slot.token, forced: false });
  expect(controller.state.index).toBe(1);
  expect(h.next).toBeNull();
  expect(h.prepareNext).toHaveBeenCalledOnce();
});
