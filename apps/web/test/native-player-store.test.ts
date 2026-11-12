import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { NativePlaybackControls } from '../src/lib/playback-trace.ts';

vi.mock('../src/audio/engine.worklet.ts?worker&url', () => ({ default: '/engine.js' }));
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
async function store(phone: boolean, presentPlayer?: NativePlaybackControls['presentPlayer'], mixActive = true) {
  vi.stubGlobal('document', { hidden: false, documentElement: { classList: { contains: (name: string) => phone && name === 'mora-mobile' } }, addEventListener: vi.fn() });
  vi.stubGlobal('window', { moraNativePlayback: { route: 'native', mixActive, setRoute: async () => {}, presentPlayer }, addEventListener: vi.fn() });
  return (await import('../src/store/app.ts')).useApp;
}
beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.unstubAllGlobals(); });

it('opens the native player from the phone store without mounting the web overlay', async () => {
  const present = vi.fn(async () => ({ action: 'close' as const }));
  const app = await store(true, present);
  app.getState().setFullPlayer(true);
  expect(app.getState().fullPlayer).toBe(false);
  await settle();
  expect(present).toHaveBeenCalledOnce();
  expect(app.getState().fullPlayer).toBe(false);
  app.getState().setFullPlayer(false);
  expect(present).toHaveBeenCalledOnce();
});

it('opens the web overlay after the native player asks for «Ещё», and closes it normally', async () => {
  const present = vi.fn(async () => ({ action: 'more' as const }));
  const app = await store(true, present);
  app.getState().setFullPlayer(true);
  await settle();
  expect(app.getState().fullPlayer).toBe(true);
  app.getState().setFullPlayer(false);
  expect(app.getState().fullPlayer).toBe(false);
  expect(present).toHaveBeenCalledOnce();
});

it('keeps a usable web player when native presentation fails', async () => {
  const app = await store(true, async () => { throw Error('Cannot present'); });
  app.getState().setFullPlayer(true);
  await settle();
  expect(app.getState().fullPlayer).toBe(true);
});

it.each([{ phone: false, mixActive: true }, { phone: true, mixActive: false }])('keeps web/desktop playback unchanged: %j', async ({ phone, mixActive }) => {
  const present = vi.fn(async () => ({ action: 'close' as const }));
  const app = await store(phone, present, mixActive);
  app.getState().setFullPlayer(true);
  expect(app.getState().fullPlayer).toBe(true);
  await settle();
  expect(present).not.toHaveBeenCalled();
});

it('opens the web player on older phone bridges without native presentation', async () => {
  const app = await store(true);
  app.getState().setFullPlayer(true);
  expect(app.getState().fullPlayer).toBe(true);
});
